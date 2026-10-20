// Teacher dashboard: create a class, share the code, see every student's sessions and feedback.
import { api, esc, $, store, renderFeedback, bandBar } from './common.js';

const app = $('#app');

// Teacher access lives in the URL fragment (#k=CODE.KEY) so it never reaches server logs.
function readAccess() {
  const m = location.hash.match(/k=([A-Z0-9]{6})\.([a-f0-9]{48})/);
  if (m) {
    const list = (store.get('teacher') || []).filter((c) => c.code !== m[1]);
    list.unshift({ code: m[1], key: m[2] });
    store.set('teacher', list);
    return { code: m[1], key: m[2] };
  }
  return null;
}

const tapi = (method, url, body, acc) => api(method, url, body, null, acc.key, { 'x-class-code': acc.code });

window.addEventListener('hashchange', route);
route();

async function route() {
  const acc = readAccess();
  const sid = (location.hash.match(/s=([a-f0-9]+)/) || [])[1];
  if (acc && sid) return showSession(acc, sid);
  if (acc) return showClass(acc);
  return showStart();
}

function showStart() {
  const classes = store.get('teacher') || [];
  app.innerHTML = `<section class="result">
    <h1>Teacher dashboard</h1>
    <p class="lead">Create a class, share the code with your students, and see every practice session: transcripts, bands and feedback.</p>
    ${classes.length ? `<div class="card"><h3>Your classes on this device</h3><ul class="hist">${classes.map((c) => `<li><a href="#k=${c.code}.${c.key}"><span>Class ${esc(c.code)}</span></a></li>`).join('')}</ul></div>` : ''}
    <form id="create" class="card stack">
      <h3>Create a class</h3>
      <label>Class name <input name="name" maxlength="60" required placeholder="e.g. 5 Bestari 2026"></label>
      <label>Teacher invite code <input name="invite" type="password" required placeholder="From the app owner"></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary">Create class</button>
    </form>
  </section>`;
  $('#create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('POST', '/api/teacher/create', { name: f.name.value, invite: f.invite.value });
      location.hash = `#k=${r.code}.${r.teacherKey}`;
    } catch (err) {
      $('#err').textContent = err.message;
    }
  });
}

async function showClass(acc) {
  app.innerHTML = '<section class="center-screen"><div class="spinner"></div></section>';
  let d;
  try {
    d = await tapi('GET', '/api/teacher/class', null, acc);
  } catch (e) {
    app.innerHTML = `<section class="center-screen"><p class="err">${esc(e.message)}</p><a class="btn" href="#">Back</a></section>`;
    return;
  }
  const c = d.class;
  const studentLink = `${location.origin}/?c=${c.code}`;
  const teacherLink = `${location.origin}/teacher.html#k=${acc.code}.${acc.key}`;
  const done = d.sessions.filter((s) => s.band_overall != null);
  const byStudent = {};
  for (const s of d.sessions) (byStudent[s.student_name.toLowerCase()] ||= { name: s.student_name, list: [] }).list.push(s);
  const avg = (arr, k) => (arr.length ? (arr.reduce((n, x) => n + (x[k] || 0), 0) / arr.length).toFixed(1) : '–');

  app.innerHTML = `<section class="result">
    <a href="#" class="back">← All classes</a>
    <h1>${esc(c.name)}</h1>
    <div class="card share">
      <p>Class code</p>
      <div class="code">${esc(c.code)}</div>
      <div class="row">
        <button class="btn primary" data-copy="${esc(studentLink)}">Copy student link</button>
        <a class="btn" href="https://wa.me/?text=${encodeURIComponent(`Practise SPM Speaking Part 3 with an AI partner 🎤\n${studentLink}\nClass code: ${c.code}`)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      </div>
      <p class="hint">Keep your teacher link private. Bookmark it, it's your login: <button class="linkbtn" data-copy="${esc(teacherLink)}">copy teacher link</button></p>
    </div>

    <div class="card stats">
      <div><b>${d.sessions.length}</b><span>sessions</span></div>
      <div><b>${Object.keys(byStudent).length}</b><span>students</span></div>
      <div><b>${avg(done, 'band_overall')}</b><span>avg overall</span></div>
      <div><b>${c.usedToday}/${c.classDailyCap}</b><span>free sessions today</span></div>
    </div>

    <form id="settings" class="card stack">
      <h3>Settings</h3>
      <label class="opt"><input type="checkbox" name="open" ${c.open ? 'checked' : ''}> <span><b>Class open</b> <small>Students can start sessions with the code</small></span></label>
      <label>Free sessions per student per day <input type="number" name="per" min="0" max="20" value="${c.perStudentDaily}"></label>
      <button class="btn">Save settings</button><span class="hint" id="saved"></span>
    </form>

    <div class="card">
      <h3>Students</h3>
      ${Object.values(byStudent).length ? `<table class="tbl"><thead><tr><th>Student</th><th>Sessions</th><th>Avg G</th><th>Avg V</th><th>Avg CC</th><th>Avg overall</th></tr></thead><tbody>
      ${Object.values(byStudent).sort((a, b) => a.name.localeCompare(b.name)).map((st) => { const f = st.list.filter((x) => x.band_overall != null); return `<tr><td>${esc(st.name)}</td><td>${st.list.length}</td><td>${avg(f, 'band_grammar')}</td><td>${avg(f, 'band_vocab')}</td><td>${avg(f, 'band_comm')}</td><td><b>${avg(f, 'band_overall')}</b></td></tr>`; }).join('')}
      </tbody></table>` : '<p class="muted">No sessions yet. Share the class code with your students.</p>'}
    </div>

    <div class="card">
      <h3>All sessions</h3>
      <ul class="hist">${d.sessions.map((s) => `<li><a href="#k=${acc.code}.${acc.key}&s=${s.id}"><span><b>${esc(s.student_name)}</b> · ${esc(s.topic)}</span><small>${new Date(s.created_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })} · ${esc(s.persona)} · ${Math.ceil((s.turns || 0) / 2)} exchanges${s.band_overall == null ? ' · no feedback' : ''}</small>${s.band_overall != null ? bandBar('Overall', s.band_overall, true) : ''}</a></li>`).join('')}</ul>
    </div>
  </section>`;

  app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; } catch { prompt('Copy this:', b.dataset.copy); }
  }));
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await tapi('POST', '/api/teacher/settings', { open: f.open.checked, perStudentDaily: Number(f.per.value) }, acc);
      $('#saved').textContent = ' Saved ✓';
    } catch (err) { $('#saved').textContent = ' ' + err.message; }
  });
}

async function showSession(acc, id) {
  app.innerHTML = '<section class="center-screen"><div class="spinner"></div></section>';
  let d;
  try {
    d = await tapi('GET', '/api/teacher/session?id=' + id, null, acc);
  } catch (e) {
    app.innerHTML = `<section class="center-screen"><p class="err">${esc(e.message)}</p></section>`;
    return;
  }
  app.innerHTML = `<section class="result">
    <a href="#k=${acc.code}.${acc.key}" class="back">← Class</a>
    <h1>${esc(d.student)}</h1>
    <p class="muted">${esc(d.topic?.question || '')} · Partner ${esc(d.partner)} (${esc(d.persona)}) · ${new Date(d.createdAt).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })}</p>
    ${d.feedback ? renderFeedback(d.feedback) : '<div class="card"><p>The student did not finish this session, so there is no feedback.</p></div>'}
    <div class="card"><h3>Transcript</h3>${d.turns.map((t) => `<p class="tline ${t.role}"><b>${t.role === 'student' ? esc(d.student) : esc(d.partner) + ' (AI)'}</b> <small>phase ${t.phase}</small><br>${esc(t.text)}</p>`).join('') || '<p>No turns.</p>'}</div>
    <button class="linkbtn" id="del">Delete this session</button>
  </section>`;
  $('#del').onclick = async () => {
    if (!confirm('Delete this session for good?')) return;
    await tapi('POST', '/api/teacher/delete', { id }, acc);
    location.hash = `#k=${acc.code}.${acc.key}`;
  };
}
