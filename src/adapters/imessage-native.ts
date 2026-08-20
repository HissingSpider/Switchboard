import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { ImessageConfig } from '../config/schema.js';
import { logger } from '../core/logger.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { allowlisted } from './types.js';

const exec = promisify(execFile);
const log = logger('imessage');
const require = createRequire(import.meta.url);

/**
 * iMessage without a third-party bridge.
 *
 * BlueBubbles works, but it is an app to install, a service to keep running, a
 * password to store and a webhook to wire — and it needs Full Disk Access
 * anyway. macOS already exposes both halves: Messages.app can be told to send
 * over AppleScript, and every message that arrives lands in a SQLite database
 * we can read. One permission grant, no extra moving parts.
 *
 * The trade against BlueBubbles: no typing indicators, no reactions, and
 * receiving is a poll rather than a push — about a second of latency, which is
 * nothing next to the time a run takes.
 */
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');

/** How long a sent message stays recognisable as our own echo. */
const ECHO_TTL_MS = 120_000;

/**
 * How out of date a message may be and still be treated as a request.
 *
 * Starting from `MAX(ROWID)` stops a fresh install replaying history, but it
 * cannot stop Apple *delivering* history: a message composed days ago arrives
 * with a brand-new ROWID when another device finally syncs. Five did on one
 * evening here, in the same second, all of them notifications this daemon had
 * sent days earlier — each one answered as if someone had just asked.
 *
 * Nobody is waiting on a two-hour-old text. Acting on one cannot help and can
 * spend real money, so the message date is checked as well as its position.
 */
const STALE_MESSAGE_MS = 30 * 60_000;

/** Apple's epoch is 2001-01-01; modern macOS stores nanoseconds since then. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/**
 * Dates arrive as strings, deliberately.
 *
 * A nanosecond timestamp for any recent message is around 7.9e17, comfortably
 * past Number.MAX_SAFE_INTEGER, and node:sqlite refuses to hand back an integer
 * it cannot represent — it throws rather than silently rounding. So the query
 * casts to TEXT and the conversion happens here, where losing sub-millisecond
 * precision costs nothing.
 */
export function appleDateToMs(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const raw = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(raw) || raw === 0) return 0;
  // Pre-Sierra rows are in seconds, everything since is nanoseconds.
  const seconds = raw > 1e11 ? raw / 1e9 : raw;
  return APPLE_EPOCH_MS + seconds * 1000;
}

/**
 * Recent macOS leaves `message.text` NULL and puts the body in
 * `attributedBody`, an archived NSAttributedString. Unpacking that properly
 * would mean a plist/keyed-archive decoder; the string itself sits in the blob
 * after an `NSString` marker with a length prefix, which is enough to recover
 * it reliably for ordinary messages.
 */
export function decodeAttributedBody(input: Buffer | Uint8Array | null | undefined): string {
  if (!input?.length) return '';
  // node:sqlite hands back a Uint8Array, whose indexOf only takes a number —
  // searching it for 'NSString' silently returns -1 and every message would
  // arrive empty. Normalise at the boundary.
  const blob = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const marker = blob.indexOf('NSString');
  if (marker === -1) return '';

  // Skip the class name and the following type byte, then read the length,
  // which is one byte under 128 and a 2/4-byte little-endian value above it.
  let cursor = marker + 'NSString'.length;
  while (cursor < blob.length && blob[cursor] !== 0x2b && blob[cursor] !== 0x2c) cursor++;
  if (cursor >= blob.length) return '';
  const kind = blob[cursor];
  cursor += 1;

  let length: number;
  if (kind === 0x2b) {
    length = blob[cursor]!;
    cursor += 1;
    if (length === 0x81) {
      length = blob.readUInt8(cursor);
      cursor += 1;
    } else if (length === 0x82) {
      length = blob.readUInt16LE(cursor);
      cursor += 2;
    }
  } else {
    length = blob.readUInt16LE(cursor);
    cursor += 2;
  }

  if (length <= 0 || cursor + length > blob.length) return '';
  return blob.subarray(cursor, cursor + length).toString('utf8').replace(/￼/g, '').trim();
}

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: string | null;
  sender: string | null;
  chat_guid: string | null;
  service: string | null;
}

const NEW_MESSAGES_SQL = `
SELECT
  m.ROWID           AS rowid,
  m.guid            AS guid,
  m.text            AS text,
  m.attributedBody  AS attributedBody,
  CAST(m.date AS TEXT) AS date,
  h.id              AS sender,
  c.guid            AS chat_guid,
  c.service_name    AS service
FROM message m
LEFT JOIN handle h              ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ?
  AND m.is_from_me = 0
ORDER BY m.ROWID ASC
LIMIT 50
`;

const ATTACHMENTS_SQL = `
SELECT a.filename AS filename, a.mime_type AS mime, a.transfer_name AS name
FROM attachment a
JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
WHERE maj.message_id = ?
`;

export interface NativeImessageOptions {
  /** Poll interval. A second is imperceptible next to how long a run takes. */
  pollMs?: number;
  /** Override the database path — used by tests. */
  dbPath?: string;
  /** Where to stage a readable copy when the live database is locked. */
  workDir: string;
}

export class NativeImessageAdapter implements ChannelAdapter {
  readonly name = 'imessage' as const;
  onMessage?: (msg: InboundMessage) => void | Promise<void>;

  private db: DatabaseSync | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRowId = 0;
  private readonly dbPath: string;
  private polling = false;
  /**
   * Bodies we sent recently, so we do not answer our own echo.
   *
   * Texting your own number is the case that breaks the obvious defence:
   * Apple delivers a self-addressed message back to this Mac as genuinely
   * incoming — `is_from_me` is 0 and the sender is you — so it is
   * indistinguishable from a real message by any field in the database. The
   * only thing that separates them is that we know what we just said.
   */
  private readonly recentlySent = new Map<string, number>();
  lastError: string | null = null;

  constructor(
    private readonly cfg: ImessageConfig,
    private readonly opts: NativeImessageOptions,
  ) {
    this.dbPath = opts.dbPath ?? CHAT_DB;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Why receiving cannot work right now, if it cannot. */
  get problem(): string | undefined {
    if (!existsSync(this.dbPath)) return `${this.dbPath} does not exist — is Messages set up on this Mac?`;
    try {
      this.openDb().prepare('SELECT ROWID FROM message LIMIT 1').get();
      return undefined;
    } catch (err) {
      const message = (err as Error).message;
      if (/authorization denied|unable to open/i.test(message)) {
        return 'Full Disk Access is not granted to the process running Switchboard, so the Messages database cannot be read';
      }
      return message;
    }
  }

  private openDb(): DatabaseSync {
    if (this.db) return this.db;
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this.db;
    } catch (err) {
      // A live WAL database can refuse a read-only open. Reading a snapshot is
      // slower but never blocks Messages, and never risks writing to it.
      if (/readonly|WAL|recovery/i.test((err as Error).message)) {
        this.db = new DatabaseSync(this.snapshot(), { readOnly: true });
        return this.db;
      }
      throw err;
    }
  }

  private snapshot(): string {
    mkdirSync(this.opts.workDir, { recursive: true });
    const target = join(this.opts.workDir, 'chat-snapshot.db');
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(this.dbPath + suffix)) copyFileSync(this.dbPath + suffix, target + suffix);
    }
    return target;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    const problem = this.problem;
    if (problem) {
      this.lastError = problem;
      log.warn('iMessage receiving unavailable', { problem });
      return;
    }

    // Start from the newest message so a fresh install doesn't replay history.
    const row = this.openDb().prepare('SELECT COALESCE(MAX(ROWID), 0) AS n FROM message').get() as { n: number };
    this.lastRowId = Number(row.n);

    const interval = Math.max(500, this.opts.pollMs ?? 1500);
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    log.info('iMessage watching', { from: this.lastRowId, intervalMs: interval, allowlist: this.cfg.allowlist.length });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db?.close();
    this.db = null;
  }

  /** One pass over anything new. Safe to call by hand. */
  async poll(): Promise<InboundMessage[]> {
    if (this.polling || !this.enabled) return [];
    this.polling = true;
    const delivered: InboundMessage[] = [];
    try {
      // A snapshot is a point-in-time copy, so it has to be retaken each pass.
      if (this.db && this.dbPath !== CHAT_DB) {
        /* tests use a stable file */
      } else if (this.db) {
        this.db.close();
        this.db = null;
      }

      const rows = this.openDb().prepare(NEW_MESSAGES_SQL).all(this.lastRowId) as unknown as MessageRow[];
      for (const row of rows) {
        this.lastRowId = Math.max(this.lastRowId, row.rowid);
        const msg = this.toInbound(row);
        if (!msg) continue;
        delivered.push(msg);
        await this.onMessage?.(msg);
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn('poll failed', { err: this.lastError });
      this.db = null; // force a fresh open next time
    } finally {
      this.polling = false;
    }
    return delivered;
  }

  /** Normalised so trivial whitespace differences do not defeat the match. */
  private echoKey(threadId: string, text: string): string {
    return `${threadId}\u0000${text.replace(/\s+/g, ' ').trim()}`;
  }

  private rememberSent(threadId: string, text: string): void {
    const now = Date.now();
    this.recentlySent.set(this.echoKey(threadId, text), now);
    for (const [key, at] of this.recentlySent) {
      if (now - at > ECHO_TTL_MS) this.recentlySent.delete(key);
    }
  }

  private isOwnEcho(threadId: string, text: string): boolean {
    const at = this.recentlySent.get(this.echoKey(threadId, text));
    if (at === undefined) return false;
    if (Date.now() - at > ECHO_TTL_MS) {
      this.recentlySent.delete(this.echoKey(threadId, text));
      return false;
    }
    return true;
  }

  private toInbound(row: MessageRow): InboundMessage | undefined {
    const sender = row.sender ?? '';
    if (!allowlisted(this.cfg.allowlist, sender)) {
      // Silently dropped. Telling a stranger they are not on the list is itself
      // information, and this is a personal phone number.
      log.debug('dropped message from non-allowlisted sender', { sender });
      return undefined;
    }

    const text = (row.text ?? decodeAttributedBody(row.attributedBody)).trim();
    const attachments = this.attachmentsFor(row.rowid);
    if (!text && !attachments.length) return undefined;

    const threadId = row.chat_guid ?? sender;
    if (text && this.isOwnEcho(threadId, text)) {
      log.debug('ignored our own message echoed back', { threadId, text: text.slice(0, 60) });
      return undefined;
    }

    // A late sync, not a request. The echo check cannot catch these: it holds
    // two minutes of text in memory, and these arrive days after they were
    // written, long after the daemon that said them has restarted.
    const sentAt = appleDateToMs(row.date);
    if (sentAt && Date.now() - sentAt > STALE_MESSAGE_MS) {
      log.info('ignored a stale message delivered late', {
        threadId,
        ageMin: Math.round((Date.now() - sentAt) / 60_000),
        text: text.slice(0, 60),
      });
      return undefined;
    }

    return {
      channel: 'imessage',
      threadId,
      sender,
      text,
      attachments,
      receivedAt: new Date(appleDateToMs(row.date) || Date.now()).toISOString(),
    };
  }

  private attachmentsFor(messageRowId: number): Array<{ name: string; path: string; mime?: string }> {
    try {
      const rows = this.openDb().prepare(ATTACHMENTS_SQL).all(messageRowId) as unknown as Array<{
        filename: string | null;
        mime: string | null;
        name: string | null;
      }>;
      return rows
        .map((r) => {
          const path = (r.filename ?? '').replace(/^~/, homedir());
          return { name: r.name ?? basename(path), path, mime: r.mime ?? undefined };
        })
        .filter((a) => a.path && existsSync(a.path));
    } catch {
      return [];
    }
  }

  /**
   * Sending goes through Messages.app. `chat id` targets an existing
   * conversation, which is what we almost always have — the thread id is the
   * chat guid the message arrived on.
   */
  async send(msg: OutboundMessage): Promise<boolean> {
    if (!this.enabled) return false;
    const target = msg.threadId;
    const script = target.includes(';')
      ? `tell application "Messages" to send ${quote(msg.text)} to chat id ${quote(target)}`
      : [
          'tell application "Messages"',
          '  set svc to 1st account whose service type = iMessage',
          `  send ${quote(msg.text)} to participant ${quote(target)} of svc`,
          'end tell',
        ].join('\n');

    // Recorded before the send, not after: the echo can arrive while osascript
    // is still returning.
    this.rememberSent(target, msg.text);

    try {
      await exec('osascript', ['-e', script], { timeout: 20_000 });
      for (const path of msg.attachments ?? []) await this.sendAttachment(target, path);
      return true;
    } catch (err) {
      const message = (err as Error).message;
      this.lastError = message;
      if (/not authorized|1743/.test(message)) {
        log.error('Messages automation is not permitted — grant it under Privacy & Security → Automation', { err: message });
      } else {
        log.error('send failed', { err: message });
      }
      return false;
    }
  }

  private async sendAttachment(target: string, path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    const script = [
      'tell application "Messages"',
      `  set f to POSIX file ${quote(path)}`,
      target.includes(';') ? `  send f to chat id ${quote(target)}` : `  send f to participant ${quote(target)} of (1st account whose service type = iMessage)`,
      'end tell',
    ].join('\n');
    try {
      await exec('osascript', ['-e', script], { timeout: 60_000 });
      return true;
    } catch (err) {
      log.warn('attachment send failed', { path, err: (err as Error).message });
      return false;
    }
  }

  /** Recent conversations, so a thread id can be found without waiting for a text. */
  recentChats(limit = 10): Array<{ guid: string; identifier: string; lastMessageAt: string }> {
    try {
      const rows = this.openDb()
        .prepare(
          `SELECT c.guid AS guid, c.chat_identifier AS identifier, CAST(MAX(m.date) AS TEXT) AS last
           FROM chat c
           JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
           JOIN message m ON m.ROWID = cmj.message_id
           GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ?`,
        )
        .all(limit) as unknown as Array<{ guid: string; identifier: string; last: string }>;
      return rows.map((r) => ({ guid: r.guid, identifier: r.identifier, lastMessageAt: new Date(appleDateToMs(r.last)).toISOString() }));
    } catch {
      return [];
    }
  }
}

/** AppleScript string literal — the only escaping that matters is backslash and quote. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const FULL_DISK_ACCESS_HELP = [
  'Receiving iMessage needs Full Disk Access for the binary that runs Switchboard:',
  '  System Settings → Privacy & Security → Full Disk Access → + → ⌘⇧G → /usr/local/bin/node',
  'Then restart the daemon; macOS caches the decision per process.',
  'Sending additionally needs Automation → Messages, which macOS prompts for the first time it sends.',
].join('\n');
