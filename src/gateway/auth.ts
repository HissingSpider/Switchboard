import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getSecret, setSecret, resolveRef } from '../secrets/keychain.js';
import type { GatewayConfig } from '../config/schema.js';

const TOKEN_ACCOUNT = 'gateway-token';
const HOOK_ACCOUNT = 'hook-token';

function ensure(account: string): string {
  const existing = getSecret(account);
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  try {
    setSecret(account, token);
  } catch {
    // No Keychain (CI, tests) — an ephemeral token still protects the socket
    // for the lifetime of this process.
  }
  return token;
}

export function gatewayToken(cfg: GatewayConfig): string {
  return resolveRef(cfg.authTokenRef) ?? ensure(TOKEN_ACCOUNT);
}

/** Separate token for the PreToolUse hook so a leaked dashboard token can't gate actions. */
export function hookToken(): string {
  return ensure(HOOK_ACCOUNT);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? undefined;
}

/** Headers that prove a request was forwarded rather than made locally. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login'];

/**
 * True only for a request that genuinely originated on this machine.
 *
 * The socket address alone is not enough. `tailscale serve` terminates TLS and
 * proxies to 127.0.0.1, so every request from every device on the tailnet looks
 * like loopback — and loopback is the one case that skips the token. Any
 * forwarding header means somebody else's request is wearing our address, and
 * it has to authenticate like anyone else.
 */
export function isLoopback(req: IncomingMessage): boolean {
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Who Tailscale says made this request, when it came through `tailscale serve`. */
export function forwardedIdentity(req: IncomingMessage): { login?: string; via: string } | undefined {
  const login = req.headers['tailscale-user-login'];
  const forwardedFor = req.headers['x-forwarded-for'];
  if (!login && !forwardedFor) return undefined;
  return { login: typeof login === 'string' ? login : undefined, via: typeof forwardedFor === 'string' ? forwardedFor : 'proxy' };
}

export interface AuthOptions {
  token: string;
  trustedHosts: string[];
  /** Loopback requests skip the token — the dashboard on the Mac Mini itself. */
  allowLoopbackWithoutToken: boolean;
}

export function authorize(req: IncomingMessage, opts: AuthOptions): { ok: true } | { ok: false; status: number; message: string } {
  // Guard against DNS rebinding: only answer to hosts we expect.
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  const hostOk =
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    opts.trustedHosts.includes(host) ||
    host.endsWith('.ts.net'); // Tailscale MagicDNS
  if (!hostOk) return { ok: false, status: 403, message: `host "${host}" is not trusted` };

  const provided = bearerFrom(req);
  if (provided && safeEqual(provided, opts.token)) return { ok: true };
  if (opts.allowLoopbackWithoutToken && isLoopback(req)) return { ok: true };
  return { ok: false, status: 401, message: 'missing or invalid token' };
}

export function newToken(): string {
  const token = randomBytes(24).toString('base64url');
  setSecret(TOKEN_ACCOUNT, token);
  return token;
}
