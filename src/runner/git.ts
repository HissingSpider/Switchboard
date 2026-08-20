import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep } from 'node:path';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export function isRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * `resolve()` plus symlinks, and tolerant of a path that no longer exists —
 * a deleted file still has to reduce to the same repo-relative name as its
 * living neighbours, so the deepest ancestor that does exist is resolved and
 * the rest is re-appended.
 */
function realResolve(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realResolve(parent), basename(abs));
  }
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; added: number; removed: number }>;
  /** Full unified diff, capped so a huge refactor cannot blow up the event log. */
  patch: string;
  truncated: boolean;
  /**
   * Dirty paths this run was never observed to write, left unstaged on purpose.
   * Usually the operator editing the same checkout while the run was going;
   * sometimes a change the run made through a shell command we cannot attribute.
   * Either way it is theirs to commit, not ours.
   */
  unclaimed: string[];
}

const EMPTY_DIFF: DiffStat = { filesChanged: 0, insertions: 0, deletions: 0, files: [], patch: '', truncated: false, unclaimed: [] };

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

  /**
   * Create and check out `switchboard/<runId>`.
   *
   * Anything the operator had uncommitted is stashed first. Without that, the
   * run's `git add -A` sweeps their work-in-progress into its own commit, and
   * parking back to the base branch then deletes it from the working tree —
   * silently, because the branch still has it. That has actually happened here:
   * a source file vanished mid-session and only a gitignored build artifact
   * hid the damage.
   *
   * Stashing also makes the run's diff honest: it contains what the agent did
   * and not what the human happened to be halfway through.
   */
  async startRun(runId: string): Promise<{ branch: string; base: string; baseSha: string; stashed: boolean }> {
    const base = await this.currentBranch();
    const stashed = await this.isDirty();
    if (stashed) {
      await git(this.cwd, ['stash', 'push', '--include-untracked', '-m', `switchboard: work in progress before ${runId}`]);
    }
    const baseSha = await this.headSha();
    const branch = `switchboard/${runId}`;
    await git(this.cwd, ['checkout', '-b', branch]);
    return { branch, base, baseSha, stashed };
  }

  /**
   * Return to the base branch and give the operator their work back.
   *
   * A failed pop is left alone rather than forced: the stash still holds
   * everything, and reporting it is far better than resolving a conflict on
   * someone's behalf.
   */
  async restore(base: string, stashed: boolean): Promise<{ restored: boolean; problem?: string }> {
    await this.park(base);
    if (!stashed) return { restored: true };
    try {
      await git(this.cwd, ['stash', 'pop']);
      return { restored: true };
    } catch (err) {
      return {
        restored: false,
        problem: `your uncommitted work is still in \`git stash list\` — pop it by hand: ${(err as Error).message.split('\n')[0]}`,
      };
    }
  }

  /** Every dirty path in the working tree, repo-relative. */
  private async dirtyPaths(): Promise<string[]> {
    const out = await git(this.cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (!out) return [];
    // -z is NUL-separated with no quoting, which is the only form that survives
    // a path containing a space or a quote. A rename record carries two names;
    // the second is where the file is now.
    const parts = out.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      const status = entry.slice(0, 2);
      paths.push(entry.slice(3));
      if (status.startsWith('R') || status.startsWith('C')) {
        // The rename's source follows as its own record.
        const source = parts[++i];
        if (source) paths.push(source);
      }
    }
    return paths;
  }

  /**
   * Absolute or relative, inside this repo or not — reduce to a pathspec.
   *
   * Symlinks have to be resolved on both sides or nothing matches on macOS,
   * where the run's own `cwd` comes back as `/private/var/...` and the
   * configured project path is the `/var/...` the operator wrote down. A prefix
   * comparison between those two is false for every path in the repo, and the
   * result is a run that commits nothing at all.
   */
  private toRepoPaths(paths: readonly string[]): string[] {
    const root = realResolve(this.cwd);
    const out = new Set<string>();
    for (const p of paths) {
      const abs = realResolve(resolve(root, p));
      if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
      const rel = relative(root, abs);
      if (rel) out.add(rel);
    }
    return [...out];
  }

  /**
   * Stage exactly what this run wrote, and diff that against the base sha.
   *
   * `claimed` is the set of paths the gate actually saw the run write. Anything
   * else that is dirty stays unstaged and uncommitted, and comes back in
   * `unclaimed`.
   *
   * This used to be `git add -A`, and the stash in `startRun()` was supposed to
   * make that safe. It only closes the door at t=0: the operator edits their
   * own checkout while the run is going, and half an hour later `add -A` sweeps
   * those edits into the run's commit — under the run's message, in a commit
   * about something else entirely. That has happened here.
   *
   * The trade is deliberate. A change the run made through a shell command —
   * `sed -i`, a codemod, an installer touching a lockfile — is not attributable
   * to it, so it lands in `unclaimed` and stays in the working tree for a person
   * to commit. Leaving a real change uncommitted is recoverable; committing
   * someone's unrelated work under a message that does not describe it is not.
   */
  async finishRun(baseSha: string, claimed: readonly string[], maxPatchBytes = 200_000): Promise<DiffStat> {
    const wanted = this.toRepoPaths(claimed);
    const dirty = await this.dirtyPaths();
    const unclaimed = dirty.filter((p) => !wanted.includes(p));

    // `--` and one path per argument: a path that looks like a flag, or holds a
    // glob character, must not be read as either.
    if (wanted.length) await git(this.cwd, ['add', '--', ...wanted]).catch(() => '');

    const numstat = await git(this.cwd, ['diff', '--numstat', '--cached', baseSha]);
    if (!numstat) return { ...EMPTY_DIFF, unclaimed };

    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...rest] = line.split('\t');
        return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
      });

    const full = await git(this.cwd, ['diff', '--cached', baseSha]);
    const truncated = Buffer.byteLength(full) > maxPatchBytes;

    return {
      filesChanged: files.length,
      insertions: files.reduce((n, f) => n + f.added, 0),
      deletions: files.reduce((n, f) => n + f.removed, 0),
      files,
      patch: truncated ? `${full.slice(0, maxPatchBytes)}\n… diff truncated …` : full,
      truncated,
      unclaimed,
    };
  }

  /**
   * Commit what `finishRun()` staged, and only that. No `add` here — the index
   * is the decision about what belongs to this run, and it was already made.
   */
  async commit(message: string): Promise<string | null> {
    const staged = await git(this.cwd, ['diff', '--cached', '--name-only']);
    if (!staged) return null;
    await git(this.cwd, ['commit', '-m', message, '--no-verify']);
    return this.headSha();
  }

  /** Return to the base branch, leaving the run branch in place for review. */
  async park(base: string): Promise<void> {
    await git(this.cwd, ['checkout', base]).catch(() => '');
  }

  /**
   * Throw away a run branch entirely.
   *
   * Only ever safe on a checkout nobody else is using: `checkout -- .` and
   * `clean -fd` do not know whose changes they are discarding, and on the
   * operator's own working tree they would take theirs too.
   */
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

/** Takes the counts only, so a caller that has reconstructed them from a patch
 *  does not have to invent the fields it has no answer for. */
export function formatDiffStat(d: Pick<DiffStat, 'filesChanged' | 'insertions' | 'deletions'>): string {
  if (!d.filesChanged) return 'no file changes';
  return `${d.filesChanged} file${d.filesChanged === 1 ? '' : 's'}, +${d.insertions}/-${d.deletions}`;
}
