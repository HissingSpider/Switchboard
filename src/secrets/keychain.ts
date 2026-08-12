import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Secrets live in the macOS Keychain, never in config.json.
 *
 * Config refers to them as `keychain:<service>[/<account>]`, or `env:NAME` for
 * things you'd rather keep in the launchd plist. Anything else is treated as a
 * literal (useful in tests; the doctor warns about it).
 */
const SERVICE_PREFIX = 'switchboard';

export function keychainRef(name: string): string {
  return `keychain:${SERVICE_PREFIX}/${name}`;
}

export function setSecret(name: string, value: string): void {
  execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE_PREFIX, '-a', name, '-w', value], { stdio: 'ignore' });
}

export function getSecret(name: string): string | undefined {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE_PREFIX, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function deleteSecret(name: string): boolean {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE_PREFIX, '-a', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function listSecrets(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('security', ['dump-keychain'], { maxBuffer: 32 * 1024 * 1024 });
    const names = new Set<string>();
    const blocks = stdout.split(/\nkeychain: /);
    for (const b of blocks) {
      if (!b.includes(`"${SERVICE_PREFIX}"`)) continue;
      const m = /"acct"<blob>="([^"]+)"/.exec(b);
      if (m) names.add(m[1]!);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

/** Resolve a single ref. Returns undefined if the secret is missing. */
export function resolveRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  if (ref.startsWith('keychain:')) {
    const spec = ref.slice('keychain:'.length);
    const account = spec.includes('/') ? spec.slice(spec.indexOf('/') + 1) : spec;
    return getSecret(account);
  }
  return ref;
}

const REF_RE = /^(keychain:|env:)/;

/** Deep-copy a structure, replacing every secret ref string with its value. */
export function resolveSecretRefs<T>(value: T): T {
  if (typeof value === 'string') {
    return (REF_RE.test(value) ? (resolveRef(value) ?? '') : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecretRefs(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveSecretRefs(v);
    return out as unknown as T;
  }
  return value;
}

/** True if the string looks like a raw secret sitting in config where a ref should be. */
export function looksLikeRawSecret(value: string): boolean {
  if (REF_RE.test(value)) return false;
  return /^(sk-|xox|ghp_|github_pat_|AKIA|bot\d+:)/.test(value) || (value.length >= 32 && /^[A-Za-z0-9_\-]+$/.test(value));
}
