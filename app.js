(() => {
'use strict';

/* =====================================================================
   NEEDLE — Spotify vinyl player
   Auth: Authorization Code + PKCE (no client secret, no backend).
   Scopes: user-read-playback-state, user-modify-playback-state.
   ===================================================================== */

const CFG = Object.assign({ CLIENT_ID: '', POLL_PLAYING_MS: 3000, POLL_PAUSED_MS: 6000 }, window.NEEDLE_CONFIG || {});
const NEED_SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'streaming', 'user-read-email', 'user-read-private'];
const SCOPES = NEED_SCOPES.join(' ');
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const K = { tokens: 'needle.tokens', verifier: 'needle.verifier', state: 'needle.state', cid: 'needle.clientId', ambient: 'needle.ambient', lyrics: 'needle.lyrics', local: 'needle.local', sfx: 'needle.sfx' };

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
    episode: ep,
  };
}
function applyPlayer(p) {
  if (!p.item) return setIdle();
  const t = normalize(p.item);
  S.device = p.device || null;
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
    { label: 'Your playlists', fn: openLibrary },
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
  if (S.armDrag) return;
  const [a, b] = armRange();
  const frac = S.duration ? Math.min(1, curProgress() / S.duration) : 0;
  const armUp = MUTE.on || (S.demo && document.body.classList.contains('scrubbing'));   // arm lifts while the song is paused for scrubbing
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
  lyOnTrack(t);
  if (Q.open) loadQueue();
  setSleeve(loaded ? t.art : null, loaded ? loaded.cors : false);
  setBackground(loaded && loaded.cors ? paletteFrom(loaded.img) : null);
  if (!first) {
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
    .replace(/\s*[(\[][^)\]]*(feat|ft\.|with |remaster|live|version|edit|mono|stereo)[^)\]]*[)\]]/ig, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live|single).*$/i, '').trim();
  return c || s;
}
async function lrc(path, params) {
  const url = new URL(LRC_API + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error('lrclib ' + res.status);
  return res.json();
}
function pickBest(list, secs) {
  if (!Array.isArray(list)) return null;
  const ok = list.filter((r) => r && (r.instrumental || r.syncedLyrics || r.plainLyrics) && (!secs || !r.duration || Math.abs(r.duration - secs) <= 6));
  ok.sort((a, b) => ((a.syncedLyrics ? 0 : 1) - (b.syncedLyrics ? 0 : 1)) || (Math.abs((a.duration || 0) - secs) - Math.abs((b.duration || 0) - secs)));
  return ok[0] || null;
}
function lyResult(rec) {
  if (!rec) return { none: true };
  if (rec.instrumental) return { instrumental: true };
  const synced = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
  if (synced.length) return { synced };
  if (rec.plainLyrics && rec.plainLyrics.trim()) return { plain: rec.plainLyrics };
  return { none: true };
}
async function fetchLyrics(t) {
  if (t.lrc) return { synced: t.lrc, demo: true };
  if (t.episode) return { none: true, podcast: true };
  const secs = Math.round(t.duration / 1000);
  let rec = await lrc('/get', { track_name: t.title, artist_name: t.artist1, album_name: t.album, duration: secs });
  if (!rec) {
    const ct = cleanTitle(t.title);
    let list = await lrc('/search', { track_name: ct, artist_name: t.artist1 });
    if (!Array.isArray(list) || !list.length) list = await lrc('/search', { q: (ct + ' ' + t.artist1).trim() });
    rec = pickBest(list, secs);
  }
  return lyResult(rec);
}

function lyStatus(msg, loading) {
  const el = $('lyStatus'); el.textContent = msg || '';
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
  if (res.none) return lyStatus(res.podcast ? 'No lyrics for podcasts' : 'No lyrics found for this track');
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
  $('lyCredit').textContent = res.demo ? 'Demo lyrics · invented' : (res.synced ? 'LRCLIB' : 'LRCLIB · not synced');
}
async function lyLoad(t) {
  const my = ++lySeq;
  LY.id = t.id; lyClear();
  const cached = lyCache.get(t.id);
  if (cached) return lyShow(cached);
  lyStatus('Finding lyrics…', true);
  try {
    const res = await fetchLyrics(t);
    if (my !== lySeq) return;
    lyCache.set(t.id, res); lyShow(res);
  } catch {
    if (my !== lySeq) return;
    LY.id = null;                              // allow a retry by toggling lyrics
    lyStatus('Couldn’t load lyrics. Toggle lyrics off and on to retry.');
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
    if (r.status === 404) showNotice(explain(r), [{ label: 'Your playlists', fn: openLibrary }, { label: 'Choose device', fn: openDevices }]);
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

/* ---------- library: browse your playlists and start one ---------- */
const PL = { list: null, at: 0, ctx: null, view: 'list', src: null, tracks: [], offset: 0, more: false, loading: false, seq: 0 };
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
function libMsg(text, reconnect) {
  const list = $('plList'); list.innerHTML = '';
  const li = document.createElement('li'); li.className = 'empty'; li.textContent = text;
  if (reconnect) { const b = document.createElement('button'); b.className = 'mini'; b.textContent = 'Reconnect Spotify'; b.onclick = login; li.appendChild(document.createElement('br')); li.appendChild(b); }
  list.appendChild(li);
}
async function openLibrary() {
  if (S.demo) return toast('Playlists are not available in demo mode.');
  $('libModal').hidden = false; $('libSearch').value = '';
  showListView();
  if (PL.list) renderPlaylists(); else libMsg('Loading your playlists…');
  if (PL.list && Date.now() - PL.at < 60000) return;
  try {
    const r = await fetchPlaylists();
    if (r.error) {
      const forbidden = r.error.status === 403 || r.error.status === 401;
      if (!PL.list) libMsg(forbidden ? 'NEEDLE needs permission to read your playlists. Reconnect Spotify once to allow it.' : explain(r.error), forbidden);
      return;
    }
    PL.list = r.items; PL.at = Date.now(); renderPlaylists();
  } catch (e) {
    if (e instanceof AuthError) { $('libModal').hidden = true; showGate({ error: e.message }); }
    else if (!PL.list) libMsg('Could not load playlists. Check your connection and try again.');
  }
}
function renderPlaylists() {
  const q = $('libSearch').value.trim().toLowerCase(), list = $('plList'); list.innerHTML = '';
  const add = (img, name, sub, fn) => {
    const li = document.createElement('li'), b = document.createElement('button'), meta = document.createElement('span');
    meta.className = 'pl-meta';
    const n = document.createElement('span'); n.className = 'pl-name'; n.textContent = name;
    const s = document.createElement('span'); s.className = 'pl-sub'; s.textContent = sub;
    meta.append(n, s); b.append(img, meta); b.onclick = fn; li.appendChild(b); list.appendChild(li);
  };
  if (!q || 'liked songs'.includes(q)) {
    const d = document.createElement('span'); d.className = 'pl-img liked';
    d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 2.9 5 6.3 5c2 0 3.5 1.1 4.2 2.4h3C14.2 6.1 15.7 5 17.7 5c3.4 0 5.3 3.6 3.9 6.8C19.5 16.4 12 21 12 21z"/></svg>';
    add(d, 'Liked Songs', 'Your saved tracks', () => openTracks({ kind: 'liked', name: 'Liked Songs' }));
  }
  const items = (PL.list || []).filter((p) => !q || (p.name || '').toLowerCase().includes(q) || ((p.owner && p.owner.display_name) || '').toLowerCase().includes(q));
  for (const p of items) {
    const img = document.createElement('img'); img.className = 'pl-img'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const u = p.images && p.images.length ? (p.images[p.images.length - 1].url) : null;
    if (u) img.src = u;
    const total = (p.items && p.items.total) ?? (p.tracks && p.tracks.total);
    const parts = []; if (typeof total === 'number') parts.push(total + ' tracks'); if (p.owner && p.owner.display_name) parts.push('by ' + p.owner.display_name);
    add(img, p.name || 'Untitled playlist', parts.join(' · '), () => openTracks({ kind: 'playlist', id: p.id, uri: p.uri, name: p.name || 'Playlist' }));
  }
  if (!list.children.length) libMsg(q ? 'No playlists match “' + q + '”.' : 'No playlists found.');
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

function showListView() {
  PL.view = 'list'; PL.seq++; PL.src = null;
  $('libTitle').textContent = 'Your playlists'; $('btnLibBack').hidden = true;
  $('libSearch').placeholder = 'Search your library'; $('plList').scrollTop = 0;
}
const mmss = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function normTrack(it) {
  const t = it && (it.item || it.track || it);
  if (!t || !t.uri || it.is_local || t.is_local) return null;
  const imgs = (t.album && t.album.images) || t.images || [];
  return {
    uri: t.uri, id: t.id || t.uri.split(':').pop(), name: t.name || 'Unknown',
    artists: t.type === 'episode' ? ((t.show && t.show.name) || '') : (t.artists || []).map((x) => x.name).join(', '),
    img: imgs.length ? imgs[imgs.length - 1].url : null, dur: t.duration_ms || 0,
  };
}
async function openTracks(src) {
  PL.view = 'tracks'; PL.src = src; PL.tracks = []; PL.offset = 0; PL.more = false; PL.error = null; const my = ++PL.seq;
  $('libTitle').textContent = src.name; $('btnLibBack').hidden = false;
  $('libSearch').value = ''; $('libSearch').placeholder = 'Search in ' + src.name; $('plList').scrollTop = 0;
  libMsg('Loading songs…');
  await loadTracks(my);
}
async function loadTracks(my) {
  if (PL.loading) return;
  const src = PL.src; if (!src) return;
  PL.loading = true;
  try {
    let r;
    if (src.kind === 'liked') r = await api('GET', '/me/tracks', { query: { limit: 50, offset: PL.offset } });
    else {
      r = await api('GET', '/playlists/' + src.id + '/items', { query: { limit: 50, offset: PL.offset, additional_types: 'track' } });
      if (!r.ok && (r.status === 404 || r.status === 400)) r = await api('GET', '/playlists/' + src.id + '/tracks', { query: { limit: 50, offset: PL.offset } });
    }
    if (my !== PL.seq) return;
    if (!r.ok) {
      PL.error = { status: r.status, text: (r.status === 403 && src.kind !== 'liked')
        ? 'Spotify doesn’t let NEEDLE read the songs of this playlist (this can happen with playlists you don’t own). You can still play the whole playlist.'
        : r.status === 403 ? 'NEEDLE needs permission to read your saved songs. Reconnect Spotify once to allow it.' : explain(r) };
      PL.more = false;
    } else {
      const items = (r.data && r.data.items) || [];
      PL.tracks.push(...items.map(normTrack).filter(Boolean));
      PL.offset += items.length; PL.more = !!(r.data && r.data.next) && items.length > 0;
    }
    renderTracks();
  } catch (e) {
    if (my !== PL.seq) return;
    if (e instanceof AuthError) { $('libModal').hidden = true; showGate({ error: e.message }); }
    else { PL.error = { text: 'Could not load songs. Check your connection and try again.' }; renderTracks(); }
  } finally { PL.loading = false; }
}
async function loadAllTracks() {                         // so search covers the whole playlist
  const my = PL.seq;
  for (let i = 0; i < 20 && PL.more && my === PL.seq; i++) { await loadTracks(my); await sleep(0); }
}
function renderTracks() {
  const src = PL.src, q = $('libSearch').value.trim().toLowerCase(), list = $('plList'), keep = list.scrollTop;
  list.innerHTML = '';
  const bar = document.createElement('li'); bar.className = 'pl-actions';
  const mkBtn = (label, cls, fn) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; bar.appendChild(b); };
  if (src.kind === 'playlist') {
    mkBtn('▶  Play all', 'primary', () => playBody({ context_uri: src.uri }, src.name));
    mkBtn('⤮  Shuffle', '', () => playBody({ context_uri: src.uri }, src.name, null, true));
  } else if (PL.tracks.length) {
    const uris = () => PL.tracks.slice(0, 100).map((t) => t.uri);
    mkBtn('▶  Play all', 'primary', () => playBody({ uris: uris() }, src.name));
    mkBtn('⤮  Shuffle', '', () => playBody({ uris: uris() }, src.name, null, true));
  }
  if (bar.children.length) list.appendChild(bar);
  const shown = PL.tracks.filter((t) => !q || t.name.toLowerCase().includes(q) || t.artists.toLowerCase().includes(q));
  for (const t of shown) {
    const li = document.createElement('li'); if (t.id === S.trackId) li.className = 'now';
    const b = document.createElement('button'), meta = document.createElement('span'), img = document.createElement('img');
    img.className = 'tr-img'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; if (t.img) img.src = t.img;
    meta.className = 'pl-meta';
    const n = document.createElement('span'); n.className = 'pl-name'; n.textContent = t.name;
    const s = document.createElement('span'); s.className = 'pl-sub'; s.textContent = t.artists;
    meta.append(n, s);
    const d = document.createElement('span'); d.className = 'pl-dur'; d.textContent = t.dur ? mmss(t.dur) : '';
    b.append(img, meta, d); b.onclick = () => playTrack(t); li.appendChild(b); list.appendChild(li);
  }
  if (PL.error) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = PL.error.text;
    if (PL.error.status === 403 && src.kind === 'liked') { const b = document.createElement('button'); b.className = 'mini'; b.textContent = 'Reconnect Spotify'; b.onclick = login; li.append(document.createElement('br'), b); }
    list.appendChild(li); }
  else if (!shown.length && !PL.more) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = q ? 'No songs match “' + q + '”.' : 'This playlist has no songs yet.'; list.appendChild(li); }
  else if (PL.more) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Loading more…'; list.appendChild(li); }
  list.scrollTop = keep;
}
function playTrack(t) {
  const src = PL.src;
  if (src.kind === 'playlist') return playBody({ context_uri: src.uri, offset: { uri: t.uri } }, t.name);
  const i = PL.tracks.indexOf(t), from = Math.max(0, Math.min(i, PL.tracks.length - 100));   // Spotify takes up to 100 URIs
  return playBody({ uris: PL.tracks.slice(from, from + 100).map((x) => x.uri), offset: { uri: t.uri } }, t.name);
}
async function playBody(body, name, deviceId, shuffle) {
  activateLocal();
  try {
    const r = await api('PUT', '/me/player/play', { query: deviceId ? { device_id: deviceId } : undefined, body });
    if (r.ok) {
      PL.ctx = null; $('libModal').hidden = true; $('devicesModal').hidden = true; hideNotice(); toast('Playing ' + name); expectPlaying();
      if (shuffle) api('PUT', '/me/player/shuffle', { query: { state: 'true' } }).catch(() => {});
      setTimeout(poll, 800);
    } else if (r.status === 404 && LOCAL.id && !deviceId) { return playBody(body, name, LOCAL.id, shuffle); }   // no active device: play here
    else if (r.status === 404) { PL.ctx = { body, name, shuffle }; $('libModal').hidden = true; toast('No active device. Pick where to play ' + name + '.', true); openDevices(); }
    else toast(explain(r), true);
  } catch (e) { if (e instanceof AuthError) showGate({ error: e.message }); else toast('Could not reach Spotify.', true); }
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
  if (PL.ctx) { const c = PL.ctx; PL.ctx = null; return playBody(c.body, c.name, d.id, c.shuffle); }   // a playlist is waiting for a device
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
  setInterval(() => { if (!document.hidden) lyTick(false); }, 200);
  $('btnDevicesClose').onclick = () => { $('devicesModal').hidden = true; PL.ctx = null; };
  $('btnLibrary').onclick = openLibrary;
  $('btnQueue').onclick = openQueue;
  $('btnQueueClose').onclick = closeQueue;
  $('btnLibClose').onclick = () => { $('libModal').hidden = true; };
  $('btnLibBack').onclick = () => { showListView(); if (PL.list) renderPlaylists(); };
  $('libSearch').addEventListener('input', () => {
    if (PL.view === 'tracks') { renderTracks(); if ($('libSearch').value && PL.more) loadAllTracks(); }
    else if (PL.list) renderPlaylists();
  });
  $('plList').addEventListener('scroll', () => {
    const l = $('plList');
    if (PL.view === 'tracks' && PL.more && !PL.loading && l.scrollTop + l.clientHeight > l.scrollHeight - 160) loadTracks(PL.seq);
  });
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
    store.del(K.tokens); stopLocalPlayer(); closeQueue(); Q.now = null; Q.items = []; PL.list = null; $('libModal').hidden = true; S.isPlaying = false; S.trackId = null; S.track = null; clearTimeout(pollTimer);
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
    if (e.code === 'Space') { e.preventDefault(); control(S.isPlaying ? 'pause' : 'play'); }
    else if (e.key === 'q' || e.key === 'Q') openQueue();
    else if (e.key === 'Escape') { closeQueue(); $('libModal').hidden = true; $('devicesModal').hidden = true; PL.ctx = null; }
    else if (e.key === 'p' || e.key === 'P') openLibrary();
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
  setBackground(null);
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
