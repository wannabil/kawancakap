# KawanCakap 🎤

**Free AI speaking partner for SPM English (1119/3) Speaking Part 3, the paired discussion.**

Live: https://kawancakap.pages.dev

Malaysian SPM students sit the speaking test in pairs: they discuss a mind map, negotiate a decision together, then answer a further question. Most students have nobody to practise with outside class, and a weak partner can't push them. KawanCakap is that partner: it gives opinions, disagrees, asks follow-up questions and negotiates with the student, then marks the student against the SPM band descriptors.

The focus is the **two-way interaction**, not an AI that only asks questions and grades answers.

## What it does

- **Real exam flow:** 20 s reading → Discussion (2 min) → Decision (1 min) → Further question (2 min), with examiner lines and a timer.
- **Push-to-talk voice:** tap the mic, speak, tap again. The partner replies out loud. Typing is also available.
- **4 partner personalities** that test different skills:
  - *The Challenger* disagrees politely, so you have to defend your view.
  - *The Easy-Going Friend* agrees a lot, so you have to develop the ideas yourself.
  - *The Quiet One* gives short answers, so you have to lead and draw them out.
  - *The Talkative One* talks a lot, so you have to take your turn politely.
- **Level matching:** the partner adapts its English to the student (or set Easy/Medium/Challenging).
- **30 original practice topics** in the SPM Part 3 format (Education, Health & Environment, Science & Technology, People & Culture, Consumerism & Financial Awareness).
- **Feedback after each session:** bands 0–6 for Grammar, Vocabulary, Communicative Competence and Overall Spoken Performance (based on the SPM 1119/3 descriptors), an approximate CEFR level, notes on how the student responded, asked, developed ideas and negotiated, plus "say it better" fixes quoting the student's real sentences, useful phrases and a goal for next time.
- **Teacher dashboard:** create a class, share the code or a WhatsApp link, see every student's sessions, transcripts, bands and averages, set a daily limit per student, close the class.

## AI: class key or bring your own key

| Mode | Who pays | Models |
|---|---|---|
| **Class code** | The app owner's Cloudflare Workers AI | Llama 3.3 70B (partner + feedback), Whisper large-v3-turbo (speech-to-text), Deepgram Aura (voice) |
| **My Gemini key** | The student (Google AI Studio has a free tier) | Gemini Flash-Lite (`gemini-flash-lite-latest`) for transcription, partner and feedback; browser voice |
| **My OpenAI key** | The student | gpt-4.1-mini, whisper-1, tts-1 |

BYOK keys are stored only in the student's browser (localStorage) and sent with each request in a header. The server forwards them to the provider and never stores or logs them.

No model training is needed: the SPM format, rubric and partner behaviour are all in the prompts (`functions/_lib/ai.js`). Fine-tuning would only help later, once there are many real (consented) transcripts.

## Stack

Cloudflare Pages (static `public/`) + Pages Functions (`functions/api/[[path]].js`) + D1 + Workers AI. Vanilla JS, no build step. Audio is recorded in the browser as 16 kHz mono WAV, so it works on Chrome, Safari/iOS and Firefox.

```
public/            index.html, app.js (student), teacher.html/js, common.js, style.css, _headers (CSP)
functions/api/     single router: config, class check, session start/turn/finish/delete, teacher endpoints
functions/_lib/    ai.js (prompts, providers, rubric), topics.js, db.js (schema + daily quotas), util.js
tests/             api.test.mjs (27 checks, real AI), ui.test.mjs (phone-size browser run with a fake mic)
```

## Limits and privacy

- Free class-key sessions are capped per day: whole site, per class, per student (teacher-adjustable) and per IP. Set in `wrangler.toml` `[vars]`.
- Student sessions are tied to a random token kept on the student's device. Class sessions are visible to that class's teacher; sessions without a class are visible only to the student.
- Students and teachers can delete sessions. Only a first name is asked for. No accounts, no emails.
- Teacher access is a secret link (`/teacher.html#k=CODE.KEY`). The key sits in the URL fragment, so it never reaches server logs. Only a SHA-256 hash is stored.
- New classes need a teacher invite code (the `TEACHER_INVITE` secret).

Bands are an AI estimate for practice, not an official SPM mark. Topics are original, written in the style of the public SPM Part 3 format.

## Run it yourself

```bash
npm i -g wrangler
wrangler d1 create kawancakap-db            # put the id in wrangler.toml
echo "TEACHER_INVITE=pick-a-code" > .dev.vars
wrangler pages dev public --port 8977       # Workers AI calls go to your account
BASE_URL=http://127.0.0.1:8977 INVITE=pick-a-code node tests/api.test.mjs
```

Deploy:

```bash
wrangler pages project create kawancakap --production-branch main
wrangler pages secret put TEACHER_INVITE --project-name kawancakap
wrangler pages deploy public --project-name kawancakap --branch main
```

Tables are created automatically on first request.

## Licence

MIT
