// Shared helpers for student + teacher pages.
export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('kc:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('kc:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('kc:' + k); } catch { /* ignore */ } },
};

export async function api(method, url, body, apiKey, token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  let j = {};
  try { j = await r.json(); } catch { /* non-json */ }
  if (!r.ok) {
    const e = new Error(j.error || `Error ${r.status}`);
    e.code = j.code; e.status = r.status;
    throw e;
  }
  return j;
}

// ---------- recorder: mic -> 16 kHz mono WAV (works on Chrome, Safari/iOS, Firefox) ----------
const MAX_SECS = 85;
export const recorder = {
  ctx: null, stream: null, node: null, src: null, chunks: [], recording: false, rate: 48000, timer: null,
  async init() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    }
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  },
  async start() {
    await this.init();
    this.rate = this.ctx.sampleRate;
    this.chunks = [];
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => { if (this.recording) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.recording = true;
    this.timer = setTimeout(() => document.getElementById('mic')?.click(), MAX_SECS * 1000);
  },
  _teardown() {
    clearTimeout(this.timer);
    this.recording = false;
    try { this.src?.disconnect(); this.node?.disconnect(); } catch { /* ignore */ }
    this.src = this.node = null;
  },
  async stop() {
    if (!this.recording) return null;
    this._teardown();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    return encodeWav(downsample(all, this.rate, 16000), 16000);
  },
  cancel() { if (this.recording) this._teardown(); this.chunks = []; },
};

function downsample(buf, from, to) {
  if (from === to) return buf;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += buf[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- playback ----------
let player = null;
let resolvePlay = null;
export function unlockAudio() {
  if (!player) {
    player = new Audio();
    player.setAttribute('playsinline', '');
  }
  // A silent play inside the user gesture unlocks later programmatic playback on iOS.
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  player.play().catch(() => {});
  try { speechSynthesis.getVoices(); } catch { /* ignore */ }
}

export function playB64(b64) {
  stopAudio();
  if (!player) unlockAudio();
  return new Promise((resolve, reject) => {
    resolvePlay = resolve;
    player.onended = () => { resolvePlay = null; resolve(); };
    player.onerror = () => { resolvePlay = null; reject(new Error('play failed')); };
    player.src = 'data:audio/mpeg;base64,' + b64;
    player.play().catch(reject);
  });
}

export function speakFallback(text) {
  return new Promise((resolve) => {
    try {
      if (!('speechSynthesis' in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-GB';
      u.rate = 0.98;
      const v = speechSynthesis.getVoices().find((x) => /^en(-|_)(GB|US|AU|IN)/i.test(x.lang));
      if (v) u.voice = v;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      setTimeout(resolve, 30000);
    } catch { resolve(); }
  });
}

export function stopAudio() {
  try { player?.pause(); } catch { /* ignore */ }
  if (resolvePlay) { resolvePlay(); resolvePlay = null; }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
}

// ---------- feedback rendering ----------
export function bandBar(label, n, compact = false) {
  const v = Math.max(0, Math.min(6, Number(n) || 0));
  return `<div class="band${compact ? ' compact' : ''}"><span>${esc(label)}</span><div class="bar" role="img" aria-label="${esc(label)} band ${v} of 6"><i class="w${v}"></i></div><b>${v}/6</b></div>`;
}

export function renderFeedback(fb) {
  const it = fb.interaction || {};
  return `
  <div class="card scores">
    <div class="big-score"><b>${esc(fb.overall)}</b><span>/6 overall</span>${fb.cefr ? `<em>≈ CEFR ${esc(fb.cefr)}</em>` : ''}</div>
    ${bandBar('Grammar', fb.grammar)}
    ${bandBar('Vocabulary', fb.vocabulary)}
    ${bandBar('Communicative competence', fb.communicative)}
    ${bandBar('Overall spoken performance', fb.overall)}
    <p>${esc(fb.summary)}</p>
    <p class="hint">AI estimate using the SPM 1119/3 band descriptors, for practice only.</p>
  </div>
  <div class="card">
    <h3>How you interacted with your partner</h3>
    <dl class="inter">
      <dt>Responding to your partner</dt><dd>${esc(it.responding)}</dd>
      <dt>Asking &amp; inviting</dt><dd>${esc(it.asking)}</dd>
      <dt>Developing ideas</dt><dd>${esc(it.developing)}</dd>
      <dt>Negotiating a decision</dt><dd>${esc(it.negotiating)}</dd>
    </dl>
  </div>
  ${fb.strengths?.length ? `<div class="card"><h3>👍 What you did well</h3><ul>${fb.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  ${fb.fixes?.length ? `<div class="card"><h3>✏️ Say it better</h3>${fb.fixes.map((f) => `<div class="fix"><p class="said">“${esc(f.said)}”</p><p class="better">→ ${esc(f.better)}</p><p class="why">${esc(f.why)}</p></div>`).join('')}</div>` : ''}
  ${fb.phrases?.length ? `<div class="card"><h3>💬 Phrases to try next time</h3><ul class="chips">${fb.phrases.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  ${fb.next_goal ? `<div class="card goal"><h3>🎯 Next session goal</h3><p>${esc(fb.next_goal)}</p></div>` : ''}`;
}
