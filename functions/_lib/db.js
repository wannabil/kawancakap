// D1 schema (created lazily) and quota helpers.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS classes (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    teacher_hash TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    per_student_daily INTEGER NOT NULL DEFAULT 5,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    class_code TEXT,
    student_name TEXT NOT NULL,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    level TEXT NOT NULL,
    partner_name TEXT NOT NULL,
    partner_voice TEXT NOT NULL,
    day TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    feedback TEXT,
    band_grammar INTEGER, band_vocab INTEGER, band_comm INTEGER, band_overall INTEGER,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_class ON sessions(class_code, created_at)`,
  `CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    phase INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, id)`,
  `CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    k TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, k)
  )`,
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) {
    ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// Atomically take one unit from a daily counter. Returns true if under the limit.
export async function take(db, day, key, limit) {
  if (limit <= 0) return false;
  const row = await db
    .prepare(
      `INSERT INTO usage (day, k, n) VALUES (?1, ?2, 1)
       ON CONFLICT(day, k) DO UPDATE SET n = n + 1 WHERE n < ?3
       RETURNING n`
    )
    .bind(day, key, limit)
    .first();
  return !!row;
}

export async function giveBack(db, day, key) {
  await db.prepare(`UPDATE usage SET n = n - 1 WHERE day = ?1 AND k = ?2 AND n > 0`).bind(day, key).run();
}

// Take several counters; all-or-nothing.
export async function takeAll(db, day, items) {
  const taken = [];
  for (const [key, limit, code] of items) {
    if (!(await take(db, day, key, limit))) {
      for (const k of taken) await giveBack(db, day, k);
      return code;
    }
    taken.push(key);
  }
  return null;
}
