// AI layer: speech-to-text, partner replies, text-to-speech and feedback.
// Providers: 'class' = Cloudflare Workers AI (our account, free tier),
//            'openai' / 'gemini' = bring-your-own-key (key passed per request, never stored).
import { HttpError, bytesToBase64, scrubSecrets } from './util.js';

export const CF_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CF_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const CF_TTS_MODEL = '@cf/deepgram/aura-1';
export const OPENAI_CHAT_MODEL = 'gpt-4.1-mini';
export const GEMINI_CHAT_MODEL = 'gemini-flash-lite-latest'; // Flash-Lite defaults to minimal thinking = fast + cheap

export const PARTNERS = [
  { name: 'Daniel', voice: 'orion', oa: 'echo' },
  { name: 'Aisyah', voice: 'luna', oa: 'nova' },
  { name: 'Mei Ling', voice: 'stella', oa: 'shimmer' },
  { name: 'Arjun', voice: 'arcas', oa: 'onyx' },
  { name: 'Farah', voice: 'athena', oa: 'coral' },
  { name: 'Haziq', voice: 'perseus', oa: 'ash' },
];

export const PERSONAS = {
  challenger: {
    label: 'The Challenger',
    blurb: 'Politely disagrees and makes you defend your ideas.',
    prompt: `You often disagree politely and give a reason ("I see your point, but…", "Are you sure? Because…"). You don't give in easily: the student must justify their view with reasons or examples before you accept it. In the decision phase you push for a different option first, then agree only if the student negotiates well or offers a fair compromise.`,
  },
  agreeable: {
    label: 'The Easy-Going Friend',
    blurb: 'Friendly and agrees a lot. You must develop the ideas.',
    prompt: `You are friendly and agree easily ("Yes, I agree!", "True, true."), but you add only a little. This tests whether the student can develop ideas and keep the discussion moving. Now and then, ask the student "Why do you think so?" or "Can you give an example?" so they must extend their answer.`,
  },
  shy: {
    label: 'The Quiet One',
    blurb: 'Gives short answers. You must lead and draw them out.',
    prompt: `You are a bit shy and unsure. Give short answers (often one sentence), sometimes hesitate ("Hmm… I'm not sure…"). You rarely start new ideas yourself. This tests whether the student can initiate, invite you in ("What do you think?") and lead the discussion. When the student asks you a direct question, answer it properly with a reason, then wait.`,
  },
  talker: {
    label: 'The Talkative One',
    blurb: 'Talks a lot and jumps between ideas. You must take your turn.',
    prompt: `You are enthusiastic and talkative. You give longer answers (3–4 sentences) and sometimes jump to a new idea before finishing the old one. This tests whether the student can take turns politely ("Sorry, can I add something?"), bring the discussion back, and get their opinion heard. If the student interrupts politely, stop and let them speak.`,
  },
};

export const LEVELS = {
  auto: 'Match the student: if they use short, simple sentences, keep your English simple (around CEFR B1) and speak a little slower; if they are fluent, use richer vocabulary (B2) and challenge them more.',
  A2: 'The student is weak (around CEFR A2/B1). Use very simple words and short sentences. Be patient and encouraging.',
  B1: 'The student is around CEFR B1. Use everyday vocabulary and clear sentences.',
  B2: 'The student is strong (around CEFR B2). Use natural, richer vocabulary and challenge their reasoning more.',
};

function phaseInstruction(phase, topic) {
  if (phase === 1)
    return `CURRENT PHASE: Discussion (about 2 minutes). Talk about ${topic.talk}. Explore the ideas on the mind map one or two at a time. Respond to what the student actually said before adding your own idea. Don't try to reach a final decision yet.`;
  if (phase === 2)
    return `CURRENT PHASE: Decision (about 1 minute). Together decide ${topic.decision}. Propose an option with a reason, respond to the student's choice, negotiate, and try to reach (or clearly confirm) a shared decision, e.g. "So we agree that…?". It's fine to disagree at first.`;
  return `CURRENT PHASE: Further discussion (about 2 minutes). The examiner asked: "${topic.further}". Discuss this broader question with the student. Give and ask for opinions, speculate ("I think in the future…"), and ask follow-up questions. You don't need to agree.`;
}

export function systemPrompt(s, topic) {
  const persona = PERSONAS[s.persona] || PERSONAS.challenger;
  return `You are ${s.partner_name}, a 17-year-old Malaysian Form 5 student. You are the student's PARTNER (Candidate B) in the SPM English Speaking Test, Part 3 paired discussion. You are NOT a teacher or examiner. Never correct the student's English, never give feedback, never mention you are an AI.

TASK CARD
Central question: ${topic.question}
Ideas on the mind map: ${topic.ideas.join(', ')}.
Decision task: decide ${topic.decision}.
Further question: ${topic.further}

YOUR PERSONALITY: ${persona.prompt}
LANGUAGE LEVEL: ${LEVELS[s.level] || LEVELS.auto}

HOW TO TALK (very important):
- This is spoken conversation. Keep each reply SHORT: 1–3 sentences and under 45 words (talkative persona: up to 4 sentences, 65 words). Make ONE point per turn, not several. No lists, no bullet points, no markdown, no emojis, no stage directions.
- React to the student's last point first (agree, disagree, question it, or build on it), then add your view with a reason or a quick Malaysian example, then usually hand the turn back (a question or "What do you think?"). Vary your phrases; don't start every reply the same way.
- Be a real two-way partner: sometimes challenge, sometimes ask for an example, sometimes bring up a mind-map idea the student hasn't mentioned.
- Use natural Malaysian-student English, but stay grammatical. Don't use Malay words.
- If the student speaks Malay or another language, reply briefly in English and encourage them to try in English ("Can we try in English? I think you mean…").
- If the student's turn is empty, unclear or just "um", say something like "Sorry, I didn't catch that. Could you say it again?".
- Stay on the topic. If the student goes off topic or says something inappropriate, steer back to the task politely.

${phaseInstruction(s.phase, topic)}`;
}

export const OPENER_HINT = '[The examiner has just said "Now, talk to each other." You start the discussion naturally, e.g. greet briefly and give your first idea with a reason, then ask the student. Keep it short.]';

export function cleanReply(t) {
  let s = String(t || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/\*\*?|__|#+\s|`/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\([^)]*(pause|smiles|laughs|nods)[^)]*\)/gi, '')
    .replace(/^[A-Z][a-z]+( [A-Z][a-z]+)?:\s*/, '') // "Daniel: …"
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 600) {
    const cut = s.slice(0, 600);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = end > 200 ? cut.slice(0, end + 1) : cut;
  }
  return s;
}

// ---------- provider calls ----------

async function providerFetch(url, init, key) {
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new HttpError(502, 'Could not reach the AI provider. Please try again.', 'provider_down');
  }
  if (r.ok) return r;
  const body = scrubSecrets(await r.text().catch(() => ''), key);
  if (r.status === 401 || r.status === 403 || /api key|API_KEY_INVALID|invalid.*key/i.test(body))
    throw new HttpError(400, 'Your API key was rejected. Check the key and try again.', 'bad_key');
  if (r.status === 429) throw new HttpError(429, 'Your API key hit its rate limit or has no credit left. Wait a bit or check billing.', 'key_quota');
  console.log('provider error', r.status, body);
  throw new HttpError(502, 'The AI provider returned an error. Please try again.', 'provider_error');
}

export async function chat(env, provider, key, messages, { maxTokens = 220, json = null, temperature = 0.8 } = {}) {
  if (provider === 'class') {
    const body = { messages, max_tokens: maxTokens, temperature };
    if (json) body.response_format = { type: 'json_schema', json_schema: json };
    let out;
    try {
      out = await env.AI.run(CF_CHAT_MODEL, body);
    } catch (e) {
      console.log('workers ai chat error', String(e).slice(0, 300));
      throw new HttpError(502, 'The AI partner is busy right now. Please try again.', 'ai_busy');
    }
    let txt = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    if (typeof txt === 'object') txt = JSON.stringify(txt);
    return String(txt);
  }
  if (provider === 'openai') {
    const r = await providerFetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_CHAT_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      },
      key
    );
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const r = await providerFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents,
          generationConfig: {
            maxOutputTokens: json ? 2500 : 400,
            temperature,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
      key
    );
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  throw new HttpError(400, 'Unknown provider', 'bad_provider');
}

export async function transcribe(env, provider, key, audioBuf, mime) {
  if (provider === 'class') {
    try {
      const out = await env.AI.run(CF_STT_MODEL, { audio: bytesToBase64(audioBuf), language: 'en', vad_filter: true });
      return String(out?.text || '').trim();
    } catch (e) {
      console.log('whisper error', String(e).slice(0, 300));
      throw new HttpError(502, 'Could not hear that clearly. Please try again.', 'stt_error');
    }
  }
  if (provider === 'openai') {
    const fd = new FormData();
    const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
    fd.append('file', new Blob([audioBuf], { type: mime || 'audio/webm' }), `turn.${ext}`);
    fd.append('model', 'whisper-1');
    fd.append('language', 'en');
    const r = await providerFetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd }, key);
    const j = await r.json();
    return String(j.text || '').trim();
  }
  if (provider === 'gemini') {
    const m = (mime || 'audio/webm').split(';')[0];
    const r = await providerFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inline_data: { mime_type: m, data: bytesToBase64(audioBuf) } },
                { text: 'Transcribe exactly what the speaker says, word for word, keeping their grammar mistakes. Output only the transcript. If nothing is said, output nothing.' },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 400},
        }),
      },
      key
    );
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }
  throw new HttpError(400, 'Unknown provider', 'bad_provider');
}

// Returns base64 mp3 or null (client then falls back to the browser's own voice).
export async function speak(env, provider, key, text, partner) {
  if (!text) return null;
  try {
    if (provider === 'class') {
      const out = await env.AI.run(CF_TTS_MODEL, { text: text.slice(0, 1000), speaker: partner.voice, encoding: 'mp3' }, { returnRawResponse: false });
      let buf;
      if (out instanceof ReadableStream) buf = await new Response(out).arrayBuffer();
      else if (out instanceof ArrayBuffer || out instanceof Uint8Array) buf = out;
      else if (out?.audio) return out.audio;
      else return null;
      return bytesToBase64(buf);
    }
    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', voice: partner.oa || 'alloy', input: text.slice(0, 1000), response_format: 'mp3' }),
      });
      if (!r.ok) return null;
      return bytesToBase64(await r.arrayBuffer());
    }
  } catch (e) {
    console.log('tts error', String(e).slice(0, 200));
  }
  return null; // gemini: browser voice
}

// ---------- feedback ----------

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    grammar: { type: 'integer' },
    vocabulary: { type: 'integer' },
    communicative: { type: 'integer' },
    overall: { type: 'integer' },
    cefr: { type: 'string' },
    summary: { type: 'string' },
    interaction: {
      type: 'object',
      properties: {
        responding: { type: 'string' },
        asking: { type: 'string' },
        developing: { type: 'string' },
        negotiating: { type: 'string' },
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    fixes: {
      type: 'array',
      items: { type: 'object', properties: { said: { type: 'string' }, better: { type: 'string' }, why: { type: 'string' } } },
    },
    phrases: { type: 'array', items: { type: 'string' } },
    next_goal: { type: 'string' },
  },
  required: ['grammar', 'vocabulary', 'communicative', 'overall', 'cefr', 'summary', 'interaction', 'strengths', 'fixes', 'phrases', 'next_goal'],
};

const RUBRIC = `SPM English Speaking (1119/3) scales, 0–6 each (B1–B2 focus; 4 and 2 are "between" bands):
GRAMMAR – 6: high accuracy, errors rare; wide range of structures, cohesive devices. 5: good accuracy, simple and some complex structures, range of cohesive devices. 3: reasonable accuracy, good control of simple structures, attempts complex ones, links sentences with basic connectors. 1: sufficient control of simple structures, simple connectors. 0: too little English to assess.
VOCABULARY – 6: wide range for abstract/unfamiliar topics, precise meaning. 5: wide range for familiar topics, good word choice. 3: range for everyday topics, some wrong word choices. 1: enough for everyday topics, some inappropriate words or repetition.
COMMUNICATIVE COMPETENCE – 6: spontaneous, little searching; initiates, maintains, develops and closes with ease; relates contributions skilfully to partner. 5: little hesitation; relates contributions to partner and negotiates towards an outcome. 3: clear with some hesitation; can ask for clarification/details to move the discussion forward. 1: understood but pauses/false starts; maintains with some difficulty.
OVERALL – 6: extended relevant language, develops interaction with very little prompting. 5: maintains and develops interaction with longer responses, little prompting. 3: maintains interaction simply and directly, needs some prompting. 1: short phrases, needs prompting and support.
CEFR guide (rough): band 1≈A2, 2≈A2/B1, 3≈B1, 4≈B1+, 5≈B2, 6≈C1.`;

export function feedbackMessages(s, topic, turns) {
  const transcript = turns
    .map((t) => `[Phase ${t.phase}] ${t.role === 'student' ? 'STUDENT' : `PARTNER (${s.partner_name})`}: ${t.text}`)
    .join('\n');
  const studentWords = turns.filter((t) => t.role === 'student').reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  return [
    {
      role: 'system',
      content: `You are an experienced, kind SPM English speaking examiner and teacher in Malaysia. You assess ONLY the STUDENT (not the AI partner) in a Part 3 paired discussion practice. Phase 1 = discussion, phase 2 = decision, phase 3 = further discussion.

${RUBRIC}

Rules:
- Base every judgement on the transcript. The transcript comes from speech recognition, so ignore small spelling/punctuation issues, but do judge grammar and word choice.
- If the student said very little (under ~40 words), bands must be low (0–2) and say clearly they need to speak more.
- Assess the interaction specifically: did they respond to the partner's points (not just give their own speech), ask questions/invite the partner, develop ideas with reasons and examples, and negotiate towards a decision?
- "fixes": 2–4 items quoting the student's REAL words exactly in "said", a natural corrected/upgraded version in "better", and a short reason in "why". Prefer the mistakes that matter most.
- "strengths": 2–3 specific things they did well (quote them where possible).
- "phrases": 4–6 short useful phrases for THIS student's weak area (e.g. agreeing, disagreeing politely, asking opinion, negotiating, concluding).
- Interaction fields: one or two sentences each, specific to this transcript.
- "summary": 2–3 encouraging, honest sentences. "next_goal": one concrete thing to try next session.
- Simple, clear English a Form 5 student understands. English only.
- Output ONLY valid JSON with keys: grammar, vocabulary, communicative, overall (integers 0–6), cefr (e.g. "B1"), summary, interaction {responding, asking, developing, negotiating}, strengths [], fixes [{said, better, why}], phrases [], next_goal.`,
    },
    {
      role: 'user',
      content: `Task: ${topic.question} (ideas: ${topic.ideas.join(', ')}). Decision: ${topic.decision}. Further question: ${topic.further}
Partner persona: ${(PERSONAS[s.persona] || {}).label || s.persona}. Student words in total: ${studentWords}.

TRANSCRIPT
${transcript || '(no turns)'}`,
    },
  ];
}

export function parseFeedback(text) {
  let t = String(text || '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  const band = (v) => Math.max(0, Math.min(6, Math.round(Number(v) || 0)));
  const str = (v, n = 600) => String(v ?? '').slice(0, n);
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    grammar: band(j.grammar),
    vocabulary: band(j.vocabulary),
    communicative: band(j.communicative),
    overall: band(j.overall),
    cefr: str(j.cefr, 8),
    summary: str(j.summary),
    interaction: {
      responding: str(j.interaction?.responding),
      asking: str(j.interaction?.asking),
      developing: str(j.interaction?.developing),
      negotiating: str(j.interaction?.negotiating),
    },
    strengths: arr(j.strengths, 4).map((x) => str(x, 300)),
    fixes: arr(j.fixes, 5).map((f) => ({ said: str(f?.said, 300), better: str(f?.better, 300), why: str(f?.why, 300) })),
    phrases: arr(j.phrases, 8).map((x) => str(x, 120)),
    next_goal: str(j.next_goal, 300),
  };
}

export { FEEDBACK_SCHEMA };
