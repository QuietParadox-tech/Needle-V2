(() => {
'use strict';

/* =====================================================================
   NEEDLE — Spotify vinyl player
   Auth: Authorization Code + PKCE (no client secret, no backend).
   Scopes: playback state/control, playlist read, streaming (in-browser player).
   ===================================================================== */

const CFG = Object.assign({ CLIENT_ID: '', POLL_PLAYING_MS: 3000, POLL_PAUSED_MS: 6000 }, window.NEEDLE_CONFIG || {});
const NEED = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private', 'playlist-read-collaborative', 'streaming', 'user-read-email', 'user-read-private'];
const SCOPES = NEED.join(' ');
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const K = { tokens: 'needle.tokens', verifier: 'needle.verifier', state: 'needle.state', cid: 'needle.clientId', ambient: 'needle.ambient' };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class AuthError extends Error {}

/* ---------- state ---------- */
const S = {
  demo: false,
  trackId: null,
  isPlaying: false,
  progress: 0,
  duration: 0,
  syncedAt: 0,
  device: null,
  lifted: false,        // tonearm lifted during a record change
  backoffUntil: 0,
  seq: 0,               // track-change sequence (cancels stale transitions)
  bgOn: 'B',
  artOn: 'B',
};
let pollTimer = null;
let polling = false;
let wakeLock = null;

/* ---------- config helpers ---------- */
function clientId() { return (CFG.CLIENT_ID || store.get(K.cid) || '').trim(); }
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

/* ---------- PKCE ---------- */
function rand(n) {
  const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => cs[x % cs.length]).join('');
}
async function challengeOf(v) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function login() {
  if (!(window.crypto && crypto.subtle)) {
    return showGate({ error: 'This browser context cannot do secure login. Open NEEDLE over HTTPS (or http://127.0.0.1).' });
  }
  const cid = clientId();
  if (!cid) return showGate({});
  const verifier = rand(64), state = rand(16);
  store.set(K.verifier, verifier); store.set(K.state, state);
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    response_type: 'code', client_id: cid, scope: SCOPES, redirect_uri: redirectUri(),
    state, code_challenge_method: 'S256', code_challenge: await challengeOf(verifier),
  }).toString();
  location.assign(url.toString());
}
async function handleCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState({}, document.title, redirectUri());
  if (q.get('error')) throw new Error(q.get('error') === 'access_denied' ? 'Spotify access was not granted.' : 'Spotify login error: ' + q.get('error'));
  if (!q.get('state') || q.get('state') !== store.get(K.state)) throw new Error('Login could not be verified (state mismatch). Please try again.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(), grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: store.get(K.verifier) || '',
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + await errText(res));
  saveTokens(await res.json());
  store.del(K.verifier); store.del(K.state);
  return true;
}
async function errText(res) {
  try { const j = await res.json(); return j.error_description || j.error?.message || j.error || res.status; } catch { return res.status; }
}

/* ---------- tokens ---------- */
function tokens() { try { return JSON.parse(store.get(K.tokens) || 'null'); } catch { return null; } }
function saveTokens(j, oldRefresh) {
  const prev = tokens();
  store.set(K.tokens, JSON.stringify({
    access_token: j.access_token,
    refresh_token: j.refresh_token || oldRefresh,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || (prev && prev.scope) || '',
  }));
}
function hasScopes() {
  const t = tokens(); if (!t) return false;
  const have = (t.scope || '').split(/\s+/);
  return NEED.every((x) => have.includes(x));
}
let refreshing = null;
function refreshTokens() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = tokens();
    if (!t || !t.refresh_token) throw new AuthError('Not connected.');
    const res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId() }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) { store.del(K.tokens); throw new AuthError('Your Spotify session ended. Please reconnect.'); }
      throw new Error('Token refresh failed (' + res.status + ')');
    }
    saveTokens(await res.json(), t.refresh_token);
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function getToken() {
  const t = tokens();
  if (!t) throw new AuthError('Not connected.');
  if (Date.now() > t.expires_at - 60000) await refreshTokens();
  return tokens().access_token;
}

/* ---------- API ---------- */
async function api(method, path, { query, body } = {}, retry = true) {
  const token = await getToken();
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) { await refreshTokens(); return api(method, path, { query, body }, false); }
  let data = null;
  if (res.status !== 204) {
    const txt = await res.text();
    if (txt) { try { data = JSON.parse(txt); } catch { /* non-JSON body */ } }
  }
  if (res.status === 429) S.backoffUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 5) * 1000;
  return { ok: res.ok, status: res.status, data };
}
function explain(r) {
  const msg = (r.data && r.data.error && r.data.error.message) || '';
  const reason = (r.data && r.data.error && r.data.error.reason) || '';
  if (r.status === 403) {
    if (reason === 'PREMIUM_REQUIRED') return 'Spotify Premium is required to control playback.';
    if (/not registered|developer\.spotify\.com/i.test(msg)) return 'This Spotify account is not on the app’s allowed-users list. Add it in the Spotify Dashboard → your app → User Management.';
    return 'Spotify declined this action' + (msg ? ': ' + msg : '.') + ' (Some actions are blocked during ads or on certain devices.)';
  }
  if (r.status === 404) return 'No active Spotify device. Open Spotify somewhere and press play, or choose a device.';
  if (r.status === 429) return 'Spotify is rate-limiting requests. NEEDLE will retry shortly.';
  if (r.status === 401) return 'Spotify session expired. Please reconnect.';
  return 'Spotify error ' + r.status + (msg ? ': ' + msg : '');
}

/* =====================================================================
   Polling & player state
   ===================================================================== */
function schedule(ms) {
  clearTimeout(pollTimer);
  if (document.hidden || S.demo || !tokens()) return;
  let wait = ms;
  if (S.isPlaying && S.duration) {          // catch track changes promptly
    const remain = S.duration - curProgress();
    if (remain > 0 && remain + 400 < wait) wait = Math.max(800, remain + 400);
  }
  pollTimer = setTimeout(poll, Math.max(wait, S.backoffUntil - Date.now()));
}
async function poll() {
  if (polling || S.demo) return;
  polling = true;
  try {
    const r = await api('GET', '/me/player', { query: { additional_types: 'episode' } });
    if (r.status === 204 || (r.ok && !r.data)) setIdle();
    else if (r.ok) { hideNotice(); applyPlayer(r.data); }
    else if (r.status === 403 || r.status === 401) { showGate({ error: explain(r), keepTokens: r.status === 403 }); return; }
    else if (r.status !== 429) showNotice(explain(r));
  } catch (e) {
    if (e instanceof AuthError) { showGate({ error: e.message }); return; }
    showNotice('Can’t reach Spotify right now. Retrying…');
  } finally {
    polling = false;
    schedule(S.isPlaying ? CFG.POLL_PLAYING_MS : CFG.POLL_PAUSED_MS);
  }
}
function normalize(it) {
  const ep = it.type === 'episode';
  const imgs = (ep ? (it.images && it.images.length ? it.images : (it.show && it.show.images)) : (it.album && it.album.images)) || [];
  const sorted = imgs.filter(Boolean).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  const art = (sorted.find((i) => (i.width || 0) >= 600 && (i.width || 0) <= 1000) || sorted[0] || {}).url || null;
  return {
    id: it.id || it.uri || it.name,
    title: it.name || 'Unknown',
    artists: ep ? ((it.show && it.show.name) || '') : (it.artists || []).map((a) => a.name).join(', '),
    album: ep ? ((it.show && it.show.publisher) || '') : ((it.album && it.album.name) || ''),
    art, duration: it.duration_ms || 0,
  };
}
function applyPlayer(p) {
  if (!p.item) return setIdle();
  const t = normalize(p.item);
  S.device = p.device || null;
  S.isPlaying = !!p.is_playing;
  S.progress = p.progress_ms || 0;
  S.duration = t.duration;
  S.syncedAt = performance.now();
  if (t.id !== S.trackId) changeTrack(t);
  renderPlaying();
}
function setIdle() {
  S.isPlaying = false; S.syncedAt = performance.now();
  renderPlaying();
  showNotice('Nothing is playing. Pick something from your library to start a record.', [
    { label: 'Open library', fn: openLibrary },
    { label: 'Choose device', fn: openDevices },
  ]);
  if (!S.trackId) { setLabel({ title: 'NEEDLE', artists: 'Nothing playing', album: '' }); setBackground(null); }
}
function curProgress() {
  if (!S.isPlaying) return S.progress;
  return Math.min(S.duration || Infinity, S.progress + (performance.now() - S.syncedAt));
}

/* =====================================================================
   Rendering
   ===================================================================== */
function renderPlaying() {
  document.body.classList.toggle('playing', S.isPlaying);
  $('deviceCap').textContent = S.demo ? 'DEMO MODE · not connected to Spotify'
    : S.device ? 'On ' + S.device.name : '';
  renderArm(); tick(true); updateWakeLock();
}
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let tickN = 0;
function tick(force) {
  const p = curProgress(), d = S.duration;
  $('fill').style.transform = 'scaleX(' + (d ? Math.min(1, p / d) : 0) + ')';
  $('tCur').textContent = fmt(p); $('tDur').textContent = fmt(d);
  $('bar').setAttribute('aria-valuenow', String(d ? Math.round(p / d * 100) : 0));
  if (force || ++tickN % 10 === 0) renderArm();
}
function armRange() { return matchMedia('(orientation: portrait)').matches ? [18, 26] : [23, 31]; }
function renderArm() {
  const [a, b] = armRange();
  const frac = S.duration ? Math.min(1, curProgress() / S.duration) : 0;
  const ang = (S.isPlaying && !S.lifted) ? a + (b - a) * frac : 0;
  $('stage').style.setProperty('--arm-angle', ang.toFixed(2) + 'deg');
}

/* ---------- label ---------- */
function setLabel(t) {
  const title = t.title || '', len = title.length;
  const size = len <= 9 ? 14 : len <= 16 ? 11.5 : len <= 26 ? 9.2 : 7.4;
  const el = $('lTitle'); el.textContent = title; el.parentElement.style.fontSize = size + 'cqw';
  $('lArtist').textContent = t.artists || '';
  const alb = (t.album || '').toUpperCase();
  $('ringAlbum').textContent = alb.length > 30 ? alb.slice(0, 29) + '…' : alb;
  document.title = t.title && t.artists ? t.title + ' — ' + t.artists : 'NEEDLE';
}

/* ---------- artwork & colour ---------- */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => resolve({ img: i, cors: true });
    i.onerror = () => {                       // retry without CORS: still displayable, no colour sampling
      const j = new Image(); j.onload = () => resolve({ img: j, cors: false }); j.onerror = reject; j.src = url;
    };
    i.src = url;
  });
}
function setSleeve(url, cors) {
  const A = $('artA'), B = $('artB');
  const next = S.artOn === 'A' ? B : A, prev = S.artOn === 'A' ? A : B;
  if (!url) { A.classList.remove('show'); B.classList.remove('show'); return; }
  if (cors) next.crossOrigin = 'anonymous'; else next.removeAttribute('crossorigin');
  next.src = url; next.classList.add('show'); prev.classList.remove('show');
  S.artOn = S.artOn === 'A' ? 'B' : 'A';
}
const DEFAULT_PAL = { cols: [[190, 150, 108], [132, 84, 48], [84, 52, 32], [150, 92, 46]], D: [42, 27, 18] };
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function tone(c) {                       // keep the cover's hue, but keep UI text legible
  const m = (c[0] + c[1] + c[2]) / 3;
  c = c.map((v) => Math.max(0, Math.min(255, m + (v - m) * 1.12)));   // slight saturation lift
  const l = lum(c) || 1;
  if (l < 34) return c.map((v) => Math.min(255, v * 34 / l));
  if (l > 196) return c.map((v) => v * 196 / l);
  return c;
}
function paletteFrom(img) {
  try {
    const N = 32, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, N, N);
    const d = cx.getImageData(0, 0, N, N).data, bk = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const k = (d[i] >> 5) << 6 | (d[i + 1] >> 5) << 3 | (d[i + 2] >> 5);
      const e = bk.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; bk.set(k, e);
    }
    const ents = [...bk.values()].map((e) => {
      const c = [e.r / e.n, e.g / e.n, e.b / e.n], mx = Math.max(...c), mn = Math.min(...c);
      return { c, w: e.n * (0.35 + (mx ? (mx - mn) / mx : 0)) };
    }).sort((a, b) => b.w - a.w);
    const picked = [];
    for (const e of ents) { if (picked.every((p) => dist(p, e.c) > 60)) picked.push(e.c); if (picked.length === 4) break; }
    if (!picked.length) return DEFAULT_PAL;
    const base = picked[0];
    while (picked.length < 4) picked.push(picked.length % 2 ? mix(base, [0, 0, 0], 0.5) : mix(base, [255, 255, 255], 0.28));
    const cols = picked.map(tone).sort((a, b) => lum(b) - lum(a));
    return { cols, D: mix(cols[cols.length - 1], [0, 0, 0], 0.35) };
  } catch { return DEFAULT_PAL; }
}
function bgCss(p) {
  const c = (a, al = 1) => 'rgba(' + a.map(Math.round).join(',') + ',' + al + ')';
  const [c0, c1, c2, c3] = p.cols;
  return 'radial-gradient(65% 60% at 10% 6%,' + c(c0, .9) + ',transparent 72%),' +
    'radial-gradient(60% 60% at 94% 96%,' + c(c1, .85) + ',transparent 72%),' +
    'radial-gradient(45% 45% at 88% 8%,' + c(c3, .55) + ',transparent 75%),' +
    'linear-gradient(115deg,' + c(c0) + ' 0%,' + c(c1) + ' 38%,' + c(c2) + ' 72%,' + c(c3) + ' 100%)';
}
function setBackground(p) {
  p = p || DEFAULT_PAL;
  const A = $('bgA'), B = $('bgB'), next = S.bgOn === 'A' ? B : A, prev = S.bgOn === 'A' ? A : B;
  next.style.background = bgCss(p); next.classList.add('on'); prev.classList.remove('on');
  S.bgOn = S.bgOn === 'A' ? 'B' : 'A';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = 'rgb(' + p.D.map(Math.round).join(',') + ')';
}

/* ---------- track change: lift arm, slide record, swap, drop arm ---------- */
async function changeTrack(t) {
  const first = !S.trackId, my = ++S.seq;
  S.trackId = t.id;
  let loaded = null;
  if (t.art) { try { loaded = await loadImage(t.art); } catch { loaded = null; } }
  if (my !== S.seq) return;
  const stage = $('stage');
  if (!first) { stage.classList.add('changing'); S.lifted = true; renderArm(); await sleep(550); if (my !== S.seq) return; }
  setLabel(t);
  setSleeve(loaded ? t.art : null, loaded ? loaded.cors : false);
  setBackground(loaded && loaded.cors ? paletteFrom(loaded.img) : null);
  if (!first) {
    stage.classList.remove('changing');
    await sleep(900); if (my !== S.seq) return;
  }
  S.lifted = false; renderArm();
}

/* =====================================================================
   Controls (never pretend success: UI only changes after Spotify says OK)
   ===================================================================== */
async function control(kind) {
  if (S.demo) return demoControl(kind);
  const map = {
    play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'],
    next: ['POST', '/me/player/next'], prev: ['POST', '/me/player/previous'],
  };
  const [m, path] = map[kind];
  if (kind === 'play' && !(S.device && S.device.is_active)) return resumeSomewhere();
  try {
    const r = await api(m, path);
    if (r.ok) {
      if (kind === 'play' || kind === 'pause') {
        S.progress = curProgress(); S.syncedAt = performance.now(); S.isPlaying = kind === 'play'; renderPlaying();
      }
      hideNotice();
      setTimeout(poll, 600);
    } else {
      toast(explain(r), true);
      if (r.status === 404) showNotice(explain(r), [{ label: 'Choose device', fn: openDevices }]);
    }
  } catch (e) {
    if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true);
  }
}
async function seek(ms) {
  if (!S.duration) return;
  if (S.demo) { S.progress = ms; S.syncedAt = performance.now(); return tick(true); }
  try {
    const r = await api('PUT', '/me/player/seek', { query: { position_ms: ms } });
    if (r.ok) { S.progress = ms; S.syncedAt = performance.now(); tick(true); setTimeout(poll, 600); }
    else toast(explain(r), true);
  } catch { toast('Could not reach Spotify.', true); }
}

/* ---------- devices ---------- */
async function openDevices() {
  if (S.demo) return toast('Devices are not available in demo mode.');
  const modal = $('devicesModal'), list = $('deviceList');
  list.innerHTML = '<li class="empty">Looking for devices…</li>'; modal.hidden = false;
  try {
    const r = await api('GET', '/me/player/devices');
    if (!r.ok) { list.innerHTML = ''; return addEmpty(list, explain(r)); }
    const ds = (r.data && r.data.devices) || [];
    list.innerHTML = '';
    if (!ds.length) return addEmpty(list, 'No devices found. Open the Spotify app on your phone, iPad or computer (and play something briefly), then reopen this list.');
    for (const d of ds) {
      const li = document.createElement('li'); if (d.is_active) li.className = 'active';
      const b = document.createElement('button');
      b.innerHTML = '<span></span><small></small>';
      b.firstChild.textContent = d.name; b.lastChild.textContent = d.is_active ? 'active · ' + d.type : d.type;
      b.onclick = () => transfer(d);
      li.appendChild(b); list.appendChild(li);
    }
  } catch (e) { list.innerHTML = ''; addEmpty(list, e instanceof AuthError ? e.message : 'Could not load devices.'); }
}
function addEmpty(list, text) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; list.appendChild(li); }
async function transfer(d) {
  try {
    const r = await api('PUT', '/me/player', { body: { device_ids: [d.id], play: true } });
    if (r.ok) { $('devicesModal').hidden = true; hideNotice(); toast('Playing on ' + d.name); setTimeout(poll, 800); }
    else toast(explain(r), true);
  } catch { toast('Could not switch device.', true); }
}

/* =====================================================================
   UI helpers: notice, toast, gate, ambient, wake lock
   ===================================================================== */
function showNotice(text, actions) {
  $('noticeText').textContent = text;
  const box = $('noticeActions'); box.innerHTML = '';
  (actions || []).forEach((a) => { const b = document.createElement('button'); b.className = 'mini'; b.textContent = a.label; b.onclick = a.fn; box.appendChild(b); });
  $('notice').hidden = false;
}
function hideNotice() { $('notice').hidden = true; }
let toastT;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 4200);
}
function showGate({ error, keepTokens } = {}) {
  clearTimeout(pollTimer);
  if (!keepTokens && error) { /* tokens already cleared on auth failure */ }
  const needSetup = !clientId();
  $('setupBox').hidden = !needSetup;
  $('redirectUri').textContent = redirectUri();
  const warn = [];
  if (location.hostname === 'localhost') warn.push('Spotify no longer accepts “localhost”. Open this page at http://127.0.0.1:' + (location.port || '80') + '/ instead.');
  if (location.protocol === 'http:' && location.hostname !== '127.0.0.1') warn.push('Spotify requires HTTPS redirect URIs (only http://127.0.0.1 is allowed over HTTP).');
  const w = $('envWarn'); w.hidden = !warn.length; w.textContent = warn.join(' ');
  const e = $('gateError'); e.hidden = !error; e.textContent = error || '';
  $('btnConnect').textContent = tokens() ? 'Reconnect Spotify' : 'Connect Spotify';
  $('gate').classList.add('show');
}
function hideGate() { $('gate').classList.remove('show'); }

function setAmbient(on) {
  document.body.classList.toggle('ambient', on); document.body.classList.remove('peek');
  store.set(K.ambient, on ? '1' : '0');
}
let peekT;
function peek() {
  if (!document.body.classList.contains('ambient')) return;
  document.body.classList.add('peek'); clearTimeout(peekT);
  peekT = setTimeout(() => document.body.classList.remove('peek'), 3500);
}
async function updateWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    const want = S.isPlaying && !document.hidden;
    if (want && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed — ignore */ }
}
function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
}

/* =====================================================================
   Demo mode (?demo) — clearly labelled, no Spotify involved
   ===================================================================== */
function demoArt(h1, h2, v) {
  const shapes = v === 0
    ? "<circle cx='300' cy='300' r='190' fill='hsl(" + h1 + " 70% 70% / .35)'/><circle cx='300' cy='300' r='110' fill='hsl(" + h2 + " 60% 20% / .5)'/>"
    : v === 1
      ? "<rect x='90' y='330' width='420' height='180' fill='hsl(" + h2 + " 50% 15% / .55)'/><circle cx='300' cy='260' r='120' fill='hsl(" + h1 + " 80% 75% / .6)'/>"
      : "<path d='M0 420 Q150 300 300 400 T600 360 V600 H0Z' fill='hsl(" + h2 + " 50% 14% / .65)'/><circle cx='430' cy='170' r='70' fill='hsl(" + h1 + " 85% 78% / .7)'/>";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(" + h1 + " 60% 52%)'/><stop offset='1' stop-color='hsl(" + h2 + " 55% 24%)'/></linearGradient></defs><rect width='600' height='600' fill='url(#g)'/>" + shapes + '</svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
const DEMO = [
  { id: 'd1', title: 'Golden Hour Static', artists: 'The Velvet Meridian', album: 'Amber Rooms', art: demoArt(28, 12, 0), duration: 34000 },
  { id: 'd2', title: 'Slow Tide Letters', artists: 'Marlowe & Pine, Ines Calder', album: 'Paper Lanterns', art: demoArt(205, 250, 1), duration: 34000 },
  { id: 'd3', title: 'Needle Drop', artists: 'Odd Season Choir', album: 'Low Light Sessions', art: demoArt(340, 20, 2), duration: 34000 },
];
let demoIdx = 0;
function startDemo() {
  S.demo = true; hideGate(); hideNotice();
  demoLoad(0, true);
  setInterval(() => { if (S.demo && S.isPlaying && curProgress() >= S.duration - 50) demoControl('next'); }, 500);
}
function demoLoad(i, playing) {
  demoIdx = (i + DEMO.length) % DEMO.length;
  const t = DEMO[demoIdx];
  S.isPlaying = playing; S.progress = 0; S.duration = t.duration; S.syncedAt = performance.now(); S.device = null;
  if (t.id !== S.trackId) changeTrack(t);
  renderPlaying();
}
function demoControl(kind) {
  if (kind === 'play') { S.progress = curProgress(); S.syncedAt = performance.now(); S.isPlaying = true; renderPlaying(); }
  else if (kind === 'pause') { S.progress = curProgress(); S.syncedAt = performance.now(); S.isPlaying = false; renderPlaying(); }
  else demoLoad(demoIdx + (kind === 'next' ? 1 : -1), true);
}

/* =====================================================================
   In-browser player (Spotify Web Playback SDK)
   Lets NEEDLE itself be a Spotify device so nothing else has to be open.
   Best effort: Spotify only officially supports desktop browsers.
   ===================================================================== */
const sdk = { player: null, deviceId: null, state: 'off', err: '' };
function initSdk() {
  if (sdk.player || sdk.state === 'loading' || S.demo || !tokens()) return;
  if (!navigator.requestMediaKeySystemAccess) { sdk.state = 'unsupported'; return; }
  sdk.state = 'loading';
  window.onSpotifyWebPlaybackSDKReady = createSdkPlayer;
  if (window.Spotify) return createSdkPlayer();
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js'; s.async = true;
  s.onerror = () => { sdk.state = 'error'; sdk.err = 'Could not load Spotify’s player script.'; };
  document.head.appendChild(s);
}
function createSdkPlayer() {
  try {
    const p = new window.Spotify.Player({
      name: 'NEEDLE', volume: 0.8,
      getOAuthToken: (cb) => { getToken().then(cb).catch(() => {}); },
    });
    p.addListener('ready', ({ device_id }) => { sdk.deviceId = device_id; sdk.state = 'ready'; });
    p.addListener('not_ready', () => { sdk.deviceId = null; sdk.state = 'offline'; });
    ['initialization_error', 'authentication_error', 'account_error', 'playback_error'].forEach((ev) =>
      p.addListener(ev, ({ message }) => {
        sdk.err = message;
        if (ev === 'playback_error') toast('Browser player: ' + message, true);
        else { sdk.state = 'error'; sdk.deviceId = null; }
      }));
    sdk.player = p; p.connect();
  } catch (e) { sdk.state = 'error'; sdk.err = String((e && e.message) || e); }
}
function wakeSdk() { try { if (sdk.player && sdk.player.activateElement) sdk.player.activateElement(); } catch { /* ignore */ } }
function stopSdk() { try { if (sdk.player) sdk.player.disconnect(); } catch { /* ignore */ } sdk.player = null; sdk.deviceId = null; sdk.state = 'off'; }

/* Choose where to play: active device → this browser → any other listed device. */
async function pickDevice() {
  try {
    const r = await api('GET', '/me/player/devices');
    const ds = (r.ok && r.data && r.data.devices) || [];
    const active = ds.find((d) => d.is_active && !d.is_restricted);
    if (active) return { id: active.id, name: active.name, active: true };
    if (sdk.deviceId) return { id: sdk.deviceId, name: 'NEEDLE (this browser)', active: false };
    const any = ds.find((d) => !d.is_restricted);
    if (any) return { id: any.id, name: any.name, active: false };
    const why = sdk.state === 'error' ? ' NEEDLE’s built-in player could not start: ' + sdk.err
      : sdk.state === 'unsupported' ? ' This browser does not support NEEDLE’s built-in player.'
      : sdk.state === 'loading' ? ' NEEDLE’s built-in player is still starting — try again in a few seconds.' : '';
    showNotice('No Spotify device is available. Open Spotify once on a phone or computer (it only has to be running), then try again.' + why,
      [{ label: 'Choose device', fn: openDevices }]);
  } catch (e) {
    if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true);
  }
  return null;
}

async function startPlayback(body, opts = {}) {
  wakeSdk();
  const dev = await pickDevice();
  if (!dev) return false;
  try {
    if (!dev.active) {
      const t = await api('PUT', '/me/player', { body: { device_ids: [dev.id], play: false } });
      if (!t.ok) { toast(explain(t), true); return false; }
      await sleep(500);
    }
    if (opts.shuffle !== undefined) {
      const sr = await api('PUT', '/me/player/shuffle', { query: { state: !!opts.shuffle, device_id: dev.id } });
      if (!sr.ok) toast('Could not change shuffle: ' + explain(sr), true);
    }
    const r = await api('PUT', '/me/player/play', { query: { device_id: dev.id }, body });
    if (r.ok) {
      hideNotice(); closeLibrary(); toast('Playing on ' + dev.name);
      setTimeout(poll, 800); setTimeout(poll, 2500);
      return true;
    }
    toast(explain(r), true);
  } catch (e) {
    if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true);
  }
  return false;
}
async function resumeSomewhere() {
  wakeSdk();
  const dev = await pickDevice();
  if (!dev) return;
  try {
    const r = await api('PUT', '/me/player', { body: { device_ids: [dev.id], play: true } });
    if (r.ok) { hideNotice(); toast('Playing on ' + dev.name); setTimeout(poll, 800); setTimeout(poll, 2500); }
    else toast(explain(r) + ' If you have not played anything lately, choose something from the library.', true);
  } catch (e) {
    if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true);
  }
}

/* =====================================================================
   Library: browse your playlists and start them from NEEDLE
   ===================================================================== */
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const lib = { playlists: null, view: 'list', cur: null };
const plTotal = (p) => (p.items && typeof p.items.total === 'number') ? p.items.total : (p.tracks && typeof p.tracks.total === 'number') ? p.tracks.total : null;
const coverOf = (p) => (p.images && p.images[0] && p.images[0].url) || null;

function openLibrary() {
  if (S.demo) return toast('Connect Spotify to browse your playlists.');
  wakeSdk(); initSdk();
  $('library').hidden = false; hideNotice();
  if (!lib.playlists) loadPlaylists(); else renderLibrary();
}
function closeLibrary() { $('library').hidden = true; }

async function loadPlaylists() {
  const body = $('libBody');
  body.replaceChildren(h('p', 'lib-msg', 'Loading your playlists…'));
  $('libTitle').textContent = 'Your playlists'; $('libBack').hidden = true; $('libSearch').hidden = true;
  try {
    let all = [], offset = 0;
    for (let i = 0; i < 10; i++) {
      const r = await api('GET', '/me/playlists', { query: { limit: 50, offset } });
      if (!r.ok || !r.data) { if (!all.length) { body.replaceChildren(h('p', 'lib-msg', explain(r))); return; } break; }
      const items = (r.data.items || []).filter(Boolean);
      all = all.concat(items);
      if (!r.data.next || !items.length) break;
      offset += 50;
    }
    lib.playlists = all; lib.view = 'list'; renderLibrary();
  } catch (e) {
    if (e instanceof AuthError) { closeLibrary(); showGate({ error: e.message }); }
    else body.replaceChildren(h('p', 'lib-msg', 'Could not load playlists. Check your connection and reopen the library.'));
  }
}

function renderLibrary() { return lib.view === 'detail' && lib.cur ? renderDetail() : renderList(); }

function coverEl(url, cls) {
  const d = h('div', cls);
  if (url) { const i = document.createElement('img'); i.src = url; i.alt = ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; d.appendChild(i); }
  return d;
}
function renderList() {
  $('libTitle').textContent = 'Your playlists'; $('libBack').hidden = true; $('libSearch').hidden = false;
  const q = $('libSearch').value.trim().toLowerCase();
  const list = (lib.playlists || []).filter((p) => !q || (p.name || '').toLowerCase().includes(q));
  const body = $('libBody');
  if (!list.length) {
    body.replaceChildren(h('p', 'lib-msg', lib.playlists && lib.playlists.length ? 'No playlists match your search.'
      : 'No playlists found. (Spotify’s own generated playlists, like Discover Weekly, are not available to Development Mode apps.)'));
    return;
  }
  const grid = h('div', 'lib-grid');
  for (const p of list) {
    const b = h('button', 'pl-card'); b.type = 'button';
    b.appendChild(coverEl(coverOf(p), 'pl-cover'));
    b.appendChild(h('span', 'pl-name', p.name || 'Untitled'));
    const n = plTotal(p);
    b.appendChild(h('span', 'pl-sub', [n != null ? n + ' tracks' : '', p.owner && p.owner.display_name].filter(Boolean).join(' · ')));
    b.onclick = () => openPlaylist(p);
    grid.appendChild(b);
  }
  body.replaceChildren(grid);
}

function openPlaylist(p) { lib.view = 'detail'; lib.cur = p; renderDetail(); loadTracks(p); }
function renderDetail() {
  const p = lib.cur;
  $('libTitle').textContent = p.name || 'Playlist'; $('libBack').hidden = false; $('libSearch').hidden = true;
  const head = h('div', 'pl-head');
  head.appendChild(coverEl(coverOf(p), 'pl-cover big'));
  const info = h('div', 'pl-info');
  info.appendChild(h('div', 'pl-name big', p.name || 'Untitled'));
  const n = plTotal(p);
  info.appendChild(h('div', 'pl-sub', [p.owner && p.owner.display_name, n != null ? n + ' tracks' : ''].filter(Boolean).join(' · ')));
  const act = h('div', 'pl-actions');
  const play = h('button', 'cta small', 'Play'); play.type = 'button';
  play.onclick = () => startPlayback({ context_uri: p.uri }, { shuffle: false });
  const shuf = h('button', 'mini', 'Shuffle'); shuf.type = 'button';
  shuf.onclick = () => startPlayback({ context_uri: p.uri }, { shuffle: true });
  act.append(play, shuf); info.appendChild(act); head.appendChild(info);
  const tracks = h('div', 'trk-list'); tracks.id = 'libTracks';
  tracks.appendChild(h('p', 'lib-msg', 'Loading tracks…'));
  $('libBody').replaceChildren(head, tracks);
}
async function loadTracks(p) {
  const out = [];
  let note = '', offset = 0;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await api('GET', '/playlists/' + encodeURIComponent(p.id) + '/items', { query: { limit: 100, offset } });
      if (lib.cur !== p) return;
      if (!r.ok || !r.data) {
        note = (r.status === 403 || r.status === 404)
          ? 'Spotify only lets NEEDLE list tracks for playlists you own or collaborate on. You can still press Play or Shuffle to start this playlist.'
          : explain(r);
        break;
      }
      const items = r.data.items || [];
      items.forEach((e, k) => { const t = e && (e.item || e.track); if (t && t.uri) out.push({ t, pos: offset + k }); });
      if (!r.data.next || !items.length) break;
      offset += 100;
      if (i === 2) note = 'Showing the first 300 tracks. Play or Shuffle still uses the whole playlist.';
    }
  } catch (e) {
    if (lib.cur !== p) return;
    if (e instanceof AuthError) { closeLibrary(); return showGate({ error: e.message }); }
    note = 'Could not load tracks.';
  }
  if (lib.cur !== p || lib.view !== 'detail') return;
  const box = $('libTracks'); if (!box) return;
  const rows = out.map(({ t, pos }) => {
    const b = h('button', 'trk'); b.type = 'button';
    if (t.id && t.id === S.trackId) b.classList.add('now');
    b.appendChild(h('span', 'trk-n', String(pos + 1)));
    const mid = h('span', 'trk-mid');
    mid.appendChild(h('span', 'trk-t', t.name || 'Unknown'));
    const who = t.type === 'episode' ? ((t.show && t.show.name) || '') : (t.artists || []).map((a) => a.name).join(', ');
    mid.appendChild(h('span', 'trk-a', who));
    b.appendChild(mid);
    b.appendChild(h('span', 'trk-d', fmt(t.duration_ms || 0)));
    if (t.is_local) { b.disabled = true; b.title = 'Local files can’t be played from here'; }
    else b.onclick = () => startPlayback({ context_uri: p.uri, offset: { position: pos } });
    return b;
  });
  const kids = [];
  if (note) kids.push(h('p', 'lib-msg', note));
  if (!rows.length && !note) kids.push(h('p', 'lib-msg', 'This playlist is empty.'));
  box.replaceChildren(...kids, ...rows);
}

/* =====================================================================
   Wiring
   ===================================================================== */
function bind() {
  $('btnPlay').onclick = () => { wakeSdk(); control(S.isPlaying ? 'pause' : 'play'); };
  $('btnPrev').onclick = () => control('prev');
  $('btnNext').onclick = () => control('next');
  $('bar').addEventListener('click', (e) => {
    const r = $('bar').getBoundingClientRect();
    seek(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * S.duration));
  });
  $('btnDevices').onclick = openDevices;
  $('btnLibrary').onclick = openLibrary;
  $('libClose').onclick = closeLibrary;
  $('libBack').onclick = () => { lib.view = 'list'; lib.cur = null; renderList(); };
  $('libSearch').addEventListener('input', renderList);
  $('library').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLibrary(); });
  $('btnDevicesClose').onclick = () => { $('devicesModal').hidden = true; };
  $('btnAmbient').onclick = () => setAmbient(!document.body.classList.contains('ambient'));
  const canFs = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (canFs) $('btnFull').onclick = toggleFullscreen; else $('btnFull').hidden = true;
  $('btnLogout').onclick = () => {
    store.del(K.tokens); stopSdk(); lib.playlists = null; lib.view = 'list'; lib.cur = null; closeLibrary(); S.isPlaying = false; S.trackId = null; clearTimeout(pollTimer);
    renderPlaying(); hideNotice(); showGate({});
  };
  $('btnConnect').onclick = () => {
    if (!clientId()) {
      const v = $('cidInput').value.trim();
      if (!/^[a-f0-9]{32}$/i.test(v)) return showGate({ error: 'That doesn’t look like a Client ID (32 letters/numbers). Copy it from the Spotify Dashboard.' });
      store.set(K.cid, v);
    }
    login();
  };
  $('btnDemo').onclick = () => { history.replaceState({}, '', redirectUri() + '?demo'); startDemo(); };
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(redirectUri()); toast('Redirect URI copied'); } catch { toast('Select and copy the address manually.'); }
  };
  $('stage').addEventListener('click', peek);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLibrary(); $('devicesModal').hidden = true; return; }
    if (e.target && e.target.tagName === 'INPUT') return;
    if (!$('library').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); control(S.isPlaying ? 'pause' : 'play'); }
    else if (e.key === 'ArrowRight') control('next');
    else if (e.key === 'ArrowLeft') control('prev');
    else if (e.key === 'a' || e.key === 'A') setAmbient(!document.body.classList.contains('ambient'));
    else if ((e.key === 'f' || e.key === 'F') && canFs) toggleFullscreen();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); updateWakeLock(); }
    else { if (!S.demo && tokens()) poll(); updateWakeLock(); }
  });
  matchMedia('(orientation: portrait)').addEventListener('change', renderArm);
  setInterval(() => { if (!document.hidden && S.trackId) tick(false); }, 500);
}

async function init() {
  bind();
  if (store.get(K.ambient) === '1') document.body.classList.add('ambient');
  setBackground(null);
  setLabel({ title: 'NEEDLE', artists: 'Connect · Play · Spin', album: '' });
  if (new URLSearchParams(location.search).has('demo')) return startDemo();
  try { await handleCallback(); }
  catch (e) { return showGate({ error: e.message }); }
  if (!tokens()) return showGate({});
  if (!hasScopes()) return showGate({ error: 'NEEDLE now also needs playlist and in-browser playback permissions. Tap Reconnect once.' });
  hideGate(); poll(); initSdk();
}
init();
})();
