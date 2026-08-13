import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep, relative } from 'node:path';
import { expandPath } from '../config/load.js';
import type { VaultConfig } from '../config/schema.js';
import { logger } from '../core/logger.js';

const exec = promisify(execFile);
const log = logger('vault');

/**
 * An Obsidian vault as the narrative store.
 *
 * DeerDawn holds structured memory — decisions, paths, board state. That is the
 * right shape for a machine and the wrong shape for a story: why a thing was
 * built the way it was, what was tried and abandoned, what a week of work
 * actually amounted to. That belongs in prose, in a vault the owner already
 * reads and edits by hand.
 *
 * Two rules make this safe to hand to an agent:
 *
 *  1. Writes are confined to one subfolder. The rest of the vault is the
 *     owner's, and an agent that can rewrite years of personal notes is not a
 *     tool, it is a hazard. Enforced by path check, not by instruction.
 *  2. Reads are pull, not scan. The vault is not searched for context; it is
 *     read only when a DeerDawn record explicitly points into it. Otherwise
 *     every run would drag in whatever happened to be lying around.
 */
export interface VaultNote {
  path: string;
  /** Path relative to the vault root — the form used as a pointer. */
  ref: string;
  title: string;
  body: string;
  updatedAt: string;
}

export class VaultError extends Error {}

export class Vault {
  readonly root: string;
  readonly writeRoot: string;

  constructor(private readonly cfg: VaultConfig) {
    this.root = cfg.path ? expandPath(cfg.path) : '';
    this.writeRoot = this.root ? join(this.root, cfg.writeSubfolder ?? 'switchboard') : '';
  }

  get enabled(): boolean {
    return Boolean(this.cfg.enabled && this.root && existsSync(this.root));
  }

  get problems(): string[] {
    const problems: string[] = [];
    if (!this.cfg.enabled) return ['vault disabled'];
    if (!this.cfg.path) problems.push('vault.path is not set');
    else if (!existsSync(this.root)) problems.push(`${this.root} does not exist`);
    else if (!existsSync(join(this.root, '.obsidian'))) problems.push(`${this.root} does not look like an Obsidian vault (no .obsidian)`);
    if (this.cfg.git && this.root && !existsSync(join(this.root, '.git'))) {
      problems.push(`${this.root} is not a git repo — vault history will not be recoverable`);
    }
    return problems;
  }

  /** Absolute path for a ref, refusing anything outside the writable subfolder. */
  private resolveWrite(ref: string): string {
    if (!this.enabled) throw new VaultError('vault is not configured');
    // An absolute path is refused rather than reinterpreted. Quietly rewriting
    // /etc/passwd.md into <vault>/switchboard/etc/passwd.md would "work" and be
    // deeply confusing — a write that lands somewhere other than where it was
    // aimed is worse than one that fails.
    if (ref.startsWith('/')) throw new VaultError(`vault refs are relative to ${this.writeRoot}, got an absolute path: ${ref}`);
    const sub = this.cfg.writeSubfolder ?? 'switchboard';
    const target = resolve(this.writeRoot, ref.startsWith(`${sub}${sep}`) ? relative(sub, ref) : ref);
    if (target !== this.writeRoot && !target.startsWith(this.writeRoot + sep)) {
      throw new VaultError(`refusing to write outside ${this.writeRoot} (asked for ${ref})`);
    }
    if (!target.endsWith('.md')) throw new VaultError('vault notes must be .md files');
    return target;
  }

  /** Reads may come from anywhere in the vault, but only via an explicit ref. */
  private resolveRead(ref: string): string {
    if (!this.enabled) throw new VaultError('vault is not configured');
    const target = resolve(this.root, ref.replace(/^\/+/, ''));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new VaultError(`"${ref}" is outside the vault`);
    }
    return target;
  }

  /**
   * Write a note. Returns the ref to store on the DeerDawn record — that
   * pointer is the only thing that will ever cause this note to be read again.
   */
  async write(ref: string, title: string, body: string, opts: { commitMessage?: string } = {}): Promise<VaultNote> {
    const path = this.resolveWrite(ref);
    mkdirSync(join(path, '..'), { recursive: true });

    const frontmatter = ['---', `title: ${title.replace(/\n/g, ' ')}`, `source: switchboard`, `updated: ${new Date().toISOString()}`, '---', ''].join('\n');
    writeFileSync(path, `${frontmatter}\n${body.trim()}\n`);

    if (this.cfg.git) await this.commit(opts.commitMessage ?? `switchboard: ${title}`, path);

    return {
      path,
      ref: relative(this.root, path),
      title,
      body,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Append to an existing note, or create it. Used for running narratives. */
  async append(ref: string, title: string, section: string, opts: { commitMessage?: string } = {}): Promise<VaultNote> {
    const path = this.resolveWrite(ref);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!existing) return this.write(ref, title, section, opts);
    writeFileSync(path, `${existing.trimEnd()}\n\n${section.trim()}\n`);
    if (this.cfg.git) await this.commit(opts.commitMessage ?? `switchboard: append to ${title}`, path);
    return { path, ref: relative(this.root, path), title, body: section, updatedAt: new Date().toISOString() };
  }

  /** Read a note by ref. This is the only way anything gets read. */
  read(ref: string): VaultNote | undefined {
    const path = this.resolveRead(ref);
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    const raw = readFileSync(path, 'utf8');
    const titleMatch = /^title:\s*(.+)$/m.exec(raw);
    return {
      path,
      ref: relative(this.root, path),
      title: titleMatch?.[1] ?? ref,
      body: raw.replace(/^---[\s\S]*?---\n/, '').trim(),
      updatedAt: statSync(path).mtime.toISOString(),
    };
  }

  /** Notes Switchboard has written. Deliberately does not list the whole vault. */
  ours(): string[] {
    if (!this.enabled || !existsSync(this.writeRoot)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.md')) out.push(relative(this.root, p));
      }
    };
    walk(this.writeRoot);
    return out.sort();
  }

  private async commit(message: string, path: string): Promise<void> {
    try {
      await exec('git', ['add', path], { cwd: this.root });
      await exec('git', ['commit', '-m', message, '--no-verify', '--', path], { cwd: this.root });
    } catch (err) {
      // A vault with nothing to commit, or one the owner has mid-rebase. Not
      // worth failing the write over — the file is on disk either way.
      log.debug('vault commit skipped', { err: (err as Error).message });
    }
  }

  /** Where a run's narrative note goes. */
  refForRun(runId: string, slug: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join('runs', `${date}-${runId}-${slugify(slug)}.md`);
  }

  refForInvestigation(id: string, question: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join('investigations', `${date}-${id}-${slugify(question)}.md`);
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'note'
  );
}

/**
 * The pointer stored on a DeerDawn entity or finding. Kept as a plain relative
 * path so it stays meaningful if the vault moves, and so it is obvious in the
 * record what it refers to.
 */
export function vaultPointer(ref: string): string {
  return `vault:${ref}`;
}

export function parseVaultPointer(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('vault:') ? value.slice('vault:'.length) : undefined;
}
