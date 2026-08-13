import { createECDH, createHmac, createCipheriv, randomBytes, createSign, createPrivateKey } from 'node:crypto';
import type { Db } from '../store/db.js';
import type { EventLog } from '../store/eventlog.js';
import { getSecret, setSecret } from '../secrets/keychain.js';
import { shortId } from '../core/ids.js';
import { logger } from '../core/logger.js';

const log = logger('push');

/**
 * Web Push, implemented here rather than pulled in.
 *
 * The point of the card was "no dev account" — Web Push needs no Apple or
 * Google developer programme, no APNs certificate, no FCM project. It needs one
 * self-generated VAPID keypair and about two hundred lines of RFC 8291 and RFC
 * 8188. That's cheaper than the dependency and it keeps the approval path — the
 * one notification that actually matters — free of a third party.
 *
 * iOS supports this only for a Home Screen-installed PWA, which is why the
 * manifest and service worker exist.
 */

const b64u = (buf: Buffer): string => buf.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF, the two-step form the Web Push RFCs are written against. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  const output = hmac(prk, Buffer.concat([info, Buffer.from([1])]));
  return output.subarray(0, length);
}

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url, 32-byte scalar
}

const VAPID_ACCOUNT = 'vapid-keys';

/** Generate a VAPID keypair. Self-signed; nobody has to issue it. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Load the keypair from the Keychain, generating it the first time. */
export function loadVapidKeys(): VapidKeys {
  const stored = getSecret(VAPID_ACCOUNT);
  if (stored) {
    try {
      return JSON.parse(stored) as VapidKeys;
    } catch {
      /* regenerate below */
    }
  }
  const keys = generateVapidKeys();
  try {
    setSecret(VAPID_ACCOUNT, JSON.stringify(keys));
  } catch {
    // No Keychain (CI): the keys live for this process only, which means
    // subscriptions won't survive a restart. Acceptable for tests, logged for real.
    log.warn('VAPID keys could not be persisted — push subscriptions will not survive a restart');
  }
  return keys;
}

/** A 32-byte raw P-256 scalar wrapped as a PKCS#8 key so `createSign` accepts it. */
function privateKeyObject(vapid: VapidKeys): ReturnType<typeof createPrivateKey> {
  const priv = fromB64u(vapid.privateKey);
  const pub = fromB64u(vapid.publicKey);
  // SEC1 EC private key inside a PKCS#8 wrapper. Hand-assembled because node
  // will not import a bare 32-byte scalar, and the fixed-size P-256 encoding
  // makes a full DER library unnecessary.
  const der = Buffer.concat([
    Buffer.from([0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20]),
    priv,
    Buffer.from([0xa1, 0x44, 0x03, 0x42, 0x00]),
    pub,
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** DER ECDSA signature → the raw r||s form JWS wants. */
function derToRaw(der: Buffer): Buffer {
  let offset = 2;
  if (der[1]! & 0x80) offset += der[1]! & 0x7f;
  const readInt = (): Buffer => {
    const len = der[offset + 1]!;
    let value = der.subarray(offset + 2, offset + 2 + len);
    offset += 2 + len;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - value.length), value]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

/** The VAPID Authorization header for one push origin. */
export function vapidHeader(endpoint: string, vapid: VapidKeys, subject: string): string {
  const audience = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${body}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  const signature = derToRaw(signer.sign(privateKeyObject(vapid)));
  return `vapid t=${signingInput}.${b64u(signature)}, k=${vapid.publicKey}`;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/**
 * Encrypt a payload for one subscription, aes128gcm (RFC 8188) with the key
 * derivation from RFC 8291.
 */
export function encryptPayload(plaintext: Buffer, keys: PushSubscriptionKeys): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);

  const server = createECDH('prime256v1');
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(uaPublic);

  // IKM binds both public keys, so a payload can't be replayed at another client.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, serverPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the last (and only) record.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, ciphertext]);
}

export interface PushSubscription {
  id: string;
  deviceId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
}

interface SubRow {
  id: string;
  device_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_ok_at: string | null;
  failures: number;
}

const toSub = (r: SubRow): PushSubscription => ({
  id: r.id,
  deviceId: r.device_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
  failures: r.failures,
});

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it should land. */
  url?: string;
  /** Same tag replaces an earlier notification rather than stacking. */
  tag?: string;
  /** Approval notifications get action buttons. */
  actions?: Array<{ action: string; title: string }>;
  data?: Record<string, unknown>;
  requireInteraction?: boolean;
}

/**
 * The VAPID `sub` claim is a contact for whoever runs the push service, and the
 * push providers actually check it. Apple rejects the whole JWT with
 * `BadJwtToken` — not a helpful error about the subject — if it is a mailto
 * with an implausible domain, which `localhost` very much is.
 */
export function isValidVapidSubject(subject: string | undefined): boolean {
  if (!subject) return false;
  if (subject.startsWith('https://')) {
    try {
      const host = new URL(subject).hostname;
      return host.includes('.') && host !== 'localhost';
    } catch {
      return false;
    }
  }
  if (!subject.startsWith('mailto:')) return false;
  const address = subject.slice('mailto:'.length);
  const [, domain] = address.split('@');
  return Boolean(domain && domain.includes('.') && !domain.endsWith('.localhost') && domain !== 'localhost');
}

export class PushService {
  private readonly vapid: VapidKeys;
  private readonly subject: string;

  constructor(
    private readonly db: Db,
    private readonly events: EventLog,
    subject?: string,
  ) {
    this.vapid = loadVapidKeys();
    if (subject && !isValidVapidSubject(subject)) {
      log.warn('gateway.pushSubject is not a valid VAPID contact — push will be rejected', { subject });
    }
    // No silent fallback to a placeholder: one that looks fine and fails with an
    // opaque 403 is worse than an obviously missing setting.
    this.subject = subject ?? '';
  }

  /** Why push cannot work right now, if it cannot. */
  get problem(): string | undefined {
    if (!isValidVapidSubject(this.subject)) {
      return 'gateway.pushSubject must be a real mailto: address or an https: URL — the push providers reject anything else';
    }
    return undefined;
  }

  /** The public key the browser needs to subscribe. Safe to serve. */
  get publicKey(): string {
    return this.vapid.publicKey;
  }

  subscribe(input: { endpoint: string; keys: PushSubscriptionKeys; deviceId?: string | null }): PushSubscription {
    const existing = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as unknown as SubRow | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ?, device_id = ?, failures = 0 WHERE endpoint = ?')
        .run(input.keys.p256dh, input.keys.auth, input.deviceId ?? existing.device_id, input.endpoint);
      return toSub(this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as unknown as SubRow);
    }
    const id = `p-${shortId(5)}`;
    this.db
      .prepare('INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.deviceId ?? null, input.endpoint, input.keys.p256dh, input.keys.auth, new Date().toISOString());
    return toSub(this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as unknown as SubRow);
  }

  unsubscribe(endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
  }

  list(): PushSubscription[] {
    return (this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at DESC').all() as unknown as SubRow[]).map(toSub);
  }

  /** Send to every subscription. Returns how many got through. */
  async send(message: PushMessage): Promise<{ sent: number; failed: number }> {
    if (this.problem) {
      log.warn('refusing to send push', { problem: this.problem });
      this.events.append({ runId: null, kind: 'system.error', source: 'push', summary: `push not configured: ${this.problem}`, data: {} });
      return { sent: 0, failed: 0 };
    }
    const subs = this.list();
    let sent = 0;
    let failed = 0;
    for (const sub of subs) {
      const ok = await this.sendTo(sub, message);
      if (ok) sent++;
      else failed++;
    }
    if (subs.length) {
      this.events.append({
        runId: (message.data?.runId as string) ?? null,
        kind: sent ? 'notify.sent' : 'notify.suppressed',
        source: 'push',
        summary: `push "${message.title}" → ${sent} device(s)${failed ? `, ${failed} failed` : ''}`,
        data: { title: message.title, sent, failed },
      });
    }
    return { sent, failed };
  }

  async sendTo(sub: PushSubscription, message: PushMessage): Promise<boolean> {
    try {
      const payload = encryptPayload(Buffer.from(JSON.stringify(message)), { p256dh: sub.p256dh, auth: sub.auth });
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(sub.endpoint, this.vapid, this.subject),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: message.requireInteraction ? 'high' : 'normal',
        },
        body: new Uint8Array(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?').run(new Date().toISOString(), sub.id);
        return true;
      }
      // 404/410 mean the browser threw the subscription away; stop trying.
      if (res.status === 404 || res.status === 410) {
        this.unsubscribe(sub.endpoint);
        log.info('push subscription gone, removed', { id: sub.id, status: res.status });
        return false;
      }
      this.recordFailure(sub, `HTTP ${res.status}`);
      return false;
    } catch (err) {
      this.recordFailure(sub, (err as Error).message);
      return false;
    }
  }

  private recordFailure(sub: PushSubscription, reason: string): void {
    const failures = sub.failures + 1;
    this.db.prepare('UPDATE push_subscriptions SET failures = ? WHERE id = ?').run(failures, sub.id);
    log.warn('push failed', { id: sub.id, failures, reason });
    // Ten consecutive failures is a dead endpoint, not a flaky network.
    if (failures >= 10) this.unsubscribe(sub.endpoint);
  }

  /** The one push that always earns an interruption. */
  async sendApprovalRequest(confirmId: string, runId: string, tool: string, detail: string): Promise<void> {
    await this.send({
      title: 'Approval needed',
      body: `${runId} wants to ${tool}: ${detail.slice(0, 120)}`,
      url: `/?confirm=${confirmId}`,
      tag: `confirm-${confirmId}`,
      requireInteraction: true,
      actions: [
        { action: `approve:${confirmId}`, title: 'Approve' },
        { action: `deny:${confirmId}`, title: 'Deny' },
      ],
      data: { confirmId, runId, kind: 'approval' },
    });
  }
}
