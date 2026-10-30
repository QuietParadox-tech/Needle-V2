(() => {
'use strict';

/* =====================================================================
   NEEDLE — Spotify vinyl player
   Auth: Authorization Code + PKCE (no client secret, no backend).
   Scopes: user-read-playback-state, user-modify-playback-state.
   ===================================================================== */

const CFG = Object.assign({ CLIENT_ID: '', POLL_PLAYING_MS: 3000, POLL_PAUSED_MS: 6000 }, window.NEEDLE_CONFIG || {});
const SCOPES = 'user-read-playback-state user-modify-playback-state';
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
function clientId() { return (CFG.CLIENT_ID || '').trim(); }
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
  store.set(K.tokens, JSON.stringify({
    access_token: j.access_token,
    refresh_token: j.refresh_token || oldRefresh,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
  }));
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
  showNotice('Nothing is playing. Open Spotify on a device and press play, or pick a device to play on.', [
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
const DEFAULT_PAL = { L: [176, 158, 134], M: [104, 68, 42], A: [150, 92, 46], D: [42, 27, 18], B: [168, 146, 118] };
const BEIGE = [214, 196, 168], BRONZE = [142, 90, 50], AMBER = [168, 104, 48], UMBER = [40, 26, 18];
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const avg = (px) => px.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / Math.max(1, px.length));
function clampLum(c, lo, hi) {
  const l = lum(c) || 1;
  if (l < lo) return c.map((v) => Math.min(255, v * lo / l));
  if (l > hi) return c.map((v) => v * hi / l);
  return c;
}
function paletteFrom(img) {
  try {
    const N = 28, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, N, N);
    const d = cx.getImageData(0, 0, N, N).data, px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
    px.sort((a, b) => lum(a) - lum(b));
    const q = Math.floor(px.length / 4);
    const dark = avg(px.slice(0, q)), light = avg(px.slice(-q));
    let w = 0, sum = [0, 0, 0];
    for (const p of px) {
      const mx = Math.max(...p), mn = Math.min(...p), s = mx ? (mx - mn) / mx : 0, wt = 0.05 + s * s * (mx / 255);
      sum = [sum[0] + p[0] * wt, sum[1] + p[1] * wt, sum[2] + p[2] * wt]; w += wt;
    }
    const dom = sum.map((v) => v / w);
    return {
      L: mix(light, BEIGE, 0.6),
      M: clampLum(mix(dom, BRONZE, 0.45), 55, 120),
      A: clampLum(mix(dom, AMBER, 0.55), 70, 150),
      D: mix(dark, UMBER, 0.65),
      B: mix(light, [190, 165, 130], 0.5),
    };
  } catch { return DEFAULT_PAL; }
}
function bgCss(p) {
  const c = (a, al = 1) => 'rgba(' + a.map(Math.round).join(',') + ',' + al + ')';
  return 'radial-gradient(60% 55% at 80% 6%,' + c(p.A, .95) + ',transparent 72%),' +
    'radial-gradient(55% 50% at 98% 100%,' + c(p.B, .9) + ',transparent 70%),' +
    'radial-gradient(45% 45% at 0% 0%,' + c(p.L, .85) + ',transparent 75%),' +
    'linear-gradient(100deg,' + c(p.L) + ' 0%,' + c(p.M) + ' 38%,' + c(p.D) + ' 72%,' + c(p.M) + ' 100%)';
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
   Wiring
   ===================================================================== */
function bind() {
  $('btnPlay').onclick = () => control(S.isPlaying ? 'pause' : 'play');
  $('btnPrev').onclick = () => control('prev');
  $('btnNext').onclick = () => control('next');
  $('bar').addEventListener('click', (e) => {
    const r = $('bar').getBoundingClientRect();
    seek(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * S.duration));
  });
  $('btnDevices').onclick = openDevices;
  $('btnDevicesClose').onclick = () => { $('devicesModal').hidden = true; };
  $('btnAmbient').onclick = () => setAmbient(!document.body.classList.contains('ambient'));
  const canFs = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (canFs) $('btnFull').onclick = toggleFullscreen; else $('btnFull').hidden = true;
  $('btnLogout').onclick = () => {
    store.del(K.tokens); S.isPlaying = false; S.trackId = null; clearTimeout(pollTimer);
    renderPlaying(); hideNotice(); showGate({});
  };
  $('btnConnect').onclick = () => {
    if (!clientId()) return showGate({ error: 'NEEDLE has not been configured by its owner yet. Please try again after the owner adds the shared Spotify Client ID to config.js.' });
    login();
  };
  $('btnDemo').onclick = () => { history.replaceState({}, '', redirectUri() + '?demo'); startDemo(); };
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(redirectUri()); toast('Redirect URI copied'); } catch { toast('Select and copy the address manually.'); }
  };
  $('stage').addEventListener('click', peek);
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
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
  hideGate(); poll();
}
init();
})();
