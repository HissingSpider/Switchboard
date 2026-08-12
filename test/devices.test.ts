import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createECDH, randomBytes, createPublicKey, createVerify } from 'node:crypto';
import { openDb } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { DeviceStore } from '../dist/gateway/devices.js';
import { PushService, generateVapidKeys, vapidHeader, encryptPayload } from '../dist/gateway/push.js';
import { checkReachability, serveCommand, formatReachability } from '../dist/net/reachability.js';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
let n = 0;
const freshDb = () => openDb(join(box.root, `dev-${n++}.db`));

before(() => {
  box = sandbox();
});
after(() => box.cleanup());

describe('device pairing', () => {
  test('a code can be claimed exactly once', () => {
    const devices = new DeviceStore(freshDb());
    const { code } = devices.createPairingCode();
    const first = devices.claim(code, 'phone');
    assert.ok('device' in first, JSON.stringify(first));
    const second = devices.claim(code, 'another phone');
    assert.ok('error' in second);
    assert.match((second as { error: string }).error, /already been used/);
  });

  test('an unknown code is refused', () => {
    const devices = new DeviceStore(freshDb());
    assert.ok('error' in devices.claim('nope-nope', 'phone'));
  });

  test('the token authenticates, and only that token', () => {
    const devices = new DeviceStore(freshDb());
    const { code } = devices.createPairingCode();
    const claimed = devices.claim(code, 'phone') as { device: { id: string }; token: string };
    assert.equal(devices.authenticate(claimed.token)?.id, claimed.device.id);
    assert.equal(devices.authenticate('not-the-token'), undefined);
    assert.equal(devices.authenticate(''), undefined);
  });

  test('revoking a device stops its token immediately', () => {
    const devices = new DeviceStore(freshDb());
    const { code } = devices.createPairingCode();
    const claimed = devices.claim(code, 'phone') as { device: { id: string }; token: string };
    assert.equal(devices.revoke(claimed.device.id), true);
    assert.equal(devices.authenticate(claimed.token), undefined);
    // Revoking twice is not an error, but it is not a second revocation either.
    assert.equal(devices.revoke(claimed.device.id), false);
  });

  test('the raw token is never stored', () => {
    const db = freshDb();
    const devices = new DeviceStore(db);
    const { code } = devices.createPairingCode();
    const claimed = devices.claim(code, 'phone') as { token: string };
    const rows = db.prepare('SELECT token_hash FROM devices').all() as unknown as Array<{ token_hash: string }>;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, claimed.token);
    assert.match(rows[0]!.token_hash, /^[a-f0-9]{64}$/);
  });

  test('last-seen is recorded on use', () => {
    const devices = new DeviceStore(freshDb());
    const { code } = devices.createPairingCode();
    const claimed = devices.claim(code, 'phone') as { device: { id: string }; token: string };
    assert.equal(devices.get(claimed.device.id)!.lastSeenAt, null);
    devices.authenticate(claimed.token);
    assert.ok(devices.get(claimed.device.id)!.lastSeenAt);
  });
});

describe('web push', () => {
  test('VAPID keys are a valid P-256 pair', () => {
    const keys = generateVapidKeys();
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(keys.publicKey, 'base64url')[0], 0x04); // uncompressed point
    assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  });

  test('the VAPID JWT verifies against the advertised public key', () => {
    const keys = generateVapidKeys();
    const header = vapidHeader('https://web.push.apple.com/abc123', keys, 'mailto:me@example.com');
    const parsed = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert.ok(parsed, header);
    const [h, b, sig] = parsed![1]!.split('.');

    const pub = Buffer.from(parsed![2]!, 'base64url');
    const spki = Buffer.concat([
      Buffer.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]),
      pub,
    ]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });

    const raw = Buffer.from(sig!, 'base64url');
    const encodeInt = (x: Buffer): Buffer => {
      let i = 0;
      while (i < x.length - 1 && x[i] === 0) i++;
      let v = x.subarray(i);
      if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return Buffer.concat([Buffer.from([0x02, v.length]), v]);
    };
    const r = encodeInt(raw.subarray(0, 32));
    const s = encodeInt(raw.subarray(32));
    const der = Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);

    const verifier = createVerify('SHA256');
    verifier.update(`${h}.${b}`);
    assert.equal(verifier.verify(key, der), true);

    const claims = JSON.parse(Buffer.from(b!, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    assert.equal(claims.aud, 'https://web.push.apple.com');
    assert.equal(claims.sub, 'mailto:me@example.com');
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  });

  test('the encrypted body is a well-formed aes128gcm record', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const body = encryptPayload(Buffer.from('{"title":"hi"}'), {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    });
    assert.equal(body.readUInt32BE(16), 4096); // record size
    assert.equal(body[20], 65); // key id length
    // salt(16) + rs(4) + idlen(1) + key(65) + ciphertext(plaintext + 1 + 16 tag)
    assert.equal(body.length, 16 + 4 + 1 + 65 + 14 + 1 + 16);
  });

  test('two encryptions of the same payload differ', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
    const a = encryptPayload(Buffer.from('same'), keys);
    const b = encryptPayload(Buffer.from('same'), keys);
    assert.equal(a.equals(b), false);
  });

  test('subscriptions are stored, deduped by endpoint and removable', () => {
    const db = freshDb();
    const push = new PushService(db, new EventLog(db));
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };

    push.subscribe({ endpoint: 'https://push.example/a', keys });
    push.subscribe({ endpoint: 'https://push.example/a', keys });
    assert.equal(push.list().length, 1, 'resubscribing must not duplicate');

    push.subscribe({ endpoint: 'https://push.example/b', keys });
    assert.equal(push.list().length, 2);
    assert.equal(push.unsubscribe('https://push.example/a'), true);
    assert.equal(push.list().length, 1);
  });

  test('revoking a device drops its push subscription', () => {
    const db = freshDb();
    const devices = new DeviceStore(db);
    const push = new PushService(db, new EventLog(db));
    const { code } = devices.createPairingCode();
    const claimed = devices.claim(code, 'phone') as { device: { id: string } };
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    push.subscribe({
      endpoint: 'https://push.example/c',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
      deviceId: claimed.device.id,
    });
    assert.equal(push.list().length, 1);
    devices.revoke(claimed.device.id);
    assert.equal(push.list().length, 0);
  });

  test('sending with no subscriptions is a no-op, not an error', async () => {
    const db = freshDb();
    const push = new PushService(db, new EventLog(db));
    assert.deepEqual(await push.send({ title: 'x', body: 'y' }), { sent: 0, failed: 0 });
  });
});

describe('reachability', () => {
  test('always offers loopback and reports whether a phone can get in', async () => {
    const report = await checkReachability({ host: '127.0.0.1', port: 7788 });
    assert.ok(report.urls.includes('http://127.0.0.1:7788'));
    assert.equal(report.loopback, 'http://127.0.0.1:7788');
    assert.ok(Array.isArray(report.problems));
    assert.match(formatReachability(report), /loopback/);
  });

  test('the tailnet-only exposure command names the port', () => {
    assert.equal(serveCommand(7788), 'tailscale serve --bg 7788');
  });
});
