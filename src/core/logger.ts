import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: number = LEVELS[(process.env.SWB_LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;
let logFile: string | null = null;
let maxBytes = 8 * 1024 * 1024;
let keep = 5;

export function configureLogger(opts: { level?: LogLevel; file?: string | null; maxBytes?: number; keep?: number }): void {
  if (opts.level) minLevel = LEVELS[opts.level];
  if (opts.file !== undefined) {
    logFile = opts.file;
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  }
  if (opts.maxBytes) maxBytes = opts.maxBytes;
  if (opts.keep) keep = opts.keep;
}

function rotateIfNeeded(): void {
  if (!logFile) return;
  try {
    const st = statSync(logFile);
    if (st.size < maxBytes) return;
  } catch {
    return; // no file yet
  }
  const dir = dirname(logFile);
  const base = logFile.slice(dir.length + 1);
  renameSync(logFile, join(dir, `${base}.${Date.now()}`));
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`))
    .sort()
    .reverse();
  for (const f of old.slice(keep)) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* best effort */
    }
  }
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(extra !== undefined ? { extra } : {}),
  });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
  if (logFile) {
    rotateIfNeeded();
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      /* logging must never throw */
    }
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(sub: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}

export function logFileExists(): boolean {
  return !!logFile && existsSync(logFile);
}
