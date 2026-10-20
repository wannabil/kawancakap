// KawanCakap API (Cloudflare Pages Functions, single router).
import { TOPICS, topicById } from '../_lib/topics.js';
import { ensureSchema, takeAll } from '../_lib/db.js';
import {
  PARTNERS, PERSONAS, LEVELS, systemPrompt, OPENER_HINT, cleanReply, chat, transcribe, speak,
  feedbackMessages, parseFeedback, FEEDBACK_SCHEMA, CF_CHAT_MODEL, OPENAI_CHAT_MODEL, GEMINI_CHAT_MODEL,
} from '../_lib/ai.js';
import { json, HttpError, bad, randomToken, classCode, sha256, safeEqual, mytDay, cleanName, bearer } from '../_lib/util.js';

const MAX_AUDIO = 3 * 1024 * 1024; // ~90 s of 16 kHz WAV
const MAX_TURNS = 40; // per session (student + partner turns)
const num = (v, d) => (Number.isFinite(Number(v)) && String(v) !== '' ? Number(v) : d);

function limits(env) {
  return {
    globalSessions: num(env.DAILY_SESSION_CAP, 150), // class-key sessions per day, whole site
    classSessions: num(env.CLASS_DAILY_CAP, 80), // per class per day
    ipSessions: num(env.IP_DAILY_CAP, 12), // per IP per day (class key)
    byokIpSessions: num(env.BYOK_IP_DAILY_CAP, 60),
  };
}

const ip = (request) => request.headers.get('cf-connecting-ip') || '0.0.0.0';

function checkOrigin(request) {
  if (request.method === 'GET') return;
  const o = request.headers.get('origin');
  if (o && o !== new URL(request.url).origin) throw new HttpError(403, 'Bad origin', 'bad_origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Bad origin', 'bad_origin');
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 20000) throw bad('Request too large');
  try {
    return await request.json();
  } catch {
    throw bad('Invalid JSON');
  }
}

function byok(request, provider) {
  if (provider === 'class') return '';
  const key = (request.headers.get('x-api-key') || '').trim();
  if (!key || key.length < 20 || key.length > 300 || /\s/.test(key)) throw new HttpError(400, 'Please paste a valid API key.', 'need_key');
  if (provider === 'openai' && !/^sk-/.test(key)) throw new HttpError(400, 'OpenAI keys start with "sk-".', 'bad_key');
  if (provider === 'gemini' && !/^AIza/.test(key)) throw new HttpError(400, 'Gemini keys start with "AIza".', 'bad_key');
  return key;
}

async function loadSession(env, request, id) {
  const tok = bearer(request);
  if (!id || !tok) throw new HttpError(401, 'Missing session token', 'unauth');
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1').bind(id).first();
  if (!s || !safeEqual(s.token_hash, await sha256(tok))) throw new HttpError(404, 'Session not found', 'not_found');
  return s;
}

async function loadTurns(env, id) {
  const { results } = await env.DB.prepare('SELECT role, phase, text FROM turns WHERE session_id = ?1 ORDER BY id').bind(id).all();
  return results || [];
}

function historyMessages(s, topic, turns, phase) {
  const msgs = [{ role: 'system', content: systemPrompt({ ...s, phase }, topic) }];
  const recent = turns.slice(-24);
  let lastPhase = recent.length ? recent[0].phase : phase;
  for (const t of recent) {
    if (t.phase !== lastPhase) {
      msgs.push({ role: 'user', content: `[Examiner: now phase ${t.phase}]` });
      lastPhase = t.phase;
    }
    msgs.push({ role: t.role === 'student' ? 'user' : 'assistant', content: t.text });
  }
  // Collapse consecutive same-role messages (some providers require alternation).
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') prev.content += '\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

async function partnerReply(env, s, key, topic, turns, phase, nudgeText) {
  const msgs = historyMessages(s, topic, turns, phase);
  if (nudgeText) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user') last.content += '\n' + nudgeText;
    else msgs.push({ role: 'user', content: nudgeText });
  }
  let raw = await chat(env, s.provider, key, msgs, { maxTokens: s.persona === 'talker' ? 160 : 110 });
  let reply = cleanReply(raw);
  if (!reply) reply = "Sorry, I lost my train of thought. What do you think about it?";
  return reply;
}

async function addTurn(env, id, role, phase, text) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO turns (session_id, role, phase, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, role, phase, text, Date.now()),
    env.DB.prepare('UPDATE sessions SET turns = turns + 1 WHERE id = ?1').bind(id),
  ]);
}

// ---------------- handlers ----------------

async function config(env) {
  return json({
    topics: TOPICS.map(({ id, theme, question, ideas }) => ({ id, theme, question, ideas })),
    personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, label: p.label, blurb: p.blurb })),
    levels: Object.keys(LEVELS),
    models: { class: CF_CHAT_MODEL, openai: OPENAI_CHAT_MODEL, gemini: GEMINI_CHAT_MODEL },
    teacherSignup: !!env.TEACHER_INVITE,
  });
}

async function classCheck(env, url) {
  const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return json({ ok: false, error: 'Class codes have 6 letters/numbers.' });
  const c = await env.DB.prepare('SELECT name, open FROM classes WHERE code = ?1').bind(code).first();
  if (!c) return json({ ok: false, error: 'Class code not found.' });
  if (!c.open) return json({ ok: false, error: 'This class is closed by the teacher.' });
  return json({ ok: true, code, name: c.name });
}

async function startSession(env, request) {
  const b = await readJson(request);
  const studentName = cleanName(b.name, 40);
  if (!studentName) throw bad('Please enter your name.', 'need_name');
  const provider = ['class', 'openai', 'gemini'].includes(b.provider) ? b.provider : '';
  if (!provider) throw bad('Choose how to connect the AI.', 'bad_provider');
  const key = byok(request, provider);
  const day = mytDay();
  const L = limits(env);
  const theIp = ip(request);

  let code = null;
  if (b.classCode) {
    code = String(b.classCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const c = await env.DB.prepare('SELECT code, open, per_student_daily FROM classes WHERE code = ?1').bind(code).first();
    if (!c) throw bad('Class code not found.', 'bad_class');
    if (!c.open) throw bad('This class is closed by the teacher.', 'class_closed');
    const studentKey = `stu:${code}:${studentName.toLowerCase()}`;
    if (provider === 'class') {
      const err = await takeAll(env.DB, day, [
        ['global', L.globalSessions, "Today's free practice sessions are used up. Try again tomorrow, or use your own API key."],
        [`class:${code}`, L.classSessions, "Your class has used today's free sessions. Try again tomorrow, or use your own API key."],
        [studentKey, c.per_student_daily, `You've done ${c.per_student_daily} free sessions today. Great effort! Come back tomorrow, or use your own API key.`],
        [`ip:${theIp}`, L.ipSessions, 'Too many sessions from this device today. Try again tomorrow.'],
      ]);
      if (err) throw new HttpError(429, err, 'quota');
    }
  } else if (provider === 'class') {
    throw bad('Enter your class code to use the free class AI, or use your own API key.', 'need_class');
  }
  if (provider !== 'class') {
    const err = await takeAll(env.DB, day, [[`byok:${theIp}`, L.byokIpSessions, 'Too many sessions from this device today.']]);
    if (err) throw new HttpError(429, err, 'quota');
  }

  const topic = b.topicId && b.topicId !== 'random' ? topicById(b.topicId) : TOPICS[Math.floor(Math.random() * TOPICS.length)];
  if (!topic) throw bad('Unknown topic.');
  const persona = PERSONAS[b.persona] ? b.persona : Object.keys(PERSONAS)[Math.floor(Math.random() * 4)];
  const level = LEVELS[b.level] ? b.level : 'auto';
  const partner = PARTNERS[Math.floor(Math.random() * PARTNERS.length)];
  const id = randomToken(10);
  const token = randomToken(24);
  const s = {
    id, token_hash: await sha256(token), class_code: code, student_name: studentName, mode: b.partnerStarts ? 'partner' : 'student',
    provider, topic_id: topic.id, persona, level, partner_name: partner.name, partner_voice: partner.voice, day,
  };
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, class_code, student_name, mode, provider, topic_id, persona, level, partner_name, partner_voice, day, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
  ).bind(s.id, s.token_hash, s.class_code, s.student_name, s.mode, s.provider, s.topic_id, s.persona, s.level, s.partner_name, s.partner_voice, s.day, Date.now()).run();

  return json({
    sessionId: id,
    token,
    partner: { name: partner.name },
    persona: { id: persona, label: PERSONAS[persona].label, blurb: PERSONAS[persona].blurb },
    topic,
    provider,
  });
}

async function turn(env, request) {
  const ctype = request.headers.get('content-type') || '';
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_AUDIO + 4096) throw new HttpError(413, 'That recording is too long. Keep each turn under a minute.', 'too_big');
  let sessionId, phase, typed = '', nudge = false, audio = null, mime = '';
  if (ctype.startsWith('multipart/form-data')) {
    const fd = await request.formData();
    sessionId = String(fd.get('sessionId') || '');
    phase = Number(fd.get('phase'));
    const f = fd.get('audio');
    if (f && typeof f !== 'string') {
      if (f.size > MAX_AUDIO) throw new HttpError(413, 'That recording is too long. Keep each turn under a minute.', 'too_big');
      if (f.size < 2000) throw bad("I couldn't hear anything. Hold the button a bit longer.", 'too_short');
      audio = await f.arrayBuffer();
      mime = f.type || 'audio/wav';
    }
  } else {
    const b = await readJson(request);
    sessionId = String(b.sessionId || '');
    phase = Number(b.phase);
    typed = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    nudge = !!b.nudge;
  }
  if (![1, 2, 3].includes(phase)) throw bad('Bad phase');
  const s = await loadSession(env, request, sessionId);
  if (s.finished_at) throw bad('This session has ended.', 'finished');
  if (s.turns >= MAX_TURNS) throw new HttpError(429, 'This session is long enough. Tap "End & get feedback".', 'max_turns');
  const key = byok(request, s.provider);
  const topic = topicById(s.topic_id);

  let studentText = '';
  if (audio) studentText = await transcribe(env, s.provider, key, audio, mime);
  else studentText = typed;
  studentText = studentText.replace(/\s+/g, ' ').trim().slice(0, 1200);
  // Whisper hallucinates these on silence.
  if (/^(thank you\.?|thanks for watching!?|\.+|you)$/i.test(studentText)) studentText = '';

  const turns = await loadTurns(env, s.id);
  let nudgeText = '';
  if (!studentText) {
    if (!nudge) throw bad("I couldn't hear anything. Try again, a bit closer to the mic.", 'empty');
    nudgeText = turns.length ? `[The student is quiet. Keep the discussion going naturally, then invite them to speak.]` : OPENER_HINT;
    if (turns.length && turns[turns.length - 1].phase !== phase)
      nudgeText = `[Examiner has moved to phase ${phase}. You speak first in this phase, briefly, then invite the student.]`;
  } else {
    await addTurn(env, s.id, 'student', phase, studentText);
    turns.push({ role: 'student', phase, text: studentText });
  }
  const reply = await partnerReply(env, s, key, topic, turns, phase, nudgeText);
  await addTurn(env, s.id, 'partner', phase, reply);
  const partner = PARTNERS.find((p) => p.name === s.partner_name) || PARTNERS[0];
  const audioB64 = await speak(env, s.provider, key, reply, partner);
  return json({ studentText, reply, audio: audioB64 });
}

async function finish(env, request) {
  const b = await readJson(request);
  const s = await loadSession(env, request, String(b.sessionId || ''));
  if (s.feedback) return json({ feedback: JSON.parse(s.feedback) });
  const key = byok(request, s.provider);
  const topic = topicById(s.topic_id);
  const turns = await loadTurns(env, s.id);
  const studentTurns = turns.filter((t) => t.role === 'student');
  if (studentTurns.length === 0) {
    await env.DB.prepare('UPDATE sessions SET finished_at = ?2 WHERE id = ?1').bind(s.id, Date.now()).run();
    return json({ feedback: null, message: 'You did not say anything this time, so there is nothing to mark yet.' });
  }
  const msgs = feedbackMessages(s, topic, turns);
  let fb = null;
  for (let i = 0; i < 2 && !fb; i++) {
    const raw = await chat(env, s.provider, key, msgs, { maxTokens: 1400, json: FEEDBACK_SCHEMA, temperature: 0.2 });
    fb = parseFeedback(raw);
  }
  if (!fb) throw new HttpError(502, 'Could not create feedback right now. Tap "Try again".', 'feedback_failed');
  await env.DB.prepare(
    `UPDATE sessions SET feedback = ?2, band_grammar = ?3, band_vocab = ?4, band_comm = ?5, band_overall = ?6, finished_at = ?7 WHERE id = ?1`
  ).bind(s.id, JSON.stringify(fb), fb.grammar, fb.vocabulary, fb.communicative, fb.overall, Date.now()).run();
  return json({ feedback: fb });
}

async function getSession(env, request, url) {
  const s = await loadSession(env, request, url.searchParams.get('id') || '');
  return json(sessionView(s, await loadTurns(env, s.id)));
}

function sessionView(s, turns) {
  const topic = topicById(s.topic_id);
  return {
    id: s.id, student: s.student_name, classCode: s.class_code, provider: s.provider,
    topic: topic ? { id: topic.id, question: topic.question, ideas: topic.ideas, decision: topic.decision, further: topic.further } : null,
    persona: PERSONAS[s.persona]?.label || s.persona, partner: s.partner_name, level: s.level,
    createdAt: s.created_at, finishedAt: s.finished_at,
    feedback: s.feedback ? JSON.parse(s.feedback) : null,
    turns,
  };
}

// ---------- teacher ----------

async function createClass(env, request) {
  const b = await readJson(request);
  if (!env.TEACHER_INVITE) throw new HttpError(403, 'Teacher sign-up is not open.', 'closed');
  const inv = await sha256(String(b.invite || ''));
  if (!safeEqual(inv, await sha256(env.TEACHER_INVITE))) {
    const err = await takeAll(env.DB, mytDay(), [[`inv:${ip(request)}`, 10, 'Too many tries. Try again tomorrow.']]);
    if (err) throw new HttpError(429, err, 'quota');
    throw new HttpError(403, 'Wrong teacher invite code.', 'bad_invite');
  }
  const name = cleanName(b.name, 60);
  if (!name) throw bad('Give your class a name, e.g. "5 Bestari 2026".');
  const teacherKey = randomToken(24);
  for (let i = 0; i < 5; i++) {
    const code = classCode();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO classes (code, name, teacher_hash, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(code, name, await sha256(teacherKey), Date.now()).run();
    if (r.meta.changes === 1) return json({ code, name, teacherKey });
  }
  throw new HttpError(500, 'Could not create class, try again.');
}

async function loadClass(env, request) {
  const tok = bearer(request);
  const code = (request.headers.get('x-class-code') || '').toUpperCase();
  if (!tok || !code) throw new HttpError(401, 'Missing teacher key', 'unauth');
  const c = await env.DB.prepare('SELECT * FROM classes WHERE code = ?1').bind(code).first();
  if (!c || !safeEqual(c.teacher_hash, await sha256(tok))) throw new HttpError(401, 'Wrong teacher link', 'unauth');
  return c;
}

async function teacherClass(env, request) {
  const c = await loadClass(env, request);
  const { results } = await env.DB.prepare(
    `SELECT id, student_name, topic_id, persona, partner_name, turns, band_grammar, band_vocab, band_comm, band_overall, created_at, finished_at,
            json_extract(feedback, '$.cefr') AS cefr
     FROM sessions WHERE class_code = ?1 ORDER BY created_at DESC LIMIT 500`
  ).bind(c.code).all();
  const usage = await env.DB.prepare('SELECT n FROM usage WHERE day = ?1 AND k = ?2').bind(mytDay(), `class:${c.code}`).first();
  return json({
    class: { code: c.code, name: c.name, open: !!c.open, perStudentDaily: c.per_student_daily, usedToday: usage?.n || 0, classDailyCap: limits(env).classSessions },
    sessions: (results || []).map((r) => ({
      ...r,
      topic: topicById(r.topic_id)?.question || r.topic_id,
      persona: PERSONAS[r.persona]?.label || r.persona,
    })),
  });
}

async function teacherSession(env, request, url) {
  const c = await loadClass(env, request);
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1 AND class_code = ?2').bind(url.searchParams.get('id') || '', c.code).first();
  if (!s) throw new HttpError(404, 'Not found');
  return json(sessionView(s, await loadTurns(env, s.id)));
}

async function teacherSettings(env, request) {
  const c = await loadClass(env, request);
  const b = await readJson(request);
  const open = b.open === undefined ? c.open : b.open ? 1 : 0;
  const per = b.perStudentDaily === undefined ? c.per_student_daily : Math.max(0, Math.min(20, Math.round(Number(b.perStudentDaily) || 0)));
  await env.DB.prepare('UPDATE classes SET open = ?2, per_student_daily = ?3 WHERE code = ?1').bind(c.code, open, per).run();
  return json({ ok: true, open: !!open, perStudentDaily: per });
}

async function teacherDelete(env, request) {
  const c = await loadClass(env, request);
  const b = await readJson(request);
  const s = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?1 AND class_code = ?2').bind(String(b.id || ''), c.code).first();
  if (!s) throw new HttpError(404, 'Not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM turns WHERE session_id = ?1').bind(s.id),
    env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(s.id),
  ]);
  return json({ ok: true });
}

// Students can delete their own session (privacy).
async function deleteSession(env, request) {
  const b = await readJson(request);
  const s = await loadSession(env, request, String(b.sessionId || ''));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM turns WHERE session_id = ?1').bind(s.id),
    env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(s.id),
  ]);
  return json({ ok: true });
}

const ROUTES = {
  'GET config': (env) => config(env),
  'GET class': (env, req, url) => classCheck(env, url),
  'POST session/start': (env, req) => startSession(env, req),
  'POST session/turn': (env, req) => turn(env, req),
  'POST session/finish': (env, req) => finish(env, req),
  'POST session/delete': (env, req) => deleteSession(env, req),
  'GET session': (env, req, url) => getSession(env, req, url),
  'POST teacher/create': (env, req) => createClass(env, req),
  'GET teacher/class': (env, req) => teacherClass(env, req),
  'GET teacher/session': (env, req, url) => teacherSession(env, req, url),
  'POST teacher/settings': (env, req) => teacherSettings(env, req),
  'POST teacher/delete': (env, req) => teacherDelete(env, req),
};

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const handler = ROUTES[`${request.method} ${path}`];
  if (!handler) return json({ error: 'Not found' }, 404);
  try {
    checkOrigin(request);
    await ensureSchema(env.DB);
    return await handler(env, request, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.log('unhandled', e && e.stack ? e.stack.slice(0, 500) : String(e));
    return json({ error: 'Something went wrong. Please try again.', code: 'server' }, 500);
  }
}
