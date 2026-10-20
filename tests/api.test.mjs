// End-to-end API test. Uses the real AI (Workers AI) for a short session.
// Usage: BASE_URL=http://127.0.0.1:8977 INVITE=localtest-invite AUDIO=path/to/16k.wav node tests/api.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8977';
const INVITE = process.env.INVITE || 'localtest-invite';
const AUDIO = process.env.AUDIO;
let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };

async function call(method, path, { body, token, key, headers = {}, form } = {}) {
  const h = { origin: BASE, ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (key) h['x-api-key'] = key;
  let payload;
  if (form) payload = form;
  else if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers: h, body: payload });
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  return { status: r.status, j };
}

const t0 = Date.now();
// config
let r = await call('GET', '/api/config');
assert.equal(r.status, 200); assert.ok(r.j.topics.length >= 25); assert.equal(r.j.personas.length, 4); ok('config lists topics + personas');

// teacher create
r = await call('POST', '/api/teacher/create', { body: { name: 'Test 5A', invite: 'wrong' } });
assert.equal(r.status, 403); ok('wrong invite rejected');
r = await call('POST', '/api/teacher/create', { body: { name: 'Test 5A', invite: INVITE } });
assert.equal(r.status, 200, JSON.stringify(r.j)); assert.match(r.j.code, /^[A-Z0-9]{6}$/);
const { code, teacherKey } = r.j; ok('class created ' + code);
const T = { token: teacherKey, headers: { 'x-class-code': code } };

// cross-site blocked
r = await call('POST', '/api/session/start', { body: { name: 'x', provider: 'class', classCode: code }, headers: { origin: 'https://evil.example' } });
assert.equal(r.status, 403); ok('cross-origin POST blocked');

// class check
r = await call('GET', '/api/class?code=' + code); assert.equal(r.j.ok, true); ok('class code check');
r = await call('GET', '/api/class?code=ZZZZZZ'); assert.equal(r.j.ok, false); ok('unknown class code');

// start validation
r = await call('POST', '/api/session/start', { body: { name: 'Aina', provider: 'class' } });
assert.equal(r.status, 400); ok('class provider needs class code');
r = await call('POST', '/api/session/start', { body: { name: 'Aina', provider: 'gemini' } });
assert.equal(r.status, 400); assert.equal(r.j.code, 'need_key'); ok('BYOK needs a key');

// real session
r = await call('POST', '/api/session/start', { body: { name: 'Aina <b>', provider: 'class', classCode: code, topicId: 'university', persona: 'challenger', level: 'auto' } });
assert.equal(r.status, 200, JSON.stringify(r.j));
const S = r.j; assert.equal(S.topic.id, 'university'); ok(`session started, partner ${S.partner.name}`);

r = await call('GET', '/api/session?id=' + S.sessionId);
assert.equal(r.status, 401); ok('session read needs token');
r = await call('GET', '/api/session?id=' + S.sessionId, { token: 'a'.repeat(48) });
assert.equal(r.status, 404); ok('wrong session token rejected');

let tt = Date.now();
r = await call('POST', '/api/session/turn', { token: S.token, body: { sessionId: S.sessionId, phase: 1, nudge: true } });
assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(r.j.reply.length > 10); assert.ok(r.j.audio && r.j.audio.length > 1000, 'tts audio');
console.log(`    partner opens (${Date.now() - tt} ms): ${r.j.reply}`); ok('partner can open + TTS audio');

tt = Date.now();
r = await call('POST', '/api/session/turn', { token: S.token, body: { sessionId: S.sessionId, phase: 1, text: 'I think fees is most important because many family in Malaysia cannot afford expensive university.' } });
assert.equal(r.status, 200, JSON.stringify(r.j)); console.log(`    typed turn (${Date.now() - tt} ms): ${r.j.reply}`); ok('typed turn');

if (AUDIO && existsSync(AUDIO)) {
  const fd = new FormData();
  fd.append('sessionId', S.sessionId); fd.append('phase', '2');
  fd.append('audio', new Blob([readFileSync(AUDIO)], { type: 'audio/wav' }), 'turn.wav');
  tt = Date.now();
  r = await call('POST', '/api/session/turn', { token: S.token, form: fd });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(r.j.studentText.length > 10);
  console.log(`    voice turn (${Date.now() - tt} ms) heard: "${r.j.studentText}" → ${r.j.reply}`); ok('voice turn: STT + reply + TTS');
}
r = await call('POST', '/api/session/turn', { token: S.token, body: { sessionId: S.sessionId, phase: 3, text: 'No, I think not everyone should go to university, some can go to TVET and get a good job also.' } });
assert.equal(r.status, 200); console.log(`    phase 3: ${r.j.reply}`); ok('phase 3 turn');

r = await call('POST', '/api/session/turn', { token: S.token, body: { sessionId: S.sessionId, phase: 1, text: '' } });
assert.equal(r.status, 400); ok('empty turn rejected');

tt = Date.now();
r = await call('POST', '/api/session/finish', { token: S.token, body: { sessionId: S.sessionId } });
assert.equal(r.status, 200, JSON.stringify(r.j));
const fb = r.j.feedback;
for (const k of ['grammar', 'vocabulary', 'communicative', 'overall']) assert.ok(fb[k] >= 0 && fb[k] <= 6);
assert.ok(fb.fixes.length >= 1 && fb.summary);
console.log(`    feedback (${Date.now() - tt} ms): G${fb.grammar} V${fb.vocabulary} CC${fb.communicative} O${fb.overall} ${fb.cefr} | fix: "${fb.fixes[0]?.said}" → "${fb.fixes[0]?.better}"`);
ok('feedback JSON with bands');

r = await call('POST', '/api/session/turn', { token: S.token, body: { sessionId: S.sessionId, phase: 1, text: 'hello' } });
assert.equal(r.status, 400); ok('finished session closed');

// teacher
r = await call('GET', '/api/teacher/class', { token: 'b'.repeat(48), headers: { 'x-class-code': code } });
assert.equal(r.status, 401); ok('wrong teacher key 401');
r = await call('GET', '/api/teacher/class', T);
assert.equal(r.status, 200); assert.equal(r.j.sessions.length, 1); assert.equal(r.j.sessions[0].student_name, 'Aina b'); assert.equal(r.j.class.usedToday, 1);
ok('teacher sees session (name sanitised)');
r = await call('GET', '/api/teacher/session?id=' + S.sessionId, T);
assert.equal(r.status, 200); assert.ok(r.j.turns.length >= 6); assert.ok(r.j.feedback); ok('teacher sees transcript + feedback');

// quota: 1 per student per day
r = await call('POST', '/api/teacher/settings', { ...T, body: { perStudentDaily: 1 } });
assert.equal(r.status, 200);
r = await call('POST', '/api/session/start', { body: { name: 'aina b', provider: 'class', classCode: code } });
assert.equal(r.status, 429); ok('per-student daily quota enforced');
r = await call('POST', '/api/session/start', { body: { name: 'Ben', provider: 'class', classCode: code } });
assert.equal(r.status, 200); ok('other student still allowed');
const S2 = r.j;
r = await call('POST', '/api/session/finish', { token: S2.token, body: { sessionId: S2.sessionId } });
assert.equal(r.status, 200); assert.equal(r.j.feedback, null); ok('silent session gives no feedback, no AI call');

// close class
r = await call('POST', '/api/teacher/settings', { ...T, body: { open: false } });
r = await call('POST', '/api/session/start', { body: { name: 'Chen', provider: 'class', classCode: code } });
assert.equal(r.status, 400); assert.equal(r.j.code, 'class_closed'); ok('closed class refuses');

// BYOK bad key mapped to friendly error (talks to Google, no charge)
r = await call('POST', '/api/session/start', { key: 'AIza' + 'x'.repeat(35), body: { name: 'Dina', provider: 'gemini', topicId: 'sports' } });
assert.equal(r.status, 200);
r = await call('POST', '/api/session/turn', { key: 'AIza' + 'x'.repeat(35), token: r.j.token, body: { sessionId: r.j.sessionId, phase: 1, text: 'I think sports is good for health.' } });
assert.equal(r.status, 400, JSON.stringify(r.j)); assert.equal(r.j.code, 'bad_key'); assert.ok(!JSON.stringify(r.j).includes('xxxxxxxx')); ok('bad Gemini key → friendly error, key not echoed');

// student delete + teacher delete
r = await call('POST', '/api/session/delete', { token: S2.token, body: { sessionId: S2.sessionId } }); assert.equal(r.status, 200);
r = await call('POST', '/api/teacher/delete', { ...T, body: { id: S.sessionId } }); assert.equal(r.status, 200);
r = await call('GET', '/api/teacher/class', T); assert.equal(r.j.sessions.length, 0); ok('deletes work');

console.log(`\n${pass} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
