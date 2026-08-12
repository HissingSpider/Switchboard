import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryEntry {
  id: string;
  scope: string;
  text: string;
  createdAt: string;
  tags: string[];
}

/**
 * Memory for work that isn't a project.
 *
 * Coding runs get their memory from DeerDawn, keyed to a project. Assistant
 * runs — "what did I decide about the dentist", "remind me what the plan for
 * Saturday was" — have no repo to hang off, so they get a flat, per-scope
 * markdown store here. One file per scope, appended to, small enough to inject
 * whole.
 */
export class WorkspaceMemory {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(scope: string): string {
    return join(this.dir, `${scope.replace(/[^a-z0-9_-]/gi, '_')}.md`);
  }

  scopes(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  }

  read(scope: string): string {
    const f = this.file(scope);
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }

  entries(scope: string): MemoryEntry[] {
    const raw = this.read(scope);
    const out: MemoryEntry[] = [];
    for (const block of raw.split('\n## ').slice(1)) {
      const [header = '', ...rest] = block.split('\n');
      const m = /^(\S+)\s+(\S+)(?:\s+\[(.*)\])?$/.exec(header.trim());
      out.push({
        id: m?.[1] ?? '',
        createdAt: m?.[2] ?? '',
        tags: (m?.[3] ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        scope,
        text: rest.join('\n').trim(),
      });
    }
    return out;
  }

  append(scope: string, text: string, tags: string[] = []): MemoryEntry {
    const entry: MemoryEntry = {
      id: `m${Date.now().toString(36)}`,
      scope,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      tags,
    };
    const f = this.file(scope);
    const header = `\n## ${entry.id} ${entry.createdAt}${tags.length ? ` [${tags.join(', ')}]` : ''}\n`;
    const existing = existsSync(f) ? readFileSync(f, 'utf8') : `# ${scope} memory\n`;
    writeFileSync(f, `${existing}${header}${entry.text}\n`);
    return entry;
  }

  search(scope: string, query: string, limit = 5): MemoryEntry[] {
    const q = query.toLowerCase();
    const words = q.split(/\W+/).filter((w) => w.length > 3);
    return this.entries(scope)
      .map((e) => {
        const text = e.text.toLowerCase();
        let score = text.includes(q) ? 10 : 0;
        for (const w of words) if (text.includes(w)) score += 1;
        for (const t of e.tags) if (q.includes(t.toLowerCase())) score += 3;
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** The block injected into an assistant run's system prompt. */
  contextFor(scope: string, query: string, maxChars = 2000): string {
    const hits = this.search(scope, query, 6);
    if (!hits.length) return '';
    let out = `Things you already know about "${scope}":\n`;
    for (const h of hits) {
      const line = `- (${h.createdAt.slice(0, 10)}) ${h.text.replace(/\n+/g, ' ')}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return out.trim();
  }

  forget(scope: string): boolean {
    const f = this.file(scope);
    if (!existsSync(f)) return false;
    unlinkSync(f);
    return true;
  }
}
