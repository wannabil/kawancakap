// Small shared helpers for Pages Functions.

export const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...extra },
  });
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const bad = (msg, code) => new HttpError(400, msg, code);

export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function classCode(len = 6) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish comparison of two hex strings.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Malaysia day key (UTC+8, no DST) for daily quotas.
export function mytDay(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function bytesToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

export function cleanName(s, max = 40) {
  return String(s || '')
    .replace(/[\u0000-\u001f<>"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([a-f0-9]{16,128})$/i);
  return m ? m[1].toLowerCase() : '';
}

// Remove anything that looks like an API key from provider error text before logging/returning it.
export function scrubSecrets(text, key) {
  let t = String(text || '');
  if (key) t = t.split(key).join('[key]');
  return t
    .replace(/sk-[A-Za-z0-9_\-*]{6,}/g, '[key]')
    .replace(/AIza[0-9A-Za-z_\-*]{10,}/g, '[key]')
    .replace(/[A-Za-z0-9_\-]{4,}\*{3,}[A-Za-z0-9_\-]{2,}/g, '[key]')
    .slice(0, 300);
}
