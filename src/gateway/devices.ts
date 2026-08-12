import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../store/db.js';
import { shortId } from '../core/ids.js';

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
  revokedAt: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  revoked_at: string | null;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  userAgent: r.user_agent,
  revokedAt: r.revoked_at,
});

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pairing codes are read aloud and typed on a phone: short, unambiguous, brief. */
const PAIRING_TTL_MS = 5 * 60_000;

/**
 * Per-device tokens instead of one shared gateway token.
 *
 * The shared token is fine for a script on the same machine, but a phone keeps
 * its token in localStorage for months. Per-device means losing a phone costs
 * one revocation rather than rotating a secret every other client also holds,
 * and the event log can say *which* device did something.
 *
 * Pairing is deliberately out-of-band: the code is shown on the machine you
 * already trust (the dashboard or the terminal) and typed into the new one. No
 * QR scanning, no discovery protocol, nothing to spoof over the network.
 */
export class DeviceStore {
  constructor(private readonly db: Db) {}

  /** Create a short-lived pairing code to show on the trusted screen. */
  createPairingCode(): { code: string; expiresAt: string } {
    const code = `${shortId(3)}-${shortId(3)}`;
    const now = Date.now();
    const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
    this.db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(new Date(now).toISOString());
    this.db.prepare('INSERT INTO pairings (code, created_at, expires_at) VALUES (?, ?, ?)').run(code, new Date(now).toISOString(), expiresAt);
    return { code, expiresAt };
  }

  /**
   * Redeem a pairing code for a device token. The token is returned exactly
   * once and only its hash is stored — a leaked database is not a leaked phone.
   */
  claim(code: string, name: string, userAgent?: string): { device: Device; token: string } | { error: string } {
    const row = this.db.prepare('SELECT * FROM pairings WHERE code = ?').get(code.trim().toLowerCase()) as
      | { code: string; expires_at: string; claimed_at: string | null }
      | undefined;
    if (!row) return { error: 'unknown pairing code' };
    if (row.claimed_at) return { error: 'that code has already been used' };
    if (new Date(row.expires_at).getTime() < Date.now()) return { error: 'that code has expired' };

    const id = `d-${shortId(5)}`;
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, created_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(id, name || 'unnamed device', hash(token), now, userAgent ?? null);
    this.db.prepare('UPDATE pairings SET claimed_at = ?, device_id = ? WHERE code = ?').run(now, id, row.code);
    return { device: this.get(id)!, token };
  }

  /** Resolve a bearer token to a device, or undefined. Constant-time on the hash. */
  authenticate(token: string): Device | undefined {
    if (!token) return undefined;
    const wanted = hash(token);
    const rows = this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL').all() as unknown as DeviceRow[];
    for (const row of rows) {
      const a = Buffer.from(row.token_hash);
      const b = Buffer.from(wanted);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
        return toDevice(row);
      }
    }
    return undefined;
  }

  get(id: string): Device | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
    return row ? toDevice(row) : undefined;
  }

  list(includeRevoked = false): Device[] {
    const sql = includeRevoked
      ? 'SELECT * FROM devices ORDER BY created_at DESC'
      : 'SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC';
    return (this.db.prepare(sql).all() as unknown as DeviceRow[]).map(toDevice);
  }

  revoke(id: string): boolean {
    const changes = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes;
    if (changes) {
      // A revoked device must not keep receiving push notifications.
      this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    }
    return Number(changes) > 0;
  }

  rename(id: string, name: string): boolean {
    return Number(this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id).changes) > 0;
  }

  pendingPairings(): Array<{ code: string; expiresAt: string }> {
    return (
      this.db.prepare('SELECT code, expires_at FROM pairings WHERE claimed_at IS NULL AND expires_at > ?').all(new Date().toISOString()) as unknown as Array<{
        code: string;
        expires_at: string;
      }>
    ).map((r) => ({ code: r.code, expiresAt: r.expires_at }));
  }
}
