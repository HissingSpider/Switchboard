import { mkdtempSync, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../dist/config/load.js';
import { DEFAULT_CONFIG, type SwitchboardConfig } from '../dist/config/schema.js';
import type { LoadedConfig } from '../dist/config/load.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export interface Sandbox {
  root: string;
  cfg: LoadedConfig;
  projectDir: string;
  cleanup: () => void;
}

/** A throwaway data dir, a real git repo to run against, and the fake claude. */
export function sandbox(overrides: Partial<SwitchboardConfig> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'swb-test-'));
  const projectDir = join(root, 'proj');
  mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
  writeFileSync(join(projectDir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: projectDir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectDir });

  const configFile = join(root, 'config.json');
  const base: SwitchboardConfig = {
    ...DEFAULT_CONFIG,
    dataDir: join(root, 'data'),
    scratchDir: join(root, 'scratch'),
    skillsDir: join(root, 'skills'),
    claudeBin: process.execPath,
    gateway: { ...DEFAULT_CONFIG.gateway, port: 0 },
    projects: [{ name: 'proj', path: projectDir }],
    ...overrides,
  };
  writeFileSync(configFile, JSON.stringify(base, null, 2));
  chmodSync(configFile, 0o600);

  const cfg = resolvePaths(base, configFile);
  for (const dir of [cfg.resolved.dataDir, cfg.resolved.artifactsDir, cfg.resolved.logsDir, cfg.resolved.scratchDir, cfg.resolved.skillsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    root,
    cfg,
    projectDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Wrap the fake claude so `claudeBin` can be a single executable path. */
export function fakeClaudeShim(dir: string): string {
  const path = join(dir, 'fake-claude');
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

export function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
