import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export function isRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; added: number; removed: number }>;
  /** Full unified diff, capped so a huge refactor cannot blow up the event log. */
  patch: string;
  truncated: boolean;
}

const EMPTY_DIFF: DiffStat = { filesChanged: 0, insertions: 0, deletions: 0, files: [], patch: '', truncated: false };

/**
 * Branch-per-run. Every run gets its own branch off whatever was checked out,
 * so a bad run is one `git checkout -` away from gone. We never push — that is
 * an irreversible action and lives behind the confirm gate.
 */
export class GitWrapper {
  constructor(private readonly cwd: string) {}

  async currentBranch(): Promise<string> {
    return git(this.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async headSha(): Promise<string> {
    return git(this.cwd, ['rev-parse', 'HEAD']);
  }

  async isDirty(): Promise<boolean> {
    return (await git(this.cwd, ['status', '--porcelain'])).length > 0;
  }

  /** Create and check out `switchboard/<runId>`. Returns the branch name. */
  async startRun(runId: string): Promise<{ branch: string; base: string; baseSha: string }> {
    const base = await this.currentBranch();
    const baseSha = await this.headSha();
    const branch = `switchboard/${runId}`;
    await git(this.cwd, ['checkout', '-b', branch]);
    return { branch, base, baseSha };
  }

  /** Diff of everything the run touched, staged or not, against the base sha. */
  async finishRun(baseSha: string, maxPatchBytes = 200_000): Promise<DiffStat> {
    await git(this.cwd, ['add', '-A']).catch(() => '');
    const numstat = await git(this.cwd, ['diff', '--numstat', baseSha]);
    if (!numstat) return EMPTY_DIFF;

    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...rest] = line.split('\t');
        return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
      });

    const full = await git(this.cwd, ['diff', baseSha]);
    const truncated = Buffer.byteLength(full) > maxPatchBytes;

    return {
      filesChanged: files.length,
      insertions: files.reduce((n, f) => n + f.added, 0),
      deletions: files.reduce((n, f) => n + f.removed, 0),
      files,
      patch: truncated ? `${full.slice(0, maxPatchBytes)}\n… diff truncated …` : full,
      truncated,
    };
  }

  /** Commit whatever the run produced, so the branch is a real checkpoint. */
  async commit(message: string): Promise<string | null> {
    if (!(await this.isDirty())) return null;
    await git(this.cwd, ['add', '-A']);
    await git(this.cwd, ['commit', '-m', message, '--no-verify']);
    return this.headSha();
  }

  /** Return to the base branch, leaving the run branch in place for review. */
  async park(base: string): Promise<void> {
    await git(this.cwd, ['checkout', base]).catch(() => '');
  }

  /** Throw away a run branch entirely. */
  async discard(branch: string, base: string): Promise<void> {
    await git(this.cwd, ['checkout', '--', '.']).catch(() => '');
    await git(this.cwd, ['clean', '-fd']).catch(() => '');
    await git(this.cwd, ['checkout', base]).catch(() => '');
    await git(this.cwd, ['branch', '-D', branch]).catch(() => '');
  }

  async diffOfBranch(branch: string): Promise<string> {
    return git(this.cwd, ['diff', `${branch}~1`, branch]).catch(() => '');
  }
}

export function formatDiffStat(d: DiffStat): string {
  if (!d.filesChanged) return 'no file changes';
  return `${d.filesChanged} file${d.filesChanged === 1 ? '' : 's'}, +${d.insertions}/-${d.deletions}`;
}
