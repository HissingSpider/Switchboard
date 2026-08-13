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

export const DEVICE_COOKIE = 'swb_token';

export function cookieFrom(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The credential on a request, from any of the three places a browser can put
 * one.
 *
 * The cookie is not a convenience — it is the only one of the three that a
 * browser will attach to a top-level navigation. A token in localStorage can
 * only ever be added to `fetch`, so a paired phone opening the dashboard would
 * be refused at the document request and never get as far as running any JS.
 */
export function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? cookieFrom(req, DEVICE_COOKIE) ?? undefined;
}

/** Was this request made over TLS, directly or through a terminating proxy? */
export function isSecureRequest(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-proto'] === 'https') return true;
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/** A year-long, JS-invisible cookie. Revoking the device is what ends it. */
export function deviceCookie(token: string, secure: boolean): string {
  return [
    `${DEVICE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'Max-Age=31536000',
    'HttpOnly',
    // Lax still arrives on the top-level navigation we need it for, while
    // blocking the cross-site POSTs that would otherwise be a CSRF opening.
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
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
