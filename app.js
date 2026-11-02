(() => {
'use strict';

/* =====================================================================
   NEEDLE — Spotify vinyl player
   Auth: Authorization Code + PKCE (no client secret, no backend).
   Scopes: user-read-playback-state, user-modify-playback-state.
   ===================================================================== */

const CFG = Object.assign({ CLIENT_ID: '', POLL_PLAYING_MS: 3000, POLL_PAUSED_MS: 6000 }, window.NEEDLE_CONFIG || {});
const NEED_SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'streaming', 'user-read-email', 'user-read-private'];
const OPT_SCOPES = ['user-read-recently-played'];       // asked for at login, but the app works without it (only the Recently Played shelf needs it)
const SCOPES = NEED_SCOPES.concat(OPT_SCOPES).join(' ');
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const K = { tokens: 'needle.tokens', verifier: 'needle.verifier', state: 'needle.state', cid: 'needle.clientId', ambient: 'needle.ambient', lyrics: 'needle.lyrics', local: 'needle.local', sfx: 'needle.sfx', theme: 'needle.theme' };

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
  track: null,          // track currently shown on the label
  scrub: null,          // position (ms) while the record is being turned by hand
  armDrag: false, armDown: false,
  discRot: 0,
  lyricsOn: false,
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
function hasScopes() { const t = tokens(), s = (t && t.scope) || ''; return NEED_SCOPES.every((x) => s.split(' ').includes(x)); }
function tokens() { try { return JSON.parse(store.get(K.tokens) || 'null'); } catch { return null; } }
function saveTokens(j, oldRefresh, oldScope) {
  store.set(K.tokens, JSON.stringify({
    access_token: j.access_token,
    refresh_token: j.refresh_token || oldRefresh,
    scope: j.scope || oldScope || '',
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
    saveTokens(await res.json(), t.refresh_token, t.scope);
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
    artist1: ep ? '' : ((it.artists && it.artists[0] && it.artists[0].name) || ''),
    allArtists: ep ? [] : (it.artists || []).map((x) => x.name).filter(Boolean),
    episode: ep,
  };
}
function applyPlayer(p) {
  if (!p.item) return setIdle();
  const t = normalize(p.item);
  S.device = p.device || null;
  S.ctxUri = (p.context && p.context.uri) || null;
  if (MUTE.on && p.is_playing && !MUTE.retried) { MUTE.retried = true; musicPause().catch(() => {}); }   // pause didn't land yet: ask again
  S.isPlaying = MUTE.on ? true : !!p.is_playing;   // don't flicker to "paused" while the song is hushed for scrubbing
  if (S.isPlaying) S.expectAt = 0;
  S.progress = p.progress_ms || 0;
  S.duration = t.duration;
  S.syncedAt = performance.now();
  if (t.id !== S.trackId) changeTrack(t);
  renderPlaying();
}
function setIdle() {
  S.isPlaying = false; S.syncedAt = performance.now();
  renderPlaying();
  showNotice(LOCAL.id ? 'Nothing is playing. Pick a playlist or song and it will play right here in NEEDLE.' : 'Nothing is playing. Open Spotify on a device and press play, or pick a device to play on.', [
    { label: 'Record Room', fn: rrOpen },
    { label: 'Choose device', fn: openDevices },
  ]);
  if (!S.trackId) { setLabel({ title: 'NEEDLE', artists: 'Nothing playing', album: '' }); setBackground(null); }
}
function curProgress() {
  if (S.scrub != null) return S.scrub;
  if (!S.isPlaying) return S.progress;
  return Math.min(S.duration || Infinity, S.progress + (performance.now() - S.syncedAt));
}

/* =====================================================================
   Rendering
   ===================================================================== */
function renderPlaying() {
  document.body.classList.toggle('playing', S.isPlaying);
  $('deviceCap').textContent = MUTE.on ? 'Scrubbing · song paused' : S.demo ? 'DEMO MODE · not connected to Spotify'
    : S.device ? 'On ' + S.device.name : '';
  renderArm(); tick(true); updateWakeLock(); rrSync();
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
  if (S.armDrag) return;
  const [a, b] = armRange();
  const frac = S.duration ? Math.min(1, curProgress() / S.duration) : 0;
  const armUp = MUTE.on || S.launching || (S.demo && document.body.classList.contains('scrubbing'));   // arm lifts while the song is paused for scrubbing
  const ang = ((S.isPlaying || S.armDown) && !S.lifted && !armUp) ? a + (b - a) * frac : 0;
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
function rgb2hsv(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
const satBoost = (c, k) => { const l = lum(c); return c.map((v) => Math.max(0, Math.min(255, l + (v - l) * k))); };
// Pull the real colours out of the cover: group pixels by hue, rank groups by how vivid and common they are.
function paletteFrom(img) {
  try {
    const N = 32, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, N, N);
    const d = cx.getImageData(0, 0, N, N).data, B = 18;
    const bins = Array.from({ length: B }, () => ({ w: 0, s: [0, 0, 0] })), grey = [];
    for (let i = 0; i < d.length; i += 4) {
      const p = [d[i], d[i + 1], d[i + 2]], [h, s, v] = rgb2hsv(p);
      if (s > 0.2 && v > 0.18) { const wt = 0.1 + s * s * v, b = bins[Math.floor(h / (360 / B)) % B]; b.w += wt; b.s[0] += p[0] * wt; b.s[1] += p[1] * wt; b.s[2] += p[2] * wt; }
      else grey.push(p);
    }
    const group = (i) => {                                    // a bin blended with its two neighbours
      let w = 0, s = [0, 0, 0];
      for (const k of [-1, 0, 1]) { const b = bins[(i + k + B) % B], f = k === 0 ? 1 : 0.5; w += b.w * f; s = s.map((v, j) => v + b.s[j] * f); }
      return { i, w, c: w ? s.map((v) => v / w) : [0, 0, 0] };
    };
    const gs = bins.map((_, i) => group(i)).filter((g) => g.w > 0).sort((a, b) => b.w - a.w);
    const far = (g, picked) => picked.every((p) => { const di = Math.abs(g.i - p.i); return Math.min(di, B - di) >= 3; });
    const picked = [];
    for (const g of gs) { if (!picked.length || (far(g, picked) && g.w >= gs[0].w * 0.12)) picked.push(g); if (picked.length === 3) break; }
    const total = bins.reduce((s, b) => s + b.w, 0);
    let c1, c2, c3;
    if (!picked.length || total < 1.5) {                      // black & white / very muted cover: use its greys, cooled slightly
      const g = avg(grey.length ? grey : [[90, 80, 75]]);
      c1 = mix(g, [70, 80, 110], 0.25); c2 = mix(g, [200, 190, 180], 0.4); c3 = c1;
    } else {
      c1 = satBoost(picked[0].c, 1.2);
      c2 = picked[1] ? satBoost(picked[1].c, 1.2) : mix(satBoost(picked[0].c, 1.3), [255, 235, 210], 0.35);
      c3 = picked[2] ? satBoost(picked[2].c, 1.2) : c2;
    }
    return {
      L: clampLum(mix(c2, [255, 244, 230], 0.28), 120, 178),
      M: clampLum(c1, 55, 118),
      A: clampLum(c2, 85, 152),
      D: mix(c1.map((v) => v * 0.2), [12, 9, 7], 0.2),
      B: clampLum(c3, 80, 150),
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
/* ---------- dark mode: the same cover-colour background, but a really dark shade of it ---------- */
let curPal = null;
function themeNow() { const v = store.get(K.theme); return v === 'dark' || v === 'light' ? v : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
const DARK_LUM = { L: 34, A: 28, B: 26, M: 19, D: 9 };           // how bright each palette colour may be in dark mode (0-255)
function darkPal(p) {                                             // keep each colour's hue, pull the brightness way down
  const out = {};
  for (const k of Object.keys(DARK_LUM)) { const c = p[k] || DEFAULT_PAL[k], l = lum(c) || 1, f = Math.min(1, DARK_LUM[k] / l); out[k] = c.map((v) => v * f); }
  return out;
}
function applyTheme() {
  const t = themeNow(), dark = t === 'dark';
  document.body.classList.toggle('dark', dark);
  const room = $('room'); if (room) room.dataset.theme = t;
  for (const id of ['btnTheme']) { const b = $(id); if (!b) continue; b.setAttribute('aria-pressed', dark); b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode'); b.title = dark ? 'Light mode' : 'Dark mode'; }
  setBackground(curPal);
}
function toggleTheme() { store.set(K.theme, themeNow() === 'dark' ? 'light' : 'dark'); applyTheme(); }
function setBackground(p) {
  curPal = p || null;
  p = p || DEFAULT_PAL;
  if (document.body.classList.contains('dark')) p = darkPal(p);
  const A = $('bgA'), B = $('bgB'), next = S.bgOn === 'A' ? B : A, prev = S.bgOn === 'A' ? A : B;
  next.style.background = bgCss(p); next.classList.add('on'); prev.classList.remove('on');
  S.bgOn = S.bgOn === 'A' ? 'B' : 'A';
  const root = document.documentElement.style;                       // the page canvas carries the same colours, so the strips iPadOS paints outside the viewport (status bar / home bar) match
  root.backgroundColor = 'rgb(' + p.M.map(Math.round).join(',') + ')'; root.backgroundImage = bgCss(p);
  root.backgroundRepeat = 'no-repeat'; root.backgroundSize = '100% calc(100% + 240px)'; root.backgroundPosition = '0 -120px';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = 'rgb(' + p.M.map(Math.round).join(',') + ')';
}

/* ---------- track change: lift arm, slide record, swap, drop arm ---------- */
async function changeTrack(t) {
  const first = !S.trackId, my = ++S.seq;
  const quiet = !!S.quiet && (S.quiet === t.id || S.quiet === '*'); if (quiet) S.quiet = null;   // the Record Room already placed this record: no second lift-and-swap
  S.trackId = t.id;
  rrOnTrack();
  let loaded = null;
  if (t.art) { try { loaded = await loadImage(t.art); } catch { loaded = null; } }
  if (my !== S.seq) return;
  const stage = $('stage');
  if (!first && !quiet) { stage.classList.add('changing'); S.lifted = true; renderArm(); await sleep(550); if (my !== S.seq) return; }
  setLabel(t); rrSync();
  lyOnTrack(t);
  if (Q.open) loadQueue();
  setSleeve(loaded ? t.art : null, loaded ? loaded.cors : false);
  setBackground(loaded && loaded.cors ? paletteFrom(loaded.img) : null);
  if (!first && !quiet) {
    stage.classList.remove('changing');
    await sleep(900); if (my !== S.seq) return;
  }
  S.lifted = false; renderArm();
}

/* =====================================================================
   Lyrics — synced lines from LRCLIB (https://lrclib.net, free, no key).
   Only requested while lyrics are switched on. Shown on the sleeve.
   ===================================================================== */
const LRC_API = 'https://lrclib.net/api';
const LY_LEAD = 250;                       // highlight a line slightly early, feels better than late
const LY = { id: null, lines: null, els: [], idx: -2, manual: false, mt: 0 };
const lyCache = new Map();
let lySeq = 0;

function parseLrc(txt) {
  const out = [], TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(TS)];
    if (!stamps.length) continue;           // metadata tags like [ar:...] have no timestamp
    const text = raw.replace(TS, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) {
      const f = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
      out.push({ t: Number(m[1]) * 60000 + Number(m[2]) * 1000 + f, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function cleanTitle(s) {
  const c = String(s || '')
    .replace(/\s*[(\[][^)\]]*(feat|ft\.|with |remaster|live|version|edit|mono|stereo|from |soundtrack|bonus|deluxe|acoustic|radio)[^)\]]*[)\]]/ig, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live|single|from |soundtrack|radio).*$/i, '').trim();
  return c || s;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9\u0080-￿]+/g, ' ').trim();
async function lrc(path, params, tries = 2) {                 // one LRCLIB request, retried on network errors / 429 / 5xx
  const url = new URL(LRC_API + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error('lrclib ' + res.status);
      return await res.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(700 * (i + 1)); }
  }
}
// How well does a LRCLIB record match the Spotify track? Returns -Infinity when it is clearly a different song/edit.
function lyScore(r, t, secs) {
  if (!r || !(r.instrumental || r.syncedLyrics || r.plainLyrics)) return -Infinity;
  const dd = secs && r.duration ? Math.abs(r.duration - secs) : 0;
  if (dd > 10) return -Infinity;                              // a different edit of the song: timings would be wrong
  const rt = norm(cleanTitle(r.trackName || r.name)), tt = norm(cleanTitle(t.title));
  const titleOk = rt === tt ? 2 : (rt && tt && (rt.includes(tt) || tt.includes(rt))) ? 1 : 0;
  const ra = norm(r.artistName), arts = (t.allArtists && t.allArtists.length ? t.allArtists : [t.artist1]).map(norm).filter(Boolean);
  const artistOk = !arts.length || arts.some((x) => ra.includes(x) || x.includes(ra));
  if (!titleOk || !artistOk) return -Infinity;
  return (r.syncedLyrics ? 100 : r.instrumental ? 60 : 40) - dd * 6 + titleOk * 20;
}
function pickBest(list, t, secs) {
  const ranked = (list || []).map((r) => [lyScore(r, t, secs), r]).filter((x) => x[0] > -Infinity).sort((a, b) => b[0] - a[0]);
  return ranked.length ? ranked[0][1] : null;
}
function lyResult(rec) {
  if (!rec) return { none: true };
  if (rec.instrumental) return { instrumental: true };
  const synced = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
  if (synced.length) return { synced };
  if (rec.plainLyrics && rec.plainLyrics.trim()) return { plain: rec.plainLyrics };
  return { none: true };
}
async function fetchOvh(t) {                                  // last-resort plain-text source (not synced)
  if (!t.artist1) return null;
  try {
    const res = await fetch('https://api.lyrics.ovh/v1/' + encodeURIComponent(t.artist1) + '/' + encodeURIComponent(cleanTitle(t.title)), { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) return null;
    const j = await res.json(), txt = (j && j.lyrics || '').replace(/^Paroles de la chanson[^\n]*\n+/i, '').trim();
    return txt.length > 40 ? txt : null;
  } catch { return null; }
}
async function fetchLyrics(t) {
  if (t.lrc) return { synced: t.lrc, demo: true };
  if (t.episode) return { none: true, podcast: true };
  const secs = Math.round(t.duration / 1000), ct = cleanTitle(t.title), a1 = t.artist1;
  let failed = 0, total = 0;
  const run = async (path, params) => { total++; try { return await lrc(path, params); } catch { failed++; return null; } };
  // 1. exact lookups (fast path)
  const exact = await Promise.all([
    run('/get', { track_name: t.title, artist_name: a1, album_name: t.album, duration: secs }),
    run('/get', { track_name: ct, artist_name: a1, duration: secs }),
  ]);
  const hit = exact.find((r) => r && lyScore(r, t, secs) > -Infinity && (r.syncedLyrics || r.instrumental));
  if (hit) return lyResult(hit);
  // 2. searches, widening step by step; stop as soon as a synced match turns up
  const pool = exact.filter(Boolean);
  const batches = [
    [{ track_name: ct, artist_name: a1 }, { q: (ct + ' ' + a1).trim() }, { track_name: t.title, artist_name: a1 }],
    [...(t.allArtists || []).slice(1, 3).map((x) => ({ track_name: ct, artist_name: x })), { q: ct }, { q: (norm(ct) + ' ' + norm(a1)).trim() }],
  ];
  for (const batch of batches) {
    const lists = await Promise.all(batch.map((q) => run('/search', q)));
    for (const l of lists) if (Array.isArray(l)) pool.push(...l);
    const best = pickBest(pool, t, secs);
    if (best && (best.syncedLyrics || best.instrumental)) return lyResult(best);
  }
  const best = pickBest(pool, t, secs);
  if (best) return lyResult(best);                            // plain (unsynced) lyrics from LRCLIB
  if (total && failed === total) throw new Error('lyrics service unreachable');
  const ovh = await fetchOvh(t);
  if (ovh) return { plain: ovh, ovh: true };
  return { none: true };
}

/* lyrics are remembered on this device, so repeat plays are instant, work offline and never re-ask the network */
const LY_CACHE_KEY = 'needle.lycache', LY_CACHE_MAX = 80;
function lyCacheLoad() { try { return JSON.parse(store.get(LY_CACHE_KEY) || '{}'); } catch { return {}; } }
function lyCacheGet(id) { const e = lyCacheLoad()[id]; return e ? e.res : null; }
function lyCachePut(id, res) {
  if (!res || res.none || res.demo) return;
  const c = lyCacheLoad(); c[id] = { t: Date.now(), res };
  const ids = Object.keys(c).sort((x, y) => c[y].t - c[x].t);
  for (const old of ids.slice(LY_CACHE_MAX)) delete c[old];
  try { store.set(LY_CACHE_KEY, JSON.stringify(c)); } catch { /* storage full: skip */ }
}

function lyStatus(msg, loading, actionLabel, actionFn) {
  const el = $('lyStatus'); el.textContent = msg || '';
  if (msg && actionLabel) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ly-act'; b.textContent = actionLabel; b.onclick = actionFn; el.appendChild(b); }
  el.classList.toggle('show', !!msg); el.classList.toggle('loading', !!loading);
}
function lyClear() {
  LY.lines = null; LY.els = []; LY.idx = -2;
  $('lyLines').textContent = ''; $('lyLines').style.transform = '';
  $('lyScroll').classList.remove('plain'); $('lyScroll').scrollTop = 0;
  $('lyCredit').textContent = ''; lyStatus('');
  LY.manual = false; clearTimeout(LY.mt); $('lyNow').classList.remove('show');
}
function lyShow(res) {
  lyClear();
  if (res.instrumental) return lyStatus('Instrumental ♪');
  if (res.none) return res.podcast ? lyStatus('No lyrics for podcasts') : lyStatus('No lyrics found for this track', false, 'Search manually', openLyPick);
  const box = $('lyLines'), frag = document.createDocumentFragment();
  if (res.synced) {
    res.synced.forEach((ln, i) => {
      const d = document.createElement('div');
      d.className = 'ly-line' + (ln.text ? '' : ' gap'); d.textContent = ln.text || '♪'; d.dataset.i = i;
      frag.appendChild(d);
    });
    box.appendChild(frag);
    LY.lines = res.synced; LY.els = Array.from(box.children);
    lyTick(true); lyCenter(true);
  } else {
    $('lyScroll').classList.add('plain');
    let blank = false;
    for (const raw of res.plain.split(/\r?\n/)) {
      const text = raw.trim();
      if (!text) { if (blank) continue; blank = true; } else blank = false;
      const d = document.createElement('div'); d.className = 'ly-line' + (text ? '' : ' blank'); d.textContent = text;
      frag.appendChild(d);
    }
    box.appendChild(frag);
  }
  $('lyCredit').textContent = res.demo ? 'Demo lyrics · invented' : res.ovh ? 'lyrics.ovh · not synced' : (res.synced ? 'LRCLIB' : 'LRCLIB · not synced');
}
async function lyLoad(t) {
  const my = ++lySeq;
  LY.id = t.id; lyClear();
  const cached = lyCache.get(t.id) || lyCacheGet(t.id);
  if (cached) { lyCache.set(t.id, cached); return lyShow(cached); }
  lyStatus('Finding lyrics…', true);
  try {
    const res = await fetchLyrics(t);
    if (my !== lySeq) return;
    lyCache.set(t.id, res); lyCachePut(t.id, res); lyShow(res);
  } catch {
    if (my !== lySeq) return;
    LY.id = null;                                                          // allow a retry
    lyStatus('Couldn’t reach the lyrics service.', false, 'Try again', () => { if (S.track) lyLoad(S.track); });
  }
}
/* "Wrong or missing lyrics?" - search LRCLIB by hand and choose the version that fits */
let lyPickT = 0;
function openLyPick() {
  if (!S.track) return;
  $('lyPickModal').hidden = false;
  $('lyPickQ').value = (cleanTitle(S.track.title) + ' ' + S.track.artist1).trim();
  runLyPick();
}
function closeLyPick() { $('lyPickModal').hidden = true; }
async function runLyPick() {
  const q = $('lyPickQ').value.trim(), list = $('lyPickList'), my = ++lyPickT;
  const msg = (t) => { list.innerHTML = ''; const li = document.createElement('li'); li.className = 'empty'; li.textContent = t; list.appendChild(li); };
  if (q.length < 2) return msg('Type a song title and artist.');
  msg('Searching…');
  let res;
  try { res = await lrc('/search', { q }); } catch { if (my === lyPickT) msg('Couldn’t reach the lyrics service. Check your connection.'); return; }
  if (my !== lyPickT) return;
  const rows = (Array.isArray(res) ? res : []).filter((r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental)).slice(0, 25);
  if (!rows.length) return msg('Nothing found. Try fewer words, or just the song title.');
  list.innerHTML = '';
  const secs = S.track ? Math.round(S.track.duration / 1000) : 0;
  for (const r of rows) {
    const li = document.createElement('li'), b = document.createElement('button'), meta = document.createElement('span');
    meta.className = 'pl-meta';
    const n = document.createElement('span'); n.className = 'pl-name'; n.textContent = r.trackName || r.name || 'Unknown';
    const s = document.createElement('span'); s.className = 'pl-sub';
    s.textContent = [r.artistName, r.albumName, r.instrumental ? 'instrumental' : r.syncedLyrics ? 'synced' : 'not synced'].filter(Boolean).join(' · ');
    meta.append(n, s);
    const d = document.createElement('span'); d.className = 'pl-dur';
    d.textContent = r.duration ? mmss(r.duration * 1000) + (secs && Math.abs(r.duration - secs) > 3 ? ' ≠' : '') : '';
    b.append(meta, d);
    b.onclick = () => { const out = lyResult(r); if (S.track) { lyCache.set(S.track.id, out); lyCachePut(S.track.id, out); } closeLyPick(); lyShow(out); toast('Lyrics changed'); };
    li.appendChild(b); list.appendChild(li);
  }
}

function lyOnTrack(t) {                        // called when a new record's label is swapped in
  S.track = t; LY.id = null; lySeq++; lyClear();
  if (S.lyricsOn) lyLoad(t);
}
function lyIndex(pos) {                        // last line whose time <= pos
  const a = LY.lines; let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].t <= pos) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
function lyTick(force) {
  if (!S.lyricsOn || !LY.lines) return;
  const i = lyIndex(curProgress() + LY_LEAD);
  if (i === LY.idx && !force) return;
  const first = LY.idx === -2; LY.idx = i;
  LY.els.forEach((el, k) => { el.classList.toggle('cur', k === i); el.classList.toggle('past', k < i); });
  lyCenter(first);
}
function lyCenter(snap) {                                    // follow the song: put the current line near the top third
  if (!LY.els.length || LY.manual) return;
  const el = LY.els[Math.max(0, LY.idx)], sc = $('lyScroll'), box = $('lyLines');
  const y = el.getBoundingClientRect().top - box.getBoundingClientRect().top + el.offsetHeight / 2 - sc.clientHeight * 0.4;
  sc.scrollTo({ top: Math.max(0, y), behavior: snap ? 'auto' : 'smooth' });
}
function lyUser() {                                          // you touched/scrolled the lyrics: stop following for a while
  if (!LY.lines) return;
  LY.manual = true; $('lyNow').classList.add('show');
  clearTimeout(LY.mt); LY.mt = setTimeout(lyFollow, 5000);
}
function lyFollow() { LY.manual = false; clearTimeout(LY.mt); $('lyNow').classList.remove('show'); lyCenter(false); }
function setLyrics(on) {
  S.lyricsOn = on;
  document.body.classList.toggle('lyrics', on);
  const b = $('btnLyrics'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  store.set(K.lyrics, on ? '1' : '0');
  if (!on) return;
  if (!S.track) lyStatus('Play a track to see its lyrics');
  else if (LY.id !== S.track.id) lyLoad(S.track);
  else { lyTick(true); lyCenter(true); }
}

/* =====================================================================
   Controls (never pretend success: UI only changes after Spotify says OK)
   ===================================================================== */
async function control(kind) {
  if (S.demo) { demoControl(kind); return true; }
  activateLocal();
  if (LOCAL.player && LOCAL.id && S.device && S.device.id === LOCAL.id) {
    try {
      const P = LOCAL.player;
      if (kind === 'play') await P.resume(); else if (kind === 'pause') await P.pause();
      else if (kind === 'next') await P.nextTrack(); else await P.previousTrack();
      if (kind === 'play' || kind === 'pause') { S.progress = curProgress(); S.syncedAt = performance.now(); S.isPlaying = kind === 'play'; renderPlaying(); }
      hideNotice(); setTimeout(poll, 500);
      if (kind === 'play') expectPlaying();
      return true;
    } catch { /* fall back to the Web API below */ }
  }
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
      if (kind === 'play') expectPlaying();
      return true;
    }
    if (r.status === 404 && LOCAL.id && kind === 'play') {         // nothing active: start playing here in the browser
      const t = await api('PUT', '/me/player', { body: { device_ids: [LOCAL.id], play: true } });
      if (t.ok) { hideNotice(); setTimeout(poll, 800); return true; }
    }
    toast(explain(r), true);
    if (r.status === 404) showNotice(explain(r), [{ label: 'Record Room', fn: rrOpen }, { label: 'Choose device', fn: openDevices }]);
  } catch (e) {
    if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true);
  }
  return false;
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

/* ---------- playlists list (used by the Record Room) ---------- */
const WAIT = { ctx: null };                              // a play request waiting for the person to pick a device
async function fetchPlaylists() {
  const out = [];
  for (let i = 0; i < 10; i++) {                       // up to 500 playlists
    const r = await api('GET', '/me/playlists', { query: { limit: 50, offset: i * 50 } });
    if (!r.ok) return { error: r };
    const items = (r.data && r.data.items) || [];
    out.push(...items.filter(Boolean));
    if (!r.data.next || !items.length) break;
  }
  return { items: out };
}
/* ---------- up next: the current queue ---------- */
const Q = { open: false, now: null, items: [], err: null, loading: false };
async function openQueue() {
  if (S.demo) return toast('The queue is not available in demo mode.');
  $('queueModal').hidden = false; Q.open = true;
  if (!Q.items.length && !Q.now) queueMsg('Loading the queue…');
  await loadQueue();
}
function closeQueue() { $('queueModal').hidden = true; Q.open = false; }
function queueMsg(text) {
  const l = $('qList'); l.innerHTML = '';
  const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; l.appendChild(li);
}
async function loadQueue() {
  if (Q.loading) return;
  Q.loading = true;
  try {
    const r = await api('GET', '/me/player/queue');
    if (!r.ok) { Q.err = r.status === 404 ? 'Nothing is playing yet, so there is no queue.' : explain(r); Q.now = null; Q.items = []; }
    else { Q.err = null; Q.now = normTrack(r.data && r.data.currently_playing); Q.items = ((r.data && r.data.queue) || []).map(normTrack).filter(Boolean); }
  } catch (e) {
    if (e instanceof AuthError) { closeQueue(); showGate({ error: e.message }); return; }
    Q.err = 'Could not load the queue. Check your connection and try again.'; Q.items = []; Q.now = null;
  } finally { Q.loading = false; }
  if (Q.open) renderQueue();
}
function renderQueue() {
  const l = $('qList'); l.innerHTML = '';
  if (Q.err) return queueMsg(Q.err);
  const label = (t) => { const li = document.createElement('li'); li.className = 'q-label'; li.textContent = t; l.appendChild(li); };
  const row = (t, cls, fn) => {
    const li = document.createElement('li'); if (cls) li.className = cls;
    const b = document.createElement('button'), meta = document.createElement('span'), img = document.createElement('img');
    img.className = 'tr-img'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; if (t.img) img.src = t.img;
    meta.className = 'pl-meta';
    const n = document.createElement('span'); n.className = 'pl-name'; n.textContent = t.name;
    const s = document.createElement('span'); s.className = 'pl-sub'; s.textContent = t.artists;
    meta.append(n, s);
    const d = document.createElement('span'); d.className = 'pl-dur'; d.textContent = t.dur ? mmss(t.dur) : '';
    b.append(img, meta, d); if (fn) b.onclick = fn; else b.disabled = true; li.appendChild(b); l.appendChild(li);
  };
  if (Q.now) { label('Now playing'); row(Q.now, 'now', null); }
  if (Q.items.length) { label('Next up · tap a song to skip to it'); Q.items.forEach((t, i) => row(t, '', () => skipTo(i))); }
  else { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nothing is queued after this song.'; l.appendChild(li); }
}
async function skipTo(i) {                                  // Spotify has no "jump to queue item", so skip forward i+1 times
  closeQueue(); toast('Skipping ahead…');
  try {
    for (let k = 0; k <= i; k++) {
      const r = await api('POST', '/me/player/next');
      if (!r.ok) { toast(explain(r), true); break; }
      await sleep(150);
    }
  } catch (e) { if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true); }
  setTimeout(poll, 500);
}

const mmss = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
async function playBody(body, name, deviceId, shuffle) {
  activateLocal();
  try {
    const r = await api('PUT', '/me/player/play', { query: deviceId ? { device_id: deviceId } : undefined, body });
    if (r.ok) {
      WAIT.ctx = null; $('devicesModal').hidden = true; hideNotice(); toast('Playing ' + name); expectPlaying();
      if (shuffle) api('PUT', '/me/player/shuffle', { query: { state: 'true' } }).catch(() => {});
      setTimeout(poll, 800);
      return true;
    } else if (r.status === 404 && LOCAL.id && !deviceId) { return playBody(body, name, LOCAL.id, shuffle); }   // no active device: play here
    else if (r.status === 404) { WAIT.ctx = { body, name, shuffle }; toast('No active device. Pick where to play ' + name + '.', true); openDevices(); }
    else toast(explain(r), true);
  } catch (e) { if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true); }
  return false;
}

/* =====================================================================
   Record Room — your collection as a drawer of record sleeves.
   Uses the same Spotify login (api()), the same playback (playBody())
   and the same player state (S) as the rest of NEEDLE.
   ===================================================================== */
const RR_PAGE = 72;                                       // sleeves drawn per batch while scrolling
const RR_ALL_PLAYLISTS = 30, RR_ALL_PER_LIST = 100, RR_LIKED_CAP = 1000;
const rrSrc = (more) => ({ items: [], offset: 0, more, loading: false, err: null });
const RR = {
  open: false, tab: 'all', sub: null, q: '', shown: RR_PAGE, seq: 0, at: 0, cur: null, key: '', detail: null,
  saved: null, liked: null, recent: null, albums: null, plists: null, all: null,
};
function rrReset() {
  RR.liked = rrSrc(true); RR.liked.total = null; RR.recent = rrSrc(true); RR.albums = rrSrc(true); RR.plists = rrSrc(true);
  RR.all = { items: [], more: true, loading: false, err: null, note: '', skipped: 0, running: false };
  RR.saved = null; RR.sub = null; RR.at = Date.now();
}
rrReset();

/* ----- mapping Spotify objects to what the sleeves need ----- */
function rrImg(images, want) {                            // smallest image that is still sharp enough
  const l = (images || []).filter((i) => i && i.url).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  if (!l.length) return null;
  const ok = l.filter((i) => (i.width || 0) >= want);
  return (ok.length ? ok[ok.length - 1] : l[0]).url;
}
function rrTrack(it) {
  const t = it && (it.item || it.track || it);
  if (!t || !t.uri || t.type === 'episode' || (it && it.is_local) || t.is_local) return null;
  const al = t.album || {};
  return {
    kind: 'track', id: t.id || t.uri.split(':').pop(), uri: t.uri, name: t.name || 'Unknown',
    artists: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '), album: al.name || '',
    art: rrImg(al.images, 300), big: rrImg(al.images, 640), dur: t.duration_ms || 0,
    date: al.release_date || '', explicit: !!t.explicit, no: t.track_number || 0,
    url: (t.external_urls && t.external_urls.spotify) || '',
  };
}
function rrAlbum(a) {
  if (!a || !a.uri) return null;
  return { kind: 'album', id: a.id, uri: a.uri, name: a.name || 'Unknown album', artists: (a.artists || []).map((x) => x.name).join(', '),
    art: rrImg(a.images, 300), big: rrImg(a.images, 640), total: a.total_tracks || 0, date: a.release_date || '', images: a.images || [] };
}
function rrPlaylist(p) {
  if (!p || !p.uri) return null;
  const total = (p.items && p.items.total) ?? (p.tracks && p.tracks.total);
  return { kind: 'playlist', id: p.id, uri: p.uri, name: p.name || 'Untitled playlist', owner: (p.owner && p.owner.display_name) || '',
    art: rrImg(p.images, 300), total: typeof total === 'number' ? total : null };
}

/* ----- fetching ----- */
function rrErr(r, what) {
  if (r.status === 401 || r.status === 403) {
    const m = (r.data && r.data.error && r.data.error.message) || '';
    if (/not registered|developer\.spotify\.com/i.test(m)) return { text: explain(r) };
    return { text: 'Spotify did not allow NEEDLE to read ' + what + '. If you connected before the Record Room existed, reconnect once to grant the new permission.', reconnect: true };
  }
  return { text: explain(r) };
}
async function rrFetch(s, path, query, what, onData) {
  s.loading = true; s.err = null;
  try {
    const r = await api('GET', path, { query });
    if (!r.ok) { s.err = rrErr(r, what); s.more = false; return false; }
    onData(r.data || {}); return true;
  } catch (e) {
    if (e instanceof AuthError) { rrClose(); showGate({ error: e.message }); }
    else s.err = { text: 'Could not reach Spotify. Check your connection and try again.' };
    s.more = false; return false;
  } finally { s.loading = false; }
}
async function rrLoadLiked() {
  const s = RR.liked; if (s.loading || !s.more) return;
  await rrFetch(s, '/me/tracks', { limit: 50, offset: s.offset }, 'your saved songs', (d) => {
    const it = d.items || [];
    s.items.push(...it.map(rrTrack).filter(Boolean)); s.offset += it.length;
    s.more = !!d.next && it.length > 0 && s.offset < RR_LIKED_CAP;
    if (typeof d.total === 'number') { s.total = d.total; RR.saved = d.total; }
  });
  rrHead();
}
async function rrLoadRecent() {
  const s = RR.recent; if (s.loading || !s.more) return;
  await rrFetch(s, '/me/player/recently-played', { limit: 50 }, 'your listening history', (d) => {
    const seen = new Set(); s.items = [];
    for (const it of d.items || []) { const t = rrTrack(it); if (t && !seen.has(t.id)) { seen.add(t.id); s.items.push(t); } }
    s.more = false;
  });
}
async function rrLoadAlbums() {
  const s = RR.albums; if (s.loading || !s.more) return;
  await rrFetch(s, '/me/albums', { limit: 50, offset: s.offset }, 'your saved albums', (d) => {
    const it = d.items || [];
    s.items.push(...it.map((x) => rrAlbum(x.album || x)).filter(Boolean)); s.offset += it.length; s.more = !!d.next && it.length > 0;
  });
}
async function rrLoadPlaylists() {
  const s = RR.plists; if (s.loading || !s.more) return;
  s.loading = true; s.err = null;
  try {
    const r = await fetchPlaylists();
    if (r.error) s.err = rrErr(r.error, 'your playlists'); else s.items = r.items.map(rrPlaylist).filter(Boolean);
    s.more = false;
  } catch (e) {
    if (e instanceof AuthError) { rrClose(); showGate({ error: e.message }); } else s.err = { text: 'Could not reach Spotify. Check your connection and try again.' };
    s.more = false;
  } finally { s.loading = false; }
  rrHead();
}
async function rrPlaylistPage(id, offset) {
  let r = await api('GET', '/playlists/' + id + '/items', { query: { limit: 50, offset, additional_types: 'track' } });
  if (!r.ok && (r.status === 404 || r.status === 400)) r = await api('GET', '/playlists/' + id + '/tracks', { query: { limit: 50, offset } });
  return r;
}
async function rrLoadSub() {
  const s = RR.sub; if (!s || s.loading || !s.more) return; const my = s.seq;
  s.loading = true; s.err = null;
  try {
    let r;
    if (s.kind === 'album') r = await api('GET', '/albums/' + s.id + '/tracks', { query: { limit: 50, offset: s.offset } });
    else r = await rrPlaylistPage(s.id, s.offset);
    if (!RR.sub || RR.sub.seq !== my) return;
    if (!r.ok) {
      s.err = (r.status === 403 && s.kind === 'playlist')
        ? { text: 'Spotify does not let NEEDLE read the songs of this playlist (this happens with playlists you do not own). You can still play the whole playlist.' }
        : rrErr(r, 'these songs');
      s.more = false;
    } else {
      const it = (r.data && r.data.items) || [];
      const meta = { name: s.name, images: s.images || [], release_date: s.date || '', uri: s.uri };
      s.items.push(...it.map((x) => rrTrack(s.kind === 'album' ? Object.assign({}, x, { album: meta }) : x)).filter(Boolean));
      s.offset += it.length; s.more = !!(r.data && r.data.next) && it.length > 0;
    }
  } catch (e) {
    if (e instanceof AuthError) { rrClose(); showGate({ error: e.message }); } else if (RR.sub && RR.sub.seq === my) { s.err = { text: 'Could not reach Spotify. Check your connection and try again.' }; s.more = false; }
  } finally { s.loading = false; }
}
let rrThrottle = 0;
function rrSoon() { if (rrThrottle) return; rrThrottle = setTimeout(() => { rrThrottle = 0; rrRender(false); }, 250); }
async function rrBuildAll() {                              // every song we are allowed to see: saved + playlists + recent, without duplicates
  const A = RR.all; if (A.running || !A.more) return; A.running = true; A.loading = true; A.err = null; A.skipped = 0;
  const seen = new Map(), push = (arr) => { for (const t of arr) if (!seen.has(t.id)) seen.set(t.id, t); A.items = Array.from(seen.values()); rrSoon(); };
  const gen = RR.at;
  try {
    A.note = 'Flipping through your saved songs…';
    while (RR.liked.more && !RR.liked.err && gen === RR.at) { if (RR.liked.loading) { await sleep(80); continue; } await rrLoadLiked(); push(RR.liked.items); }
    push(RR.liked.items);
    await rrLoadPlaylists();
    const lists = (RR.plists.items || []).slice(0, RR_ALL_PLAYLISTS);
    for (let i = 0; i < lists.length && gen === RR.at; i++) {
      A.note = 'Opening playlist ' + (i + 1) + ' of ' + lists.length + '…'; rrSoon();
      for (let off = 0; off < RR_ALL_PER_LIST; off += 50) {
        let r = await rrPlaylistPage(lists[i].id, off);
        if (r.status === 429) { await sleep(Math.max(1000, (S.backoffUntil || 0) - Date.now())); r = await rrPlaylistPage(lists[i].id, off); }
        if (!r.ok) { A.skipped++; break; }
        const it = (r.data && r.data.items) || [];
        push(it.map(rrTrack).filter(Boolean));
        if (!r.data.next || !it.length) break;
      }
    }
    await rrLoadRecent(); push(RR.recent.items);
    if (!A.items.length && RR.liked.err) A.err = RR.liked.err;
  } catch (e) {
    if (e instanceof AuthError) { rrClose(); showGate({ error: e.message }); } else A.err = { text: 'Could not reach Spotify. Check your connection and try again.' };
  } finally { A.more = false; A.running = false; A.loading = false; A.note = ''; if (gen === RR.at) rrRender(false); }
}

/* ----- what is on screen now ----- */
function rrView() {
  const q = RR.q.trim().toLowerCase();
  const has = (t) => !q || [t.name, t.artists, t.album, t.owner].some((x) => (x || '').toLowerCase().includes(q));
  let v;
  if (RR.sub) { const s = RR.sub; v = { type: 'tracks', title: s.name, src: s, ctx: { uri: s.uri, name: s.name }, load: rrLoadSub, what: 'songs' }; }
  else if (RR.tab === 'playlists') v = { type: 'playlists', title: 'Playlists', src: RR.plists, load: rrLoadPlaylists, what: 'playlists' };
  else if (RR.tab === 'albums') v = { type: 'albums', title: 'Albums', src: RR.albums, load: rrLoadAlbums, what: 'albums' };
  else if (RR.tab === 'recent') v = { type: 'tracks', title: 'Recently Played', src: RR.recent, load: rrLoadRecent, what: 'songs' };
  else if (RR.tab === 'liked') v = { type: 'tracks', title: 'Liked Songs', src: RR.liked, load: rrLoadLiked, what: 'songs' };
  else v = { type: 'tracks', title: 'All Songs', src: RR.all, load: rrBuildAll, what: 'songs' };
  const all = v.src.items || [];
  v.all = all; v.list = q ? all.filter(has) : all;
  return v;
}
function rrKick() {                                       // load whatever this view is missing
  const v = rrView(), s = v.src;
  if (s.loading || !s.more || s.err) return;
  const my = RR.key;
  Promise.resolve(v.load()).then(() => { if (RR.open) rrRender(false); if (RR.q && RR.key === my) rrKick(); });
}
const rrHash = (str) => { let h = 7; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
const RR_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
function rrCard(t, i) {
  const h = rrHash(t.id || t.uri), li = document.createElement('li');
  li.className = 'rr-card' + (h % 4 === 0 ? ' tilt' : '') + (t.kind !== 'track' ? ' ' + t.kind : '');
  li.style.setProperty('--rot', ((h % 5) - 2) * 0.55 + 'deg');
  if (t.kind === 'track') li.dataset.id = t.id; else li.dataset.uri = t.uri;
  const st = h % 11; if (st < 3) li.dataset.st = String(st + 1);
  const art = t.art ? '<img alt="" loading="lazy" decoding="async">' : '<span class="rr-noart" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="21"/><circle cx="50" cy="50" r="2" class="d"/></svg><i>NO ARTWORK</i></span>';
  const label = t.kind === 'track' ? 'Details for ' + t.name : 'Open ' + t.name;
  li.innerHTML = '<div class="rr-sleeve"><span class="rr-disc" aria-hidden="true"><i></i></span>'
    + '<div class="rr-front"><button class="rr-art" type="button"></button><span class="rr-cat"></span><span class="rr-eq" aria-hidden="true"><i></i><i></i><i></i></span></div>'
    + '<button class="rr-go" type="button"></button></div>'
    + '<button class="rr-meta" type="button"><b class="t"></b><span class="a"></span><span class="al"></span></button>';
  const artBtn = li.querySelector('.rr-art'); artBtn.innerHTML = art; artBtn.setAttribute('aria-label', label);
  if (t.art) { const im = artBtn.querySelector('img'); im.src = t.art; }
  li.querySelector('.rr-cat').textContent = 'NR·' + String(i + 1).padStart(4, '0');
  const go = li.querySelector('.rr-go'); go.innerHTML = RR_PLAY + '<svg class="p" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  go.setAttribute('aria-label', 'Play ' + t.name);
  li.querySelector('.t').textContent = t.name;
  if (t.kind === 'track') { li.querySelector('.a').textContent = t.artists; li.querySelector('.al').textContent = t.album; }
  else if (t.kind === 'album') { li.querySelector('.a').textContent = t.artists; li.querySelector('.al').textContent = (t.total ? t.total + ' tracks' : '') + (t.date ? ' · ' + t.date.slice(0, 4) : ''); }
  else { li.querySelector('.a').textContent = t.owner ? 'by ' + t.owner : 'Playlist'; li.querySelector('.al').textContent = t.total != null ? t.total + ' tracks' : ''; }
  if (t.kind === 'track') {
    artBtn.onclick = () => rrDetail(t);
    go.onclick = li.querySelector('.rr-meta').onclick = () => rrLaunch(li.querySelector('.rr-disc'), t.id, () => rrPlay(t), t);
  } else {
    artBtn.onclick = li.querySelector('.rr-meta').onclick = () => rrOpenSub(t);
    go.onclick = () => rrLaunch(li.querySelector('.rr-disc'), null, () => playBody({ context_uri: t.uri }, t.name), { name: t.name, artists: t.kind === 'album' ? t.artists : (t.owner ? 'by ' + t.owner : 'Playlist'), album: '' });
  }
  return li;
}
function rrMsg(kind, title, text, extra) {
  const el = $('rrState'); el.innerHTML = '';
  const box = document.createElement('div'); box.className = 'rr-msg ' + kind;
  const art = {
    load: '<div class="rr-spin" aria-hidden="true"></div>',
    empty: '<svg class="rr-ill" viewBox="0 0 120 100" aria-hidden="true"><rect x="16" y="10" width="88" height="82" rx="5" class="a"/><rect x="22" y="16" width="76" height="70" rx="3" class="b"/><circle cx="60" cy="48" r="22" class="c"/><circle cx="60" cy="48" r="7" class="d"/><path d="M82 78l16-5" class="e"/></svg>',
    none: '<svg class="rr-ill" viewBox="0 0 120 100" aria-hidden="true"><circle cx="60" cy="48" r="32" class="c"/><circle cx="60" cy="48" r="10" class="d"/><path d="M36 76L84 20" class="e"/></svg>',
    err: '<svg class="rr-ill" viewBox="0 0 120 100" aria-hidden="true"><circle cx="60" cy="48" r="32" class="c"/><circle cx="60" cy="48" r="10" class="d"/><path d="M60 48L96 22" class="e"/><path d="M92 14l10 6-8 8" class="e"/></svg>',
  }[kind];
  box.innerHTML = art + '<h3></h3><p></p>'; box.querySelector('h3').textContent = title; box.querySelector('p').textContent = text || '';
  if (extra) for (const [label, fn, hot] of extra) { const b = document.createElement('button'); b.className = 'rr-pill' + (hot ? ' hot' : ''); b.type = 'button'; b.textContent = label; b.onclick = fn; box.appendChild(b); }
  el.appendChild(box);
}
function rrHead() {
  $('rrSaved').textContent = RR.saved != null ? RR.saved.toLocaleString() : '–';
  $('rrLists').textContent = RR.plists.items ? RR.plists.items.length.toLocaleString() : '–';
}
function rrRender(reset) {
  if (!RR.open) return;
  const v = rrView(), body = $('rrBody'), keep = body.scrollTop, grid = $('rrGrid');
  const key = (RR.sub ? 's' + RR.sub.seq : RR.tab) + '|' + RR.q;
  if (reset || key !== RR.key) { RR.shown = RR_PAGE; RR.key = key; }
  RR.cur = v;
  const s = v.src;
  // toolbar
  $('rrBack').hidden = !RR.sub; $('rrCrumb').textContent = v.title;
  const n = v.list.length;
  $('rrCount').textContent = s.loading && !n ? '' : (RR.q ? n + ' found' : n + (s.more ? '+' : '') + (v.type === 'tracks' ? ' records' : v.type === 'albums' ? ' albums' : ' playlists'));
  const canPlay = v.type === 'tracks' && n > 0;
  $('rrPlayAll').hidden = !(RR.sub || (v.type === 'tracks' && n)); $('rrShuffle').hidden = !canPlay;
  $('rrPlayAll').disabled = !(RR.sub ? true : canPlay);
  // grid
  const want = v.list.slice(0, RR.shown), prev = RR.drawn || [];
  const keepOld = !reset && key === RR.drawnKey && prev.length > 0 && prev.length <= want.length && prev.every((t, i) => t === want[i]);
  const frag = document.createDocumentFragment();
  if (!keepOld) { grid.innerHTML = ''; grid.className = 'rr-grid ' + v.type; }      // same sleeves as before: leave them alone (no reload, no flicker) and only add the new ones
  for (let i = keepOld ? prev.length : 0; i < want.length; i++) frag.appendChild(rrCard(want[i], i));
  grid.appendChild(frag);
  RR.drawn = want; RR.drawnKey = key;
  // state
  const st = $('rrState'); st.innerHTML = '';
  if (!n) {
    if (s.err) rrMsg('err', 'THE NEEDLE SKIPPED', s.err.text, [['Try again', () => { s.err = null; s.more = true; if (v.src === RR.all) { RR.all.running = false; } if (s === RR.liked) { s.offset = 0; s.items = []; } rrRender(true); rrKick(); }, true]].concat(s.err.reconnect ? [['Reconnect Spotify', login]] : []));
    else if (s.loading || s.more) rrMsg('load', RR.q ? 'SEARCHING THE CRATES…' : 'DUSTING OFF THE RECORDS…', s.note || (v.src === RR.all && RR.all.note) || 'One moment, pulling them off the shelf.');
    else if (RR.q) rrMsg('none', 'NO RECORD FOUND', 'Nothing in “' + RR.q.trim() + '” matches. Try another title, artist or album.');
    else rrMsg('empty', 'THE CRATE IS EMPTY', RR.sub ? 'There are no songs in here yet.' : { recent: 'Play something and it will show up here.', liked: 'Tap the heart on a song in Spotify and it will land here.', albums: 'Save an album in Spotify and it will be filed here.', playlists: 'No playlists found on this account.', all: 'Nothing to show yet. Save a song or make a playlist in Spotify.' }[RR.tab]);
  } else {
    if (s.err) rrMsg('err', 'THE NEEDLE SKIPPED', s.err.text + (v.type === 'tracks' ? ' The records above did load.' : ''), [['Try again', () => { s.err = null; s.more = true; rrKick(); }, true]].concat(s.err.reconnect ? [['Reconnect Spotify', login]] : []));
    else if (s.loading || s.more) { const m = document.createElement('p'); m.className = 'rr-more'; m.textContent = (v.src === RR.all && RR.all.note) || 'Loading more records…'; st.appendChild(m); }
    else if (v.src === RR.all && RR.all.skipped) { const m = document.createElement('p'); m.className = 'rr-more'; m.textContent = RR.all.skipped + ' playlist' + (RR.all.skipped > 1 ? 's were' : ' was') + ' skipped because Spotify does not let NEEDLE read ' + (RR.all.skipped > 1 ? 'their' : 'its') + ' songs.'; st.appendChild(m); }
    else if (v.src === RR.all && RR.plists.items && RR.plists.items.length > RR_ALL_PLAYLISTS) { const m = document.createElement('p'); m.className = 'rr-more'; m.textContent = 'All Songs includes your saved songs and the first ' + RR_ALL_PLAYLISTS + ' playlists. Open the others from Playlists.'; st.appendChild(m); }
  }
  body.scrollTop = keep;
  rrSync();
  if (RR.q) rrKick();
  else if (body.scrollHeight - body.clientHeight < 300 && (RR.shown < v.list.length || (s.more && !s.loading && !s.err))) rrMore();
}
function rrMore() {
  const v = rrView();
  if (RR.shown < v.list.length) { RR.shown += RR_PAGE; return rrRender(false); }
  rrKick();
}

/* ----- playback hooks ----- */
function rrPlay(t) {
  if (t.id === S.trackId) return control(S.isPlaying ? 'pause' : 'play');          // the record already on the turntable: toggle
  const v = RR.cur; if (!v) return;
  if (RR.sub && RR.sub.uri) return playBody({ context_uri: RR.sub.uri, offset: { uri: t.uri } }, t.name);
  const i = v.list.indexOf(t), from = Math.max(0, Math.min(i, v.list.length - 100));   // Spotify takes up to 100 URIs
  return playBody({ uris: v.list.slice(from, from + 100).map((x) => x.uri), offset: { uri: t.uri } }, t.name);
}
function rrPlayAll(shuffle) {
  const v = rrView(); if (!v.list.length && !RR.sub) return;
  if (RR.sub && RR.sub.uri) return playBody({ context_uri: RR.sub.uri }, RR.sub.name, null, shuffle);
  let list = v.list.slice();
  if (shuffle) for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return playBody({ uris: list.slice(0, 100).map((x) => x.uri) }, v.title, null, shuffle);
}
/* ----- the record leaves the crate and lands on the turntable ----- */
let rrBusy = false;
function rrCrumbInfo() { return { name: $('rrCrumb').textContent, artists: 'NEEDLE Record Room', album: '' }; }
async function rrLaunch(fromEl, trackId, run, info) {
  if (trackId && trackId === S.trackId) return run();                 // already on the turntable: just play/pause
  if (rrBusy) return; rrBusy = true;
  try {
    const card = fromEl && fromEl.classList.contains('rr-disc') ? fromEl.closest('.rr-card') : null;
    let pull = 0.8;
    if (card) {                                                       // 1. the record slides out of its sleeve (less far if the card is right under the top edge, where the crate would clip it)
      const room = card.getBoundingClientRect().top - $('rrBody').getBoundingClientRect().top - 6, size = fromEl.getBoundingClientRect().width || 150;
      pull = Math.max(0.3, Math.min(0.8, room / size)); card.style.setProperty('--pull', pull); card.classList.add('pulling');
    }
    if (S.isPlaying) control('pause');                                // the song only plays while the tonearm is on the record: it comes off now, so the old song stops
    await sleep(580);
    const r = fromEl.getBoundingClientRect();
    await rrFly(r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null, trackId, card, card ? pull : 1, info, run);
  } finally { rrBusy = false; }
}
function fillLabel(root, t) {                                         // same text and sizing rules as the real record's label
  const title = t.name || t.title || '', len = title.length, size = len <= 9 ? 14 : len <= 16 ? 11.5 : len <= 26 ? 9.2 : 7.4;
  const ts = root.querySelector('.l-title span'); ts.textContent = title; ts.parentElement.style.fontSize = size + 'cqw';
  root.querySelector('.l-artist span').textContent = t.artists || '';
  const alb = (t.album || '').toUpperCase(), tp = root.querySelectorAll('textPath')[1]; if (tp) tp.textContent = alb.length > 30 ? alb.slice(0, 29) + '…' : alb;
}
function rrFly(r0, trackId, card, pull, info, run) {   // resolves when the song has been started (or the attempt failed)
  rrClose();                                                          // 2. the drawer slides shut ...
  const st = $('stage'), rec = $('record'), disc = $('disc');
  const tidy = () => { if (card) card.classList.remove('pulling', 'gone'); };
  if (!r0 || !st.offsetWidth || !st.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { setTimeout(tidy, 700); return run(); }
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const S1 = rec.offsetWidth;                                         // the real record's size and spot (layout values: unaffected by the stage zoom while the drawer closes)
  const cx1 = (vw - st.offsetWidth) / 2 + rec.offsetLeft + S1 / 2, cy1 = (vh - st.offsetHeight) / 2 + rec.offsetTop + S1 / 2;
  const cx0 = r0.left + r0.width / 2, cy0 = r0.top + r0.height / 2, k0 = Math.max(0.14, Math.min(r0.width, r0.height) / S1);
  const hx = vw / 2, hy = vh / 2 - S1 * 0.02, hk = Math.min(0.95, Math.min(vw, vh) * 0.8 / S1);   // the "show it to the room" spot: centre of the screen
  document.body.classList.add('launching'); S.launching = true; renderArm();   // ... the old record is lifted off and the tonearm swings back to rest
  if (card) card.classList.add('gone');
  // the flying record is a copy of the real one (same vinyl, sheen, gold label) carrying the new song's label
  const el = document.createElement('div'); el.className = 'rr-fly'; el.setAttribute('aria-hidden', 'true'); el.style.width = el.style.height = S1 + 'px';
  const fd = disc.cloneNode(true); fd.removeAttribute('id'); fd.classList.add('f-disc'); fd.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  const track = trackId && info && info.name ? info : (S.track && trackId === S.trackId ? { name: S.track.title, artists: S.track.artists, album: S.track.album } : info);
  if (track) fillLabel(fd, track);
  const sheen = document.createElement('div'); sheen.className = 'sheen'; const orange = document.createElement('i'); orange.className = 'o';
  const drop = document.createElement('i'); drop.className = 'drop';   // soft shadow: a gradient disc (no big blurred box-shadow, so no square edges)
  el.append(drop, fd, sheen, orange); document.body.appendChild(el);
  try { const real = disc.getAnimations().find((x) => x.animationName === 'spin'), mine = fd.getAnimations()[0]; fd.style.rotate = getComputedStyle(disc).rotate === 'none' ? '' : getComputedStyle(disc).rotate; if (real && mine) { mine.currentTime = real.currentTime; mine.play(); } } catch { /* spinning in sync is a nicety */ }
  const spot = document.createElement('div'); spot.className = 'rr-spot'; document.body.appendChild(spot);
  spot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, fill: 'forwards', easing: 'ease-out' });
  const T = (x, y, k) => 'translate(' + (x - S1 / 2) + 'px,' + (y - S1 / 2) + 'px) scale(' + k + ')';
  const sh = (d, b, o) => '0 ' + Math.round(S1 * d) + 'px ' + Math.round(S1 * b) + 'px rgba(0,0,0,' + o + ')';
  const D = 2700, EO = 'cubic-bezier(.16,.84,.24,1)', IO = 'cubic-bezier(.5,0,.22,1)';
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'forwards' });
  if (pull < 1) { const cl = el.animate([{ clipPath: 'inset(0 0 ' + ((1 - pull) * 100) + '% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 320, easing: 'ease-out' }); cl.onfinish = () => cl.cancel(); }   // no fill: a lingering clip would cut the shadow into a square   // only the part that was out of the sleeve shows at first: no pop when it takes off
  const a = el.animate([
    { transform: T(cx0, cy0, k0), offset: 0, easing: EO },
    { transform: T(hx, hy, hk), offset: 0.3, easing: 'ease-in-out' },                                    // 3. shown to the screen
    { transform: T(hx, hy - S1 * 0.012, hk * 1.025), offset: 0.52, easing: IO },                          //    a gentle hover
    { transform: T(cx1, cy1, 1.07), offset: 0.85, easing: 'cubic-bezier(.3,.7,.3,1)' },                  // 4. glides over the platter
    { transform: T(cx1, cy1, 0.992), offset: 0.95, easing: 'ease-out' },                                  //    set down ...
    { transform: T(cx1, cy1, 1), offset: 1 },                                                              //    ... and settled
  ], { duration: D, fill: 'forwards' });
  const dy = (f) => 'translateY(' + Math.round(S1 * f) + 'px)';
  drop.animate([                                                                                          // the shadow is far and soft while the record is held up, tight once it is down
    { transform: dy(0.01) + ' scale(1.02)', opacity: 0, offset: 0, easing: 'linear' },
    { transform: dy(0.012) + ' scale(1.02)', opacity: 0.3, offset: 0.12, easing: EO },
    { transform: dy(0.07) + ' scale(1.12)', opacity: 0.8, offset: 0.3, easing: 'ease-in-out' },
    { transform: dy(0.08) + ' scale(1.14)', opacity: 0.85, offset: 0.52, easing: IO },
    { transform: dy(0.05) + ' scale(1.1)', opacity: 0.7, offset: 0.85, easing: 'cubic-bezier(.3,.7,.3,1)' },
    { transform: dy(0.015) + ' scale(1.03)', opacity: 0.55, offset: 1 },
  ], { duration: D, fill: 'forwards' });
  orange.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 650, delay: 300, fill: 'forwards', easing: 'ease' });   // the cabinet's orange label turns into NEEDLE's gold one
  return new Promise((resolve) => {
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      try { const real = disc.getAnimations().find((x) => x.animationName === 'spin'), mine = fd.getAnimations()[0]; if (real && mine) { mine.currentTime = real.currentTime; if (real.playState === 'paused') mine.pause(); fd.style.rotate = getComputedStyle(disc).rotate === 'none' ? '' : getComputedStyle(disc).rotate; } } catch { /* ignore */ }
      if (track) { setLabel({ title: track.name, artists: track.artists, album: track.album }); if (track.dur) S.duration = track.dur; }   // the real record already carries the new label, so the swap is invisible
      S.progress = 0; S.syncedAt = performance.now(); S.quiet = trackId || '*'; setTimeout(() => { S.quiet = null; }, 9000);
      spot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, fill: 'forwards', easing: 'ease-in' }).onfinish = () => spot.remove();
      document.body.classList.remove('launching');                    // the real record fades back in as the copy fades out: they look identical
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, fill: 'forwards', easing: 'ease-in-out' }).onfinish = () => el.remove();
      await sleep(380);
      S.armDown = true; S.launching = false; renderArm(); tidy();     // 5. the tonearm lowers onto the record ...
      await sleep(950);                                               //    ... and only when its needle is about to touch the groove does the song start
      const ok = await run();
      if (ok === true) { S.isPlaying = true; S.syncedAt = performance.now(); }
      S.armDown = false; renderPlaying();                             // playing: the arm stays down. Refused: it goes back to rest
      resolve();
    };
    a.onfinish = release; a.oncancel = release;
    setTimeout(release, 10000);                                       // never leave the turntable stuck
  });
}
function rrSync() {                                       // mark what is spinning now; cheap, runs on every player update
  const room = $('room'); if (!RR.open) return;
  room.classList.toggle('rr-playing', !!S.isPlaying);
  for (const c of document.querySelectorAll('#rrGrid .rr-card')) c.classList.toggle('now', c.dataset.id ? c.dataset.id === S.trackId : (!!c.dataset.uri && c.dataset.uri === S.ctxUri));
  const tr = S.track, has = !!(S.trackId && tr);
  $('rrNow').hidden = !has;
  if (has) {
    $('rrNowTitle').textContent = tr.title || ''; $('rrNowArtist').textContent = tr.artists || '';
    const im = $('rrNowArt'); if (tr.art && im.getAttribute('src') !== tr.art) im.src = tr.art; im.style.visibility = tr.art ? '' : 'hidden';
    $('rrNowBtn').classList.toggle('on', !!S.isPlaying);
  }
  if (RR.detail) { const d = RR.detail, now = d.id === S.trackId; $('rrDPlay').textContent = now && S.isPlaying ? '❚❚ Pause' : now ? '▶ Resume' : '▶ Play this record'; }
}
function rrOnTrack() {
  if (RR.recent) { RR.recent.more = true; }              // history changed: re-fetch next time it is shown
  if (!RR.open) return;
  rrSync();
  if (RR.tab === 'recent' && !RR.sub) setTimeout(() => { if (RR.open && RR.tab === 'recent' && !RR.sub && !RR.recent.loading) { RR.recent.err = null; rrLoadRecent().then(() => rrRender(false)); } }, 2500);
}

/* ----- open / close / navigation ----- */
function rrSetTab(tab) {
  RR.tab = tab; RR.sub = null; RR.q = ''; $('rrSearch').value = '';
  for (const b of $('rrTabs').children) { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
  $('rrBody').scrollTop = 0; rrRender(true);
}
function rrOpenSub(item) {
  RR.sub = { kind: item.kind, id: item.id, uri: item.uri, name: item.name, images: item.images || [], date: item.date || '', items: [], offset: 0, more: true, loading: false, err: null, seq: ++RR.seq };
  RR.q = ''; $('rrSearch').value = ''; $('rrBody').scrollTop = 0; rrRender(true);
}
function rrBack() { RR.sub = null; RR.q = ''; $('rrSearch').value = ''; rrRender(true); }
function rrOpen() {
  if (S.demo) return toast('The Record Room needs a connected Spotify account (not available in demo mode).');
  if (!tokens()) return;
  if (RR.open) return;
  if (Date.now() - RR.at > 90000 && !RR.all.running) rrReset();
  RR.open = true; RR.lastFocus = document.activeElement;
  const room = $('room'); room.hidden = false;
  document.body.classList.add('room-open'); $('btnLibrary').setAttribute('aria-expanded', 'true');
  void room.offsetWidth; room.classList.add('open');
  rrHead(); rrSetTab(RR.tab);
  if (RR.saved == null && !RR.liked.loading) { api('GET', '/me/tracks', { query: { limit: 1 } }).then((r) => { if (r.ok && r.data && typeof r.data.total === 'number') { RR.saved = r.data.total; rrHead(); } }).catch(() => {}); }
  if (!RR.plists.items) rrLoadPlaylists().then(rrHead);
  setTimeout(() => { if (RR.open) $('rrClose').focus({ preventScroll: true }); }, 60);
}
function rrClose() {
  if (!RR.open) return;
  RR.open = false; rrDetailClose(true);
  const room = $('room'); room.classList.remove('open', 'rr-playing');
  document.body.classList.remove('room-open'); $('btnLibrary').setAttribute('aria-expanded', 'false');
  setTimeout(() => { if (!RR.open) room.hidden = true; }, 520);
  const f = RR.lastFocus; if (f && f.focus) try { f.focus({ preventScroll: true }); } catch { /* gone */ }
}
function rrDetail(t) {
  RR.detail = t;
  const im = $('rrDArt'); im.src = t.big || t.art || ''; im.alt = t.album ? 'Cover of ' + t.album : ''; im.style.visibility = (t.big || t.art) ? '' : 'hidden';
  $('rrDName').textContent = t.name; $('rrDArtist').textContent = t.artists;
  $('rrDAlbum').textContent = t.album || 'Unknown'; $('rrDDate').textContent = t.date || 'Not provided by Spotify';
  $('rrDLen').textContent = t.dur ? mmss(t.dur) : 'Unknown'; $('rrDNo').textContent = t.no ? '#' + t.no + (t.explicit ? ' · Explicit' : '') : (t.explicit ? 'Explicit' : 'Not provided');
  $('rrDCat').textContent = 'CATALOGUE · ' + String(rrHash(t.id) % 100000).padStart(5, '0');
  const a = $('rrDOpen'); a.hidden = !t.url; if (t.url) a.href = t.url;
  $('rrDetail').hidden = false; void $('rrDetail').offsetWidth; $('rrDetail').classList.add('on');
  rrSync(); $('rrDBack').focus({ preventScroll: true });
}
function rrDetailClose(quick) {
  if (!RR.detail) return false;
  RR.detail = null; const d = $('rrDetail'); d.classList.remove('on');
  if (quick) d.hidden = true; else setTimeout(() => { if (!RR.detail) d.hidden = true; }, 300);
  return true;
}
function rrEscape() { if (!RR.open) return false; if (!rrDetailClose()) rrClose(); return true; }
function bindRoom() {
  if (!$('room') || !$('rrNow')) { console.warn('NEEDLE: index.html is out of date (no Record Room markup). Upload every file from the zip.'); const b = $('btnLibrary'); if (b) b.hidden = true; return; }   // never let a half-uploaded site break the player
  $('btnLibrary').onclick = () => (RR.open ? rrClose() : rrOpen());
  $('rrClose').onclick = rrClose; $('rrScrim').onclick = rrClose;
  $('rrTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) rrSetTab(b.dataset.tab); });
  $('rrTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const t = Array.from($('rrTabs').children), i = t.findIndex((b) => b.getAttribute('aria-selected') === 'true'), n = t[(i + (e.key === 'ArrowRight' ? 1 : t.length - 1)) % t.length];
    n.focus(); rrSetTab(n.dataset.tab); e.stopPropagation();
  });
  $('rrBack').onclick = rrBack;
  $('rrPlayAll').onclick = () => rrLaunch($('rrPlayAll'), null, () => rrPlayAll(false), rrCrumbInfo()); $('rrShuffle').onclick = () => rrLaunch($('rrShuffle'), null, () => rrPlayAll(true), rrCrumbInfo());
  $('rrSearchBtn').onclick = () => {
    const row = $('rrSearchRow'), show = row.hidden; row.hidden = !show; $('rrSearchBtn').setAttribute('aria-expanded', show);
    if (show) $('rrSearch').focus(); else { $('rrSearch').value = ''; RR.q = ''; rrRender(true); }
  };
  let raf = 0;
  $('rrSearch').addEventListener('input', () => { RR.q = $('rrSearch').value; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { $('rrBody').scrollTop = 0; rrRender(true); }); });
  $('rrSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if ($('rrSearch').value) { $('rrSearch').value = ''; RR.q = ''; rrRender(true); } else $('rrSearchBtn').click(); } });
  $('rrBody').addEventListener('scroll', () => { const b = $('rrBody'); if (b.scrollTop + b.clientHeight > b.scrollHeight - 420) rrMore(); }, { passive: true });
  $('rrDBack').onclick = () => { rrDetailClose(); };
  $('rrDPlay').onclick = () => { const t = RR.detail; if (t) rrLaunch($('rrDArt'), t.id, () => rrPlay(t), t); };
  $('rrNowBtn').onclick = () => control(S.isPlaying ? 'pause' : 'play');
  document.addEventListener('keydown', (e) => {            // keep focus inside the drawer while it is open
    if (e.key !== 'Tab' || !RR.open || !$('devicesModal').hidden) return;
    const root = RR.detail ? $('rrDetail') : $('rrPanel');
    const f = Array.from(root.querySelectorAll('button,a[href],input')).filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // swipe the cabinet front to the right to push it shut
  let sx = 0, sy = 0, dx = 0, drag = false;
  const head = $('rrHead'), panel = $('rrPanel');
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button,input')) return; drag = true; sx = e.clientX; sy = e.clientY; dx = 0; panel.style.transition = 'none'; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; dx = Math.max(0, e.clientX - sx); panel.style.transform = 'translateX(' + dx + 'px)'; });
  const end = () => { if (!drag) return; drag = false; panel.style.transition = ''; panel.style.transform = ''; if (dx > 110) rrClose(); };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
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
  if (WAIT.ctx) { const c = WAIT.ctx; WAIT.ctx = null; return playBody(c.body, c.name, d.id, c.shuffle); }   // a playlist is waiting for a device
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
const FS_HINT = 'For true full screen on iPhone: tap Share, then Add to Home Screen, and open NEEDLE from the Home Screen.';
function setViewportVars() {                                 // size the scene from the real visible area (fixes stale units on iOS and after fullscreen)
  const vv = window.visualViewport, w = (vv && vv.width) || innerWidth, h = (vv && vv.height) || innerHeight;
  const r = document.documentElement.style; r.setProperty('--vw', (w / 100) + 'px'); r.setProperty('--vh', (h / 100) + 'px');
}
function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return toast(FS_HINT);
  try { const r = req.call(el); if (r && r.catch) r.catch(() => toast(FS_HINT)); } catch { toast(FS_HINT); }
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
const demoLrc = (lines) => lines.map((text, i) => ({ t: i * 4000, text }));
const DEMO = [
  { id: 'd1', title: 'Golden Hour Static', artists: 'The Velvet Meridian', album: 'Amber Rooms', art: demoArt(28, 12, 0), duration: 34000,
    lrc: demoLrc(['', 'Light comes through the amber glass', 'Dust is dancing, let it pass', 'Every groove a little tide', 'Carrying me to your side', '', 'Spin it slow, spin it low', 'Let the golden static glow', 'Spin it slow, spin it low']) },
  { id: 'd2', title: 'Slow Tide Letters', artists: 'Marlowe & Pine, Ines Calder', album: 'Paper Lanterns', art: demoArt(205, 250, 1), duration: 34000,
    lrc: demoLrc(['', 'Paper boats on a slow tide', 'Letters folded, side by side', 'Nobody reads them till they land', 'Salt and ink on every hand', '', 'Carry them home, carry them far', 'Underneath a single star', 'Carry them home']) },
  { id: 'd3', title: 'Needle Drop', artists: 'Odd Season Choir', album: 'Low Light Sessions', art: demoArt(340, 20, 2), duration: 34000,
    lrc: demoLrc(['', 'Lower the needle, hold your breath', 'Crackle first, then a quiet depth', 'Voices rise from the black', 'Nothing here is turning back', '', 'Needle drop, needle drop', 'Hear the whole room stop', 'Needle drop']) },
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
/* =====================================================================
   Turntable gestures
   - Tonearm: tap it, or drag it on/off the record, to play / pause.
   - Record: turn it by hand to rewind (anticlockwise) or fast-forward (clockwise).
   Nothing is faked: the arm and the time only stay put if Spotify accepts the command.
   ===================================================================== */
const SCRUB_MS_PER_TURN = 30000;      // one full turn of the record = 30 seconds
const ARM_ON_DEG = 12;                // dragged past this angle counts as "on the record"
/* =====================================================================
   Play audio inside NEEDLE (Spotify Web Playback SDK, Premium only).
   NEEDLE registers this browser tab as a Spotify device called "NEEDLE".
   Everything else (play, pause, seek, playlists) keeps using the normal Web API.
   ===================================================================== */
const LOCAL = { player: null, id: null, loading: false, err: '', tapped: false, activated: false, t: 0 };
function localWanted() { return store.get(K.local) !== '0'; }
function updateLocalUi() {
  const el = $('localStatus'); if (!el) return;
  el.textContent = !localWanted() ? 'Off. Audio plays on the device you pick below.'
    : LOCAL.err ? LOCAL.err
    : LOCAL.id ? 'Ready. Pick a song and it plays right here. Spotify does not need to be open. Keep this page open while listening.'
    : S.demo ? 'Not available in demo mode.' : 'Starting…';
}
function localFail(msg) { LOCAL.err = msg; LOCAL.loading = false; updateLocalUi(); toast(msg, true); }
function startLocalPlayer() {
  if (S.demo || LOCAL.player || LOCAL.loading || !localWanted() || !tokens()) return updateLocalUi();
  LOCAL.loading = true; LOCAL.err = ''; updateLocalUi();
  window.onSpotifyWebPlaybackSDKReady = initLocalPlayer;
  if (window.Spotify) return initLocalPlayer();
  if (document.getElementById('sdkScript')) return;
  const s = document.createElement('script');
  s.id = 'sdkScript'; s.src = 'https://sdk.scdn.co/spotify-player.js'; s.async = true;
  s.onerror = () => { LOCAL.loading = false; LOCAL.err = 'Couldn’t load Spotify’s player (check your connection or ad blocker).'; updateLocalUi(); };
  document.head.appendChild(s);
}
function initLocalPlayer() {
  if (LOCAL.player || !localWanted()) { LOCAL.loading = false; return; }
  const p = new Spotify.Player({ name: 'NEEDLE', volume: 0.85, getOAuthToken: (cb) => { getToken().then(cb).catch(() => {}); } });
  p.addListener('ready', ({ device_id }) => { LOCAL.id = device_id; LOCAL.loading = false; LOCAL.err = ''; updateLocalUi(); setTimeout(poll, 300); });
  p.addListener('not_ready', () => { LOCAL.id = null; updateLocalUi(); });
  p.addListener('initialization_error', ({ message }) => localFail('This browser can’t play Spotify audio itself (' + message + '). Audio will play on the device you pick.'));
  p.addListener('authentication_error', () => localFail('Spotify rejected the login for in-browser playback. Disconnect and reconnect Spotify.'));
  p.addListener('account_error', () => localFail('Playing audio in the browser needs Spotify Premium.'));
  p.addListener('playback_error', ({ message }) => toast('Playback problem: ' + message, true));
  p.addListener('player_state_changed', () => { clearTimeout(LOCAL.t); LOCAL.t = setTimeout(poll, 150); });
  LOCAL.player = p;
  p.connect().then((ok) => { if (!ok && !LOCAL.err) localFail('Couldn’t start in-browser playback. Audio will play on the device you pick.'); });
}
function stopLocalPlayer() {
  try { if (LOCAL.player) LOCAL.player.disconnect(); } catch { /* ignore */ }
  LOCAL.player = null; LOCAL.id = null; LOCAL.loading = false; LOCAL.err = ''; updateLocalUi();
}
function activateLocal() {                                  // iOS Safari only allows audio if this runs inside a tap
  try { if (LOCAL.player && LOCAL.player.activateElement) LOCAL.player.activateElement(); } catch { /* ignore */ }
}
function expectPlaying() {                                  // if Spotify says "ok" but nothing starts, say so instead of silently flipping back
  const t = S.expectAt = performance.now();
  setTimeout(() => {
    if (S.expectAt !== t || S.isPlaying || S.demo) return;
    S.expectAt = 0;
    const here = LOCAL.id && S.device && S.device.id === LOCAL.id;
    toast(here ? 'Safari didn’t start the audio. Tap the screen once, then press play again. If it keeps failing, switch off “Play audio in this browser” in the device picker and choose another device.'
               : 'Spotify accepted play but nothing started. Check that the chosen device is awake, or pick another one.', true);
  }, 4500);
}
function bindLocal() {
  const chk = $('chkLocal'); chk.checked = localWanted();
  chk.onchange = () => {
    store.set(K.local, chk.checked ? '1' : '0');
    if (chk.checked) startLocalPlayer(); else stopLocalPlayer();
    updateLocalUi();
  };
  for (const ev of ['click', 'pointerup', 'touchend']) document.addEventListener(ev, () => { activateLocal(); sfxUnlock(); }, { capture: true, passive: true });
  SFX.on = store.get(K.sfx) !== '0';
  $('btnSfx').classList.toggle('on', SFX.on); $('btnSfx').classList.toggle('off', !SFX.on); $('btnSfx').setAttribute('aria-pressed', String(SFX.on));
  $('btnSfx').onclick = () => setSfx(!SFX.on);
  updateLocalUi();
}

/* =====================================================================
   Vinyl scratch sounds while you turn the record by hand.
   Synthesised in the page with Web Audio (no audio files). It cannot touch Spotify's
   own audio, so it is the *sound of the record being moved*: rubbing noise + a pitched
   whirr that follow how fast you turn, brighter going forward and darker going back,
   with surface crackle and a soft thump when you let go.
   ===================================================================== */
/* SFX-START */
function makeSfx(ctx) {
  const sr = ctx.sampleRate;
  const nb = ctx.createBuffer(1, sr * 2, sr), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const cb = ctx.createBuffer(1, sr * 2, sr), cd = cb.getChannelData(0);
  for (let i = 0; i < cd.length; i++) {
    cd[i] = (Math.random() * 2 - 1) * 0.02;                                   // faint hiss
    if (Math.random() < 0.0007) {                                              // a pop or crackle
      const amp = (0.4 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1);
      for (let k = 0; k < 40 && i + k < cd.length; k++) cd[i + k] += amp * Math.exp(-k / 6);
    }
  }
  const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filt = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
  const master = gain(0.8), comp = ctx.createDynamicsCompressor();
  master.connect(comp); comp.connect(ctx.destination);
  const gN = gain(0), bp = filt('bandpass', 800, 1.6);                         // rubbing / swish
  loop(nb).connect(bp); bp.connect(gN); gN.connect(master);
  const gS = gain(0), lp = filt('lowpass', 900), osc = ctx.createOscillator(); // pitched whirr
  osc.type = 'sawtooth'; osc.frequency.value = 80; osc.connect(lp); lp.connect(gS); gS.connect(master); osc.start();
  const gC = gain(0), hp = filt('highpass', 700), cr = loop(cb);               // surface crackle
  cr.connect(hp); hp.connect(gC); gC.connect(master);
  const T = (p, v, tc) => p.setTargetAtTime(v, ctx.currentTime, tc);
  return {
    set(vel) {                                                                 // vel: degrees/second, + = forward
      const n = Math.min(1, Math.abs(vel) / 900), fwd = vel >= 0, g = Math.pow(n, 0.6);
      T(gN.gain, g * 0.9, 0.02); T(bp.frequency, fwd ? 500 + n * 3500 : 300 + n * 2000, 0.02);
      T(osc.frequency, fwd ? 70 + n * 520 : 55 + n * 330, 0.03); T(gS.gain, g * 0.18, 0.03);
      T(cr.playbackRate, 0.5 + n * 2.8, 0.03); T(gC.gain, 0.05 + n * 0.65, 0.03);
    },
    stop() {                                                                   // fade out + soft needle thump
      T(gN.gain, 0, 0.03); T(gS.gain, 0, 0.03); T(gC.gain, 0, 0.05);
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.2);
    },
  };
}
/* SFX-END */
const SFX = { ctx: null, fx: null, on: true, vel: 0, t: 0, run: false };
function sfxUnlock() {                                       // iOS only allows audio contexts to start from a tap
  if (!SFX.on) return;
  try {
    if (!SFX.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { SFX.on = false; return; } SFX.ctx = new AC(); SFX.fx = makeSfx(SFX.ctx); }
    if (SFX.ctx.state === 'suspended') SFX.ctx.resume();
  } catch { SFX.on = false; }
}
function sfxStart() { if (!SFX.on || !SFX.fx) return; SFX.run = true; SFX.vel = 0; SFX.t = performance.now(); sfxFrame(); }
function sfxFrame() {
  requestAnimationFrame(() => {
    if (!SFX.run) return;
    if (performance.now() - SFX.t > 70) SFX.vel *= 0.78;     // finger stopped: the sound dies away
    if (SFX.fx && SFX.ctx.state === 'running') SFX.fx.set(SFX.vel);
    sfxFrame();
  });
}
function sfxStop() {
  if (!SFX.run) return;
  SFX.run = false; SFX.vel = 0;
  if (SFX.fx && SFX.ctx.state === 'running') SFX.fx.stop();
}
function setSfx(on) {
  SFX.on = on; store.set(K.sfx, on ? '1' : '0');
  const b = $('btnSfx'); b.classList.toggle('on', on); b.classList.toggle('off', !on); b.setAttribute('aria-pressed', String(on));
  if (on) sfxUnlock(); else sfxStop();
  toast(on ? 'Vinyl sounds on' : 'Vinyl sounds off');
}

/* While the record is being turned by hand the song itself is silenced (paused), so only the
   vinyl sounds are heard. It resumes from the new position when you let go. iOS ignores volume
   changes from web pages, so this pauses instead of lowering the volume. */
const MUTE = { on: false, local: false, p: null, retried: false };
const isLocalActive = () => !!(LOCAL.player && LOCAL.id && S.device && (S.device.id === LOCAL.id || S.device.name === 'NEEDLE'));
async function musicPause() {
  if (isLocalActive()) { try { await LOCAL.player.pause(); return; } catch { /* fall back to the Web API */ } }
  const r = await api('PUT', '/me/player/pause');
  if (!r.ok && r.status !== 403) toast(explain(r), true);     // 403 = already paused
}
function musicHush() {
  if (S.demo || !S.isPlaying || MUTE.on) return;
  MUTE.on = true; MUTE.retried = false; MUTE.local = isLocalActive();
  $('deviceCap').textContent = 'Scrubbing · song paused';
  renderArm();                                              // lift the tonearm off the record
  MUTE.p = musicPause().catch(() => {});
}
async function musicUnhush() {
  if (!MUTE.on) return;
  try {
    await MUTE.p;
    let done = false;
    if (MUTE.local) { try { await LOCAL.player.resume(); done = true; } catch { /* fall back below */ } }
    if (!done) { const r = await api('PUT', '/me/player/play'); if (!r.ok) toast(explain(r), true); }
  } catch { toast('Couldn’t resume the music. Press play.', true); }
  finally { MUTE.on = false; renderPlaying(); setTimeout(poll, 400); }
}
function stageGeom() {
  const st = $('stage'), r = st.getBoundingClientRect(), cs = getComputedStyle(st);
  const v = (n) => parseFloat(cs.getPropertyValue(n)), u = r.width / (v('--sw') || 4);
  return { px: r.left + u * v('--px'), py: r.top + u * v('--py'), cx: r.left + u * v('--vcx'), cy: r.top + u * v('--vcy') };
}
async function armSet(on) {
  if (on === S.isPlaying) return renderArm();
  if (on) S.armDown = true; else S.lifted = true;
  renderArm();
  await control(on ? 'play' : 'pause');
  S.armDown = false; S.lifted = false; renderArm();
}
function bindTurntable() {
  const arm = $('tonearm'), rec = $('record');
  let drag = null, sc = null;

  arm.addEventListener('pointerdown', (e) => {
    if (S.lifted && !S.armDown) return;
    e.preventDefault(); arm.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, ang: 0 };
  });
  arm.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.moved = true; S.armDrag = true; arm.classList.add('drag');
    }
    const g = stageGeom();
    drag.ang = Math.max(0, Math.min(40, Math.atan2(-(e.clientX - g.px), e.clientY - g.py) * 180 / Math.PI));
    $('stage').style.setProperty('--arm-angle', drag.ang.toFixed(1) + 'deg');
  });
  const armEnd = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    S.armDrag = false; arm.classList.remove('drag');
    if (!d.moved) armSet(!S.isPlaying);                    // simple tap toggles
    else armSet(d.ang >= ARM_ON_DEG);
  };
  arm.addEventListener('pointerup', armEnd);
  arm.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; S.armDrag = false; arm.classList.remove('drag'); renderArm(); } });

  const ang = (e, g) => Math.atan2(e.clientY - g.cy, e.clientX - g.cx);
  rec.addEventListener('pointerdown', (e) => {
    if (!S.duration || S.lifted) return;
    if (sc) { sc = null; S.scrub = null; document.body.classList.remove('scrubbing'); sfxStop(); musicUnhush(); }   // recover from a lost touch
    sfxUnlock();
    const g = stageGeom();
    sc = { id: e.pointerId, g, last: ang(e, g), x: e.clientX, y: e.clientY, start: curProgress(), acc: 0, moved: false, t: performance.now() };
    rec.setPointerCapture(e.pointerId);
  });
  rec.addEventListener('pointermove', (e) => {
    if (!sc || e.pointerId !== sc.id) return;
    if (!sc.moved) {
      if (Math.hypot(e.clientX - sc.x, e.clientY - sc.y) < 3) return;
      sc.moved = true; document.body.classList.add('scrubbing'); sfxStart(); musicHush(); renderArm();
    }
    const a = ang(e, sc.g); let d = a - sc.last; sc.last = a;
    if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    const deg = d * 180 / Math.PI;
    const now = performance.now(), dt = Math.max(8, now - sc.t); sc.t = now; SFX.t = now;
    SFX.vel = SFX.vel * 0.6 + (deg / dt * 1000) * 0.4;      // smoothed turning speed for the sound
    S.discRot += deg; $('disc').style.rotate = S.discRot.toFixed(2) + 'deg';   // the vinyl follows your finger
    S.scrub = Math.max(0, Math.min(Math.max(0, S.duration - 1000), sc.start + sc.acc + deg / 360 * SCRUB_MS_PER_TURN));
    sc.acc = S.scrub - sc.start;
    tick(true); lyTick(false);
  });
  const recEnd = async (e) => {
    if (!sc || e.pointerId !== sc.id) return;
    const s = sc; sc = null;
    document.body.classList.remove('scrubbing'); sfxStop();
    if (!s.moved) return;
    await seek(Math.round(S.scrub));                       // keeps showing the new time until Spotify answers
    await musicUnhush();                                   // song comes back from the new spot
    S.syncedAt = performance.now(); S.scrub = null; tick(true); lyTick(true);
  };
  rec.addEventListener('pointerup', recEnd);
  rec.addEventListener('pointercancel', (e) => { if (sc && e.pointerId === sc.id) { sc = null; S.scrub = null; document.body.classList.remove('scrubbing'); sfxStop(); tick(true); musicUnhush(); } });
}

function bind() {
  $('btnPlay').onclick = () => control(S.isPlaying ? 'pause' : 'play');
  $('btnPrev').onclick = () => control('prev');
  $('btnNext').onclick = () => control('next');
  $('bar').addEventListener('click', (e) => {
    const r = $('bar').getBoundingClientRect();
    seek(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * S.duration));
  });
  $('btnDevices').onclick = openDevices;
  $('btnLyrics').onclick = () => setLyrics(!S.lyricsOn);
  $('lyLines').addEventListener('click', (e) => {          // tap a synced line to jump there
    const el = e.target.closest('.ly-line');
    if (!el || !LY.lines || el.dataset.i == null) return;
    const b = document.body;
    if (b.classList.contains('ambient') && !b.classList.contains('peek')) return;   // first tap only wakes the UI
    const t = LY.lines[+el.dataset.i].t;
    lyFollow();
    seek(t).then(() => { if (!S.isPlaying && S.duration) control('play'); });         // start playing from this line
  });
  const lyScroll = $('lyScroll');
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) lyScroll.addEventListener(ev, lyUser, { passive: true });
  lyScroll.addEventListener('scroll', () => { if (LY.manual) { clearTimeout(LY.mt); LY.mt = setTimeout(lyFollow, 5000); } }, { passive: true });
  $('lyNow').onclick = lyFollow;
  $('lyFix').onclick = openLyPick;
  $('btnLyPickClose').onclick = closeLyPick;
  let lyQT = 0; $('lyPickQ').addEventListener('input', () => { clearTimeout(lyQT); lyQT = setTimeout(runLyPick, 400); });
  setInterval(() => { if (!document.hidden) lyTick(false); }, 200);
  $('btnDevicesClose').onclick = () => { $('devicesModal').hidden = true; WAIT.ctx = null; };
  bindRoom();
  if ($('btnTheme')) $('btnTheme').onclick = toggleTheme;
  { const mq = matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener('change', applyTheme) : mq.addListener(applyTheme)); }
  $('btnQueue').onclick = openQueue;
  $('btnQueueClose').onclick = closeQueue;
  bindTurntable(); bindLocal();
  $('btnAmbient').onclick = () => setAmbient(!document.body.classList.contains('ambient'));
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
  if (standalone) $('btnFull').hidden = true; else $('btnFull').onclick = toggleFullscreen;   // already full screen when launched from the Home Screen
  setViewportVars();
  for (const ev of ['resize', 'orientationchange', 'fullscreenchange', 'webkitfullscreenchange']) addEventListener(ev, () => { setViewportVars(); setTimeout(setViewportVars, 250); if (S.lyricsOn) lyCenter(true); });
  document.addEventListener('fullscreenchange', () => { setViewportVars(); renderArm(); });
  document.addEventListener('webkitfullscreenchange', () => { setViewportVars(); renderArm(); });
  if (window.visualViewport) visualViewport.addEventListener('resize', setViewportVars);
  $('btnLogout').onclick = () => {
    store.del(K.tokens); stopLocalPlayer(); closeQueue(); Q.now = null; Q.items = []; rrClose(); rrReset(); S.isPlaying = false; S.trackId = null; S.track = null; clearTimeout(pollTimer);
    lySeq++; LY.id = null; lyClear();
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
    if (RR.open && e.key !== 'Escape' && e.key !== 'p' && e.key !== 'P') return;   // the Record Room is modal: its own buttons handle keys
    if (e.code === 'Space') { e.preventDefault(); control(S.isPlaying ? 'pause' : 'play'); }
    else if (e.key === 'q' || e.key === 'Q') openQueue();
    else if (e.key === 'Escape') { if (!$('devicesModal').hidden || !$('queueModal').hidden || !$('lyPickModal').hidden) { closeLyPick(); closeQueue(); $('devicesModal').hidden = true; WAIT.ctx = null; } else if (!rrEscape()) { /* nothing open */ } }
    else if (e.key === 'p' || e.key === 'P') (RR.open ? rrClose() : rrOpen());
    else if (e.key === 's' || e.key === 'S') setSfx(!SFX.on);
    else if (e.key === 'ArrowRight') control('next');
    else if (e.key === 'ArrowLeft') control('prev');
    else if (e.key === 'l' || e.key === 'L') setLyrics(!S.lyricsOn);
    else if (e.key === 'a' || e.key === 'A')setAmbient(!document.body.classList.contains('ambient'));
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
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
  if (store.get(K.lyrics) === '1') setLyrics(true);
  applyTheme();
  setLabel({ title: 'NEEDLE', artists: 'Connect · Play · Spin', album: '' });
  if (new URLSearchParams(location.search).has('demo')) return startDemo();
  try { await handleCallback(); }
  catch (e) { return showGate({ error: e.message }); }
  if (!tokens()) return showGate({});
  if (!hasScopes()) return showGate({ error: 'NEEDLE has new features that need extra Spotify permission (playlists, songs and playing audio in the browser). Please reconnect Spotify once to allow that.' });
  hideGate(); poll(); startLocalPlayer();
}
init();
})();
