// KawanCakap student app (vanilla JS, no build step).
import { api, esc, $, recorder, unlockAudio, playB64, speakFallback, stopAudio, bandBar, renderFeedback, store } from './common.js';

const app = $('#app');
let CONFIG = null;
const PHASES = {
  1: { name: 'Discussion', secs: 120 },
  2: { name: 'Decision', secs: 60 },
  3: { name: 'Further question', secs: 120 },
};

// ---------- routing ----------
window.addEventListener('hashchange', route);
route();

async function route() {
  document.body.classList.remove('in-session');
  stopAudio();
  recorder.cancel();
  const h = location.hash || '#/';
  if (h.startsWith('#/s/')) return showSaved(h.slice(4));
  if (h === '#/history') return showHistory();
  return showHome();
}

// ---------- home / setup ----------
async function showHome() {
  app.innerHTML = '';
  app.append($('#tpl-home').content.cloneNode(true));
  const f = $('#setup');
  const saved = store.get('setup') || {};
  const params = new URLSearchParams(location.search);
  if (params.get('c')) saved.classCode = params.get('c').toUpperCase();
  if (saved.classCode && !saved.provider) saved.provider = 'class';
  f.name.value = saved.name || '';
  f.classCode.value = saved.classCode || '';
  if (saved.provider) f.querySelector(`[name=provider][value=${saved.provider}]`).checked = true;
  f.apiKey.value = saved.provider && saved.provider !== 'class' ? store.get('key:' + saved.provider) || '' : '';

  const sync = () => {
    const p = f.provider.value;
    f.querySelectorAll('[data-show]').forEach((el) => {
      const v = el.dataset.show;
      el.hidden = !(v === p || (v === 'key' && p !== 'class'));
    });
    if (p !== 'class') f.apiKey.value = store.get('key:' + p) || '';
  };
  f.addEventListener('change', (e) => { if (e.target.name === 'provider') sync(); });
  sync();

  const checkClass = async () => {
    const code = f.classCode.value.trim().toUpperCase();
    const msg = $('#classMsg');
    if (code.length !== 6) { msg.textContent = ''; return; }
    try {
      const r = await api('GET', '/api/class?code=' + encodeURIComponent(code));
      msg.textContent = r.ok ? `✓ ${r.name}` : r.error;
      msg.className = 'hint ' + (r.ok ? 'ok' : 'bad');
    } catch { /* ignore */ }
  };
  f.classCode.addEventListener('input', () => { f.classCode.value = f.classCode.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); checkClass(); });
  checkClass();

  try {
    CONFIG = CONFIG || (await api('GET', '/api/config'));
    const themes = {};
    for (const t of CONFIG.topics) (themes[t.theme] ||= []).push(t);
    for (const [theme, list] of Object.entries(themes)) {
      const og = document.createElement('optgroup');
      og.label = theme;
      for (const t of list) og.append(new Option(t.question, t.id));
      f.topicId.append(og);
    }
    for (const p of CONFIG.personas) f.persona.append(new Option(`${p.label}: ${p.blurb}`, p.id));
    if (saved.persona) f.persona.value = saved.persona;
    if (saved.level) f.level.value = saved.level;
  } catch (e) {
    $('#setupErr').textContent = e.message;
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setupErr');
    err.textContent = '';
    const provider = f.provider.value;
    const key = f.apiKey.value.trim();
    const body = {
      name: f.name.value.trim(), provider, classCode: provider === 'class' ? f.classCode.value.trim() : '',
      topicId: f.topicId.value, persona: f.persona.value, level: f.level.value,
    };
    if (provider === 'class' && body.classCode.length !== 6) return (err.textContent = 'Enter the 6-character class code from your teacher.');
    if (provider !== 'class' && !key) return (err.textContent = 'Paste your API key first.');
    store.set('setup', { name: body.name, provider, classCode: body.classCode || saved.classCode || '', persona: body.persona, level: body.level });
    if (provider !== 'class') store.set('key:' + provider, key);
    unlockAudio();
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Setting up…';
    try {
      await recorder.init();
    } catch (e2) {
      btn.disabled = false; btn.textContent = 'Start practice';
      return (err.textContent = 'Microphone blocked. Allow mic access in your browser settings, then try again. ' + (e2.message || ''));
    }
    try {
      const s = await api('POST', '/api/session/start', body, provider === 'class' ? null : key);
      s.key = provider === 'class' ? null : key;
      runSession(s);
    } catch (e3) {
      err.textContent = e3.message;
      btn.disabled = false; btn.textContent = 'Start practice';
    }
  });
}

// ---------- the exam session ----------
function runSession(s) {
  let phase = 0; // 0 = prep
  let left = 20;
  let timer = null;
  let busy = false;
  let partnerSpoke = false;
  const log = [];
  history.replaceState(null, '', '#/practice');
  document.body.classList.add('in-session');

  app.innerHTML = `
  <section class="session">
    <div class="phasebar">
      <div class="steps">${[0, 1, 2, 3].map((p) => `<span data-p="${p}">${p === 0 ? 'Read' : PHASES[p].name}</span>`).join('')}</div>
      <div class="clock" id="clock">0:20</div>
    </div>
    <div class="card task" id="task">
      <p class="eyebrow" id="taskLabel">Task card</p>
      <h2 id="taskQ">${esc(s.topic.question)}</h2>
      <ul class="mind">${s.topic.ideas.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    </div>
    <p class="examiner" id="examiner"></p>
    <div class="partner">
      <div class="avatar" aria-hidden="true">${esc(s.partner.name[0])}</div>
      <div><b>${esc(s.partner.name)}</b> <small>· ${esc(s.persona.label)}</small><br><small class="muted">${esc(s.persona.blurb)}</small></div>
    </div>
    <div class="chat" id="chat"></div>
    <div class="controls">
      <p class="status" id="status" role="status"></p>
      <button class="mic" id="mic" type="button" disabled aria-label="Tap to speak"><span class="ring"></span><svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11Z"/></svg></button>
      <div class="row">
        <button class="btn ghost" id="nudge" type="button" disabled>Let ${esc(s.partner.name)} start</button>
        <button class="btn ghost" id="typeBtn" type="button" disabled>Type instead</button>
        <button class="btn" id="next" type="button">Skip reading time</button>
      </div>
      <form id="typeForm" class="typeform" hidden><input name="t" placeholder="Type what you want to say" maxlength="800"><button class="btn primary">Send</button></form>
    </div>
  </section>`;

  const clock = $('#clock'), status = $('#status'), mic = $('#mic'), chatEl = $('#chat');
  const nextBtn = $('#next'), nudgeBtn = $('#nudge'), typeBtn = $('#typeBtn'), examiner = $('#examiner');

  const setStatus = (t) => (status.textContent = t);
  const fmt = (n) => `${Math.floor(Math.max(0, n) / 60)}:${String(Math.max(0, n) % 60).padStart(2, '0')}`;
  const bubble = (role, text) => {
    log.push({ role, text });
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = `<small>${role === 'student' ? 'You' : esc(s.partner.name)}</small><p>${esc(text)}</p>`;
    chatEl.append(d);
    chatEl.scrollTop = chatEl.scrollHeight;
    return d;
  };
  const setBusy = (b) => {
    busy = b;
    mic.disabled = b || phase === 0;
    nudgeBtn.disabled = b || phase === 0;
    typeBtn.disabled = b || phase === 0;
  };

  const tick = () => {
    if (!busy && !recorder.recording) left--;
    clock.textContent = fmt(left);
    clock.classList.toggle('low', left <= 15 && phase > 0);
    if (left <= 0) {
      if (phase === 0) return goPhase(1);
      clock.textContent = "Time's up";
      nextBtn.classList.add('pulse');
    }
  };

  function goPhase(p) {
    phase = p;
    left = p === 0 ? 20 : PHASES[p].secs;
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    clock.textContent = fmt(left);
    nextBtn.classList.remove('pulse');
    document.querySelectorAll('.steps span').forEach((el) => el.classList.toggle('on', Number(el.dataset.p) === p));
    document.querySelectorAll('.steps span').forEach((el) => el.classList.toggle('done', Number(el.dataset.p) < p));
    const t = s.topic;
    if (p === 1) {
      examiner.innerHTML = `<b>Examiner:</b> Now, talk to each other about ${esc(t.talk)}.`;
      nextBtn.textContent = 'Next: Decision →';
      setStatus(`Tap the mic and give your first idea, or let ${s.partner.name} start.`);
    } else if (p === 2) {
      examiner.innerHTML = `<b>Examiner:</b> Thank you. Now you have about a minute to decide together <b>${esc(t.decision)}</b>.`;
      nextBtn.textContent = 'Next: Further question →';
      setStatus('Suggest which option is best, and agree together.');
    } else if (p === 3) {
      $('#taskLabel').textContent = 'Further discussion';
      $('#taskQ').textContent = t.further;
      $('.mind').hidden = true;
      examiner.innerHTML = `<b>Examiner:</b> You've been talking about ${esc(t.talk)}. Now let's hear your opinion on this: <b>${esc(t.further)}</b>`;
      nextBtn.textContent = 'End & get feedback';
      setStatus('Share your opinion and ask what your partner thinks.');
    } else {
      examiner.innerHTML = `<b>Examiner:</b> Here are ${esc(t.label)} and a question for you to discuss. First, you have some time to look at the task.`;
      setStatus('Read the task card. Think of 2 ideas and a reason for each.');
    }
    setBusy(false);
    nudgeBtn.textContent = p === 1 && !partnerSpoke ? `Let ${s.partner.name} start` : `${s.partner.name}, your turn`;
    if (p >= 2 && phase === p) {
      // In later phases the partner opens if the student doesn't within a few seconds? Keep it student-led; offer the button.
    }
  }

  async function send(payload) {
    setBusy(true);
    const pending = bubble('partner thinking', '…');
    setStatus(`${s.partner.name} is thinking…`);
    try {
      let r;
      if (payload instanceof FormData) r = await api('POST', '/api/session/turn', payload, s.key, s.token);
      else r = await api('POST', '/api/session/turn', { sessionId: s.sessionId, phase, ...payload }, s.key, s.token);
      pending.remove();
      log.pop();
      if (r.studentText) bubble('student', r.studentText);
      bubble('partner', r.reply);
      partnerSpoke = true;
      nudgeBtn.textContent = `${s.partner.name}, your turn`;
      setStatus(`${s.partner.name} is speaking… (tap the mic to reply)`);
      setBusy(false);
      const done = () => setStatus('Your turn. Tap the mic and reply.');
      if (r.audio) await playB64(r.audio).catch(() => speakFallback(r.reply)).then(done);
      else await speakFallback(r.reply).then(done);
    } catch (e) {
      pending.remove();
      log.pop();
      setStatus(e.message);
      setBusy(false);
    }
  }

  mic.addEventListener('click', async () => {
    if (busy) return;
    if (!recorder.recording) {
      stopAudio();
      try {
        await recorder.start();
      } catch (e) {
        return setStatus('Microphone problem: ' + e.message);
      }
      mic.classList.add('rec');
      mic.setAttribute('aria-label', 'Tap when you finish speaking');
      setStatus('Listening… tap again when you finish.');
      return;
    }
    mic.classList.remove('rec');
    mic.setAttribute('aria-label', 'Tap to speak');
    const wav = await recorder.stop();
    if (!wav || wav.size < 4000) return setStatus('That was too short. Tap, speak, then tap again.');
    const fd = new FormData();
    fd.append('sessionId', s.sessionId);
    fd.append('phase', String(phase));
    fd.append('audio', wav, 'turn.wav');
    send(fd);
  });

  nudgeBtn.addEventListener('click', () => send({ nudge: true }));
  typeBtn.addEventListener('click', () => { const tf = $('#typeForm'); tf.hidden = !tf.hidden; if (!tf.hidden) tf.t.focus(); });
  $('#typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = e.target.t.value.trim();
    if (!t || busy) return;
    e.target.t.value = '';
    send({ text: t });
  });

  nextBtn.addEventListener('click', async () => {
    if (busy) return;
    if (recorder.recording) { recorder.cancel(); mic.classList.remove('rec'); }
    stopAudio();
    if (phase < 3) return goPhase(phase + 1);
    clearInterval(timer);
    finish(s);
  });

  goPhase(0);
}

async function finish(s) {
  document.body.classList.remove('in-session');
  app.innerHTML = `<section class="center-screen"><div class="spinner"></div><p>Your examiner is marking your discussion…</p><p class="hint">This takes about 10 seconds.</p></section>`;
  try {
    const r = await api('POST', '/api/session/finish', { sessionId: s.sessionId }, s.key, s.token);
    const list = store.get('sessions') || [];
    list.unshift({ id: s.sessionId, token: s.token, q: s.topic.question, at: Date.now(), overall: r.feedback?.overall ?? null, provider: s.provider });
    store.set('sessions', list.slice(0, 50));
    history.replaceState(null, '', '#/s/' + s.sessionId);
    showSaved(s.sessionId, r.feedback, r.message);
  } catch (e) {
    app.innerHTML = `<section class="center-screen"><p class="err">${esc(e.message)}</p><button class="btn primary" id="retry">Try again</button></section>`;
    $('#retry').onclick = () => finish(s);
  }
}

async function showSaved(id, fb, message) {
  const meta = (store.get('sessions') || []).find((x) => x.id === id);
  if (!meta) { app.innerHTML = `<section class="center-screen"><p>Session not found on this device.</p><a class="btn" href="#/">Home</a></section>`; return; }
  let data;
  try {
    data = await api('GET', '/api/session?id=' + encodeURIComponent(id), null, null, meta.token);
  } catch (e) {
    app.innerHTML = `<section class="center-screen"><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Home</a></section>`;
    return;
  }
  fb = fb || data.feedback;
  app.innerHTML = `<section class="result">
    <a href="#/" class="back">← Practise again</a>
    <h1>Your feedback</h1>
    <p class="muted">${esc(data.topic?.question || '')} · Partner: ${esc(data.partner)} (${esc(data.persona)})</p>
    ${fb ? renderFeedback(fb) : `<div class="card"><p>${esc(message || 'No feedback yet for this session.')}</p></div>`}
    <details class="card"><summary><b>Transcript</b></summary>${data.turns.map((t) => `<p class="tline ${t.role}"><b>${t.role === 'student' ? 'You' : esc(data.partner)}:</b> ${esc(t.text)}</p>`).join('') || '<p>No turns.</p>'}</details>
    <div class="row"><a class="btn primary big" href="#/">Practise again</a></div>
    <p class="hint">${data.classCode ? 'Your teacher can see this session.' : 'Only you can see this session.'} <button class="linkbtn" id="del">Delete this session</button></p>
  </section>`;
  $('#del').onclick = async () => {
    if (!confirm('Delete this session and its transcript?')) return;
    await api('POST', '/api/session/delete', { sessionId: id }, null, meta.token).catch(() => {});
    store.set('sessions', (store.get('sessions') || []).filter((x) => x.id !== id));
    location.hash = '#/history';
  };
}

function showHistory() {
  const list = store.get('sessions') || [];
  app.innerHTML = `<section class="result"><a href="#/" class="back">← Home</a><h1>My sessions</h1>
  ${list.length ? `<ul class="hist">${list.map((x) => `<li><a href="#/s/${esc(x.id)}"><span>${esc(x.q)}</span><small>${new Date(x.at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })}</small>${x.overall != null ? bandBar('Overall', x.overall, true) : ''}</a></li>`).join('')}</ul>` : '<p class="muted">No sessions yet on this device.</p>'}
  </section>`;
}
