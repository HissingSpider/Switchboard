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

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  // Future schema changes append here; version 1 is the base schema above.
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
