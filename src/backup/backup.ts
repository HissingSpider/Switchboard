import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { openDb } from '../store/db.js';

const exec = promisify(execFile);

export interface BackupResult {
  path: string;
  bytes: number;
  includedArtifacts: boolean;
}

/**
 * Backup and restore.
 *
 * The event log is the thing you actually cannot lose — it is the only record
 * of what the agents did. Artifacts are optional because they are large and
 * mostly reproducible; config and agent definitions are small and always in.
 *
 * The db is copied with sqlite's own backup so a live WAL doesn't produce a
 * torn file.
 */
export async function backup(cfg: LoadedConfig, destDir: string, opts: { artifacts?: boolean } = {}): Promise<BackupResult> {
  mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = join(destDir, `.staging-${stamp}`);
  mkdirSync(staging, { recursive: true });

  // Consistent snapshot of the database.
  const db = openDb(cfg.resolved.dbPath);
  db.exec(`VACUUM INTO '${join(staging, 'switchboard.db').replace(/'/g, "''")}'`);
  db.close();

  if (existsSync(cfg.resolved.configFile)) copyFileSync(cfg.resolved.configFile, join(staging, basename(cfg.resolved.configFile)));

  const agentsDir = join(cfg.resolved.dataDir, 'agents');
  if (existsSync(agentsDir)) await exec('cp', ['-R', agentsDir, join(staging, 'agents')]);
  if (existsSync(cfg.resolved.skillsDir)) await exec('cp', ['-R', cfg.resolved.skillsDir, join(staging, 'skills')]);

  const includedArtifacts = Boolean(opts.artifacts) && existsSync(cfg.resolved.artifactsDir);
  if (includedArtifacts) await exec('cp', ['-R', cfg.resolved.artifactsDir, join(staging, 'runs')]);

  const archive = join(destDir, `switchboard-${stamp}.tar.gz`);
  await exec('tar', ['-czf', archive, '-C', staging, '.']);
  rmSync(staging, { recursive: true, force: true });

  return { path: archive, bytes: statSync(archive).size, includedArtifacts };
}

export interface RestorePlan {
  archive: string;
  targets: string[];
  /** Files that already exist and would be overwritten. */
  conflicts: string[];
}

export async function inspectBackup(archive: string): Promise<string[]> {
  const { stdout } = await exec('tar', ['-tzf', archive]);
  return stdout.split('\n').filter(Boolean);
}

export async function planRestore(cfg: LoadedConfig, archive: string): Promise<RestorePlan> {
  const entries = await inspectBackup(archive);
  const conflicts: string[] = [];
  if (entries.some((e) => e.includes('switchboard.db')) && existsSync(cfg.resolved.dbPath)) conflicts.push(cfg.resolved.dbPath);
  if (entries.some((e) => e.includes('config.json')) && existsSync(cfg.resolved.configFile)) conflicts.push(cfg.resolved.configFile);
  return { archive, targets: [cfg.resolved.dataDir], conflicts };
}

/**
 * Restore is deliberately not automatic: it moves the existing data dir aside
 * rather than deleting it, so a mistaken restore is recoverable.
 */
export async function restore(cfg: LoadedConfig, archive: string): Promise<{ restoredTo: string; previousMovedTo?: string }> {
  if (!existsSync(archive)) throw new Error(`no such archive: ${archive}`);
  let previousMovedTo: string | undefined;
  if (existsSync(cfg.resolved.dataDir) && readdirSync(cfg.resolved.dataDir).length) {
    previousMovedTo = `${cfg.resolved.dataDir}.pre-restore-${Date.now()}`;
    await exec('mv', [cfg.resolved.dataDir, previousMovedTo]);
  }
  mkdirSync(cfg.resolved.dataDir, { recursive: true });
  await exec('tar', ['-xzf', archive, '-C', cfg.resolved.dataDir]);
  return { restoredTo: cfg.resolved.dataDir, previousMovedTo };
}

/** Keep the newest `keep` archives, delete the rest. */
export function pruneBackups(dir: string, keep = 7): string[] {
  if (!existsSync(dir)) return [];
  const archives = readdirSync(dir)
    .filter((f) => f.startsWith('switchboard-') && f.endsWith('.tar.gz'))
    .sort()
    .reverse();
  const doomed = archives.slice(keep);
  for (const f of doomed) rmSync(join(dir, f), { force: true });
  return doomed;
}
