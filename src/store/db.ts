import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

// Loaded lazily rather than as a static import: `node:sqlite` emits its
// ExperimentalWarning at module-load time, and ESM loads every builtin in the
// graph before any module body runs — including the one that installs our
// warning filter. Requiring it here keeps the filter in front of it.
const require = createRequire(import.meta.url);
let DatabaseSyncCtor: typeof DatabaseSync | null = null;
function sqlite(): typeof DatabaseSync {
  DatabaseSyncCtor ??= (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  return DatabaseSyncCtor;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  status         TEXT NOT NULL,           -- queued|running|done|failed|killed|stuck
  project        TEXT,
  project_path   TEXT,
  agent          TEXT,
  task_class     TEXT NOT NULL DEFAULT 'coding',
  intent         TEXT NOT NULL DEFAULT 'task',
  channel        TEXT,                    -- imessage|telegram|dashboard|schedule|trigger
  thread_id      TEXT,
  session_id     TEXT,
  parent_run_id  TEXT,
  prompt         TEXT NOT NULL,
  branch         TEXT,
  exit_code      INTEGER,
  error          TEXT,
  cost_usd       REAL NOT NULL DEFAULT 0,
  turns          INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  result         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_thread  ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  run_id  TEXT,
  kind    TEXT NOT NULL,
  summary TEXT NOT NULL,
  data    TEXT NOT NULL DEFAULT '{}',
  source  TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_events_run  ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);

CREATE TABLE IF NOT EXISTS sessions (
  thread_id  TEXT NOT NULL,
  agent      TEXT NOT NULL DEFAULT '',
  project    TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent, project)
);

CREATE TABLE IF NOT EXISTS confirmations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  answered_at  TEXT,
  tool         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  tier         TEXT NOT NULL,
  status       TEXT NOT NULL,             -- pending|approved|denied|timeout
  answered_by  TEXT,
  channel      TEXT
);
CREATE INDEX IF NOT EXISTS idx_conf_status ON confirmations(status);
CREATE INDEX IF NOT EXISTS idx_conf_run    ON confirmations(run_id);

CREATE TABLE IF NOT EXISTS notify_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  rule      TEXT NOT NULL,
  channel   TEXT NOT NULL,
  target    TEXT NOT NULL,
  run_id    TEXT,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_rule ON notify_log(rule, ts);

CREATE TABLE IF NOT EXISTS skills (
  name          TEXT PRIMARY KEY,
  trust         TEXT NOT NULL DEFAULT 'sandboxed',  -- sandboxed|restricted|trusted
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  authored_by   TEXT,                                -- run id that wrote it
  origin_task   TEXT,                                -- what the human actually asked for
  manifest      TEXT NOT NULL DEFAULT '{}',
  retired_at    TEXT,
  runs          INTEGER NOT NULL DEFAULT 0,
  successes     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_trust ON skills(trust);

CREATE TABLE IF NOT EXISTS skill_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skill      TEXT NOT NULL,
  ts         TEXT NOT NULL,
  run_id     TEXT,
  action     TEXT NOT NULL,      -- authored|edited|promoted|demoted|retired|restored
  detail     TEXT,
  diff       TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_history ON skill_history(skill, id);

CREATE TABLE IF NOT EXISTS skill_uses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  skill     TEXT NOT NULL,
  run_id    TEXT,
  ts        TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  ms        INTEGER,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_uses ON skill_uses(skill, id);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent  TEXT,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_hash ON devices(token_hash);

CREATE TABLE IF NOT EXISTS pairings (
  code        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT,
  device_id   TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  device_id   TEXT,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  // A run can be scoped to one skill, which pins it to that skill's manifest.
  { version: 2, sql: `ALTER TABLE runs ADD COLUMN skill TEXT;` },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS investigations (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  question    TEXT NOT NULL,
  project     TEXT,
  status      TEXT NOT NULL,          -- open|answered|blocked|abandoned
  channel     TEXT,
  thread_id   TEXT,
  run_id      TEXT,
  step        INTEGER NOT NULL DEFAULT 0,
  answer      TEXT,
  /** The check that exposed the problem, so a fix can be held to it. */
  origin_check TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_status ON investigations(status);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation TEXT NOT NULL,
  ts          TEXT NOT NULL,
  step        INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- observation|hypothesis|ruled_out|cause|blocked
  text        TEXT NOT NULL,
  evidence    TEXT,
  vault_path  TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_inv ON findings(investigation, id);
`,
  },
];

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite())(path);
  db.exec(SCHEMA);
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value?: string } | undefined;
  let version = row?.value ? Number(row.value) : 0;
  if (version === 0) {
    version = 1;
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(version));
  }
  for (const m of MIGRATIONS) {
    if (m.version > version) {
      db.exec(m.sql);
      db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(m.version));
      version = m.version;
    }
  }
  return db;
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, new Date().toISOString());
}
