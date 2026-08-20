import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * When the stored Claude credential expires — and nothing else about it.
 *
 * This exists to answer one question: has someone fixed the login since we gave
 * up? The token itself is deliberately never read into a variable, returned, or
 * logged. A timestamp is the whole answer, and a credential reader that hands
 * back credentials is a credential reader waiting to end up in an event log.
 */
export interface CredentialClock {
  /** Epoch ms the access token expires, if a credential could be read at all. */
  expiresAt?: number;
  /** Epoch ms the refresh token expires — past this, only a human can fix it. */
  refreshExpiresAt?: number;
  source: 'keychain' | 'file' | 'env' | 'none';
}

function parse(raw: string, source: CredentialClock['source']): CredentialClock {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const o = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { expiresAt: num(o.expiresAt), refreshExpiresAt: num(o.refreshTokenExpiresAt), source };
  } catch {
    return { source };
  }
}

/**
 * Test seam.
 *
 * The alternative is a test that passes or fails depending on whether whoever
 * runs it happens to be logged in — which is exactly the kind of test that gets
 * deleted six months later for being flaky.
 */
let override: (() => CredentialClock) | null = null;

export function setCredentialClockForTest(fn: (() => CredentialClock) | null): void {
  override = fn;
}

/**
 * Read the expiry without blocking.
 *
 * `security` is normally fast, but a locked Keychain can hold it for the whole
 * timeout — and this runs on the sweeper. Synchronously, that stalls the event
 * loop: during a halt the gateway would stop answering and the dashboard would
 * freeze for five seconds every fifteen.
 */
export async function readCredentialClock(): Promise<CredentialClock> {
  if (override) return override();

  // An explicit key never expires on its own, so there is nothing to watch.
  if (process.env.ANTHROPIC_API_KEY) return { source: 'env' };

  const file = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(file)) {
    try {
      return parse(readFileSync(file, 'utf8'), 'file');
    } catch {
      /* fall through to the Keychain */
    }
  }

  try {
    // `security` prints the secret on stdout; it is parsed for one number and
    // the string is never retained.
    const { stdout } = await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return parse(stdout.trim(), 'keychain');
  } catch {
    return { source: 'none' };
  }
}
