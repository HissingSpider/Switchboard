import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ArtifactRef {
  runId: string;
  name: string;
  path: string;
  bytes: number;
}

/**
 * On-disk run artifacts: raw stream-json transcript, the final diff, stderr,
 * screenshots. The event log keeps summaries; the heavy bytes live here.
 * Layout: <artifactsDir>/<YYYY-MM>/<runId>/<name>
 */
export class ArtifactStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  dirFor(runId: string, createdAt = new Date()): string {
    const bucket = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
    const dir = join(this.root, bucket, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Locate a run's directory without knowing which month bucket it landed in. */
  findDir(runId: string): string | undefined {
    for (const bucket of readdirSync(this.root)) {
      const dir = join(this.root, bucket, runId);
      if (existsSync(dir)) return dir;
    }
    return undefined;
  }

  write(runId: string, name: string, contents: string | Buffer): ArtifactRef {
    const path = join(this.dirFor(runId), name);
    writeFileSync(path, contents);
    return { runId, name, path, bytes: statSync(path).size };
  }

  append(runId: string, name: string, line: string): void {
    appendFileSync(join(this.dirFor(runId), name), line.endsWith('\n') ? line : `${line}\n`);
  }

  read(runId: string, name: string): string | undefined {
    const dir = this.findDir(runId);
    if (!dir) return undefined;
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  list(runId: string): ArtifactRef[] {
    const dir = this.findDir(runId);
    if (!dir) return [];
    return readdirSync(dir).map((name) => {
      const path = join(dir, name);
      return { runId, name, path, bytes: statSync(path).size };
    });
  }

  /** Delete run directories older than `days`. Returns run ids pruned. */
  prune(days: number): string[] {
    if (days <= 0) return [];
    const cutoff = Date.now() - days * 86_400_000;
    const pruned: string[] = [];
    for (const bucket of readdirSync(this.root)) {
      const bucketDir = join(this.root, bucket);
      if (!statSync(bucketDir).isDirectory()) continue;
      for (const runId of readdirSync(bucketDir)) {
        const dir = join(bucketDir, runId);
        if (statSync(dir).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          pruned.push(runId);
        }
      }
      if (readdirSync(bucketDir).length === 0) rmSync(bucketDir, { recursive: true, force: true });
    }
    return pruned;
  }

  totalBytes(): number {
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else total += statSync(p).size;
      }
    };
    walk(this.root);
    return total;
  }
}
