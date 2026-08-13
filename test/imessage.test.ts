import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../dist/store/db.js';
import { NativeImessageAdapter, decodeAttributedBody, appleDateToMs, quote } from '../dist/adapters/imessage-native.js';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
let n = 0;

before(() => {
  box = sandbox();
});
after(() => box.cleanup());

/** A stand-in for chat.db with the columns the reader actually touches. */
function fakeChatDb(): { path: string; insert: (m: { text?: string | null; body?: Buffer | null; sender: string; chat: string; fromMe?: boolean }) => number } {
  const path = join(box.root, `chat-${n++}.db`);
  const db = openDb(path);
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, chat_identifier TEXT, service_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);

  const insert = (m: { text?: string | null; body?: Buffer | null; sender: string; chat: string; fromMe?: boolean }): number => {
    let handleId = (db.prepare('SELECT ROWID FROM handle WHERE id = ?').get(m.sender) as { ROWID?: number } | undefined)?.ROWID;
    if (!handleId) handleId = Number(db.prepare('INSERT INTO handle (id) VALUES (?)').run(m.sender).lastInsertRowid);
    let chatId = (db.prepare('SELECT ROWID FROM chat WHERE guid = ?').get(m.chat) as { ROWID?: number } | undefined)?.ROWID;
    if (!chatId) chatId = Number(db.prepare('INSERT INTO chat (guid, chat_identifier, service_name) VALUES (?, ?, ?)').run(m.chat, m.sender, 'iMessage').lastInsertRowid);

    const rowid = Number(
      db
        .prepare('INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`g-${Math.random()}`, m.text ?? null, m.body ?? null, 750000000000000000, m.fromMe ? 1 : 0, handleId).lastInsertRowid,
    );
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(chatId, rowid);
    return rowid;
  };
  return { path, insert };
}

const adapterFor = (path: string, allowlist: string[]) =>
  new NativeImessageAdapter({ enabled: true, mode: 'native', allowlist }, { dbPath: path, workDir: join(box.root, 'imsg'), pollMs: 10_000 });

describe('apple date conversion', () => {
  test('handles both the nanosecond and second encodings', () => {
    // 2024-01-01T00:00:00Z in Apple nanoseconds.
    const ns = 725846400 * 1e9;
    assert.equal(new Date(appleDateToMs(ns)).getUTCFullYear(), 2024);
    assert.equal(new Date(appleDateToMs(725846400)).getUTCFullYear(), 2024);
    assert.equal(appleDateToMs(0), 0);
  });
});

describe('attributedBody decoding', () => {
  /** Recent macOS puts the body here and leaves `text` NULL. */
  const archive = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf8');
    return Buffer.concat([
      Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01\x40\x84\x84\x84', 'binary'),
      Buffer.from('NSString'),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
      Buffer.from([body.length]),
      body,
    ]);
  };

  test('recovers a plain message', () => {
    assert.equal(decodeAttributedBody(archive('fix the failing auth test')), 'fix the failing auth test');
  });

  test('recovers unicode', () => {
    assert.equal(decodeAttributedBody(archive('déjà vu — ok?')), 'déjà vu — ok?');
  });

  test('is not fooled by an empty or unrelated blob', () => {
    assert.equal(decodeAttributedBody(null), '');
    assert.equal(decodeAttributedBody(Buffer.alloc(0)), '');
    assert.equal(decodeAttributedBody(Buffer.from('no marker here')), '');
  });
});

describe('applescript quoting', () => {
  test('escapes what would otherwise break out of the string', () => {
    assert.equal(quote('say "hi"'), '"say \\"hi\\""');
    assert.equal(quote('back\\slash'), '"back\\\\slash"');
  });
});

describe('reading new messages', () => {
  test('delivers a message from an allowlisted sender', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(`${m.sender}:${m.text}`);

    await adapter.start();
    db.insert({ text: 'status', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();

    assert.deepEqual(seen, ['+15550109999:status']);
    await adapter.stop();
  });

  test('drops anyone not on the allowlist', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    db.insert({ text: 'let me in', sender: '+15550100000', chat: 'iMessage;-;+15550100000' });
    await adapter.poll();
    assert.deepEqual(seen, []);
    await adapter.stop();
  });

  test('ignores our own outgoing messages, or it would answer itself', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    db.insert({ text: 'on it — r-abc', sender: '+15550109999', chat: 'iMessage;-;+15550109999', fromMe: true });
    await adapter.poll();
    assert.deepEqual(seen, []);
    await adapter.stop();
  });

  test('never replays history on start', async () => {
    const db = fakeChatDb();
    db.insert({ text: 'ancient', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    assert.deepEqual(await adapter.poll(), [], 'a message from before startup must not be delivered');

    db.insert({ text: 'new one', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();
    assert.deepEqual(seen, ['new one']);
    await adapter.stop();
  });

  test('each message is delivered exactly once', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    db.insert({ text: 'one', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();
    await adapter.poll();
    await adapter.poll();
    assert.deepEqual(seen, ['one'], 'polling again must not redeliver');
    await adapter.stop();
  });

  test('reads the body out of attributedBody when text is NULL', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    const body = Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), Buffer.from([5]), Buffer.from('hello')]);
    db.insert({ text: null, body, sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();
    assert.deepEqual(seen, ['hello']);
    await adapter.stop();
  });

  test('the chat guid becomes the thread id, so replies land in the same conversation', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['+15550109999']);
    let threadId = '';
    adapter.onMessage = (m) => void (threadId = m.threadId);

    await adapter.start();
    db.insert({ text: 'hi', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();
    assert.equal(threadId, 'iMessage;-;+15550109999');
    await adapter.stop();
  });

  test('a number in a different format still matches the allowlist', async () => {
    const db = fakeChatDb();
    const adapter = adapterFor(db.path, ['(555) 010-9999']);
    const seen: string[] = [];
    adapter.onMessage = (m) => void seen.push(m.text);

    await adapter.start();
    db.insert({ text: 'formats', sender: '+15550109999', chat: 'iMessage;-;+15550109999' });
    await adapter.poll();
    assert.deepEqual(seen, ['formats']);
    await adapter.stop();
  });

  test('an unreadable database is reported, not thrown', async () => {
    const adapter = adapterFor(join(box.root, 'does-not-exist.db'), ['+15550109999']);
    assert.match(adapter.problem ?? '', /does not exist/);
    await adapter.start(); // must not throw
    assert.deepEqual(await adapter.poll(), []);
    await adapter.stop();
  });
});
