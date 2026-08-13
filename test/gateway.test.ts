import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openDb } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { RunStore } from '../dist/store/runs.js';
import { SessionStore } from '../dist/store/sessions.js';
import { ArtifactStore } from '../dist/store/artifacts.js';
import { ConfirmService } from '../dist/policy/confirm.js';
import { RunRegistry } from '../dist/runner/registry.js';
import { AgentRegistry } from '../dist/agents/registry.js';
import { SkillRegistry } from '../dist/skills/loader.js';
import { MessagePipeline } from '../dist/router/pipeline.js';
import { Gateway } from '../dist/gateway/server.js';
import { DeviceStore } from '../dist/gateway/devices.js';
import { PushService } from '../dist/gateway/push.js';
import { SkillStore } from '../dist/store/skills.js';
import { HOOK_PATH } from '../dist/runner/hook.js';
import { sandbox, fakeClaudeShim, waitFor, type Sandbox } from './helpers.ts';

let box: Sandbox;
let gw: Gateway;
let base: string;
let ctx: ReturnType<typeof build>;
const HOOK_TOKEN = 'hook-token-for-tests';
const TOKEN = 'gateway-token-for-tests';

function build() {
  const cfg = { ...box.cfg, claudeBin: fakeClaudeShim(box.root) };
  const db = openDb(join(box.root, 'gw.db'));
  const events = new EventLog(db);
  const runs = new RunStore(db);
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(cfg.resolved.artifactsDir);
  const confirms = new ConfirmService(db, events, 2); // 2s timeout keeps tests quick
  const registry = new RunRegistry(cfg as never, events, runs, sessions, artifacts, HOOK_TOKEN);
  registry.start();
  const agents = new AgentRegistry(cfg, join(cfg.resolved.dataDir, 'agents'));
  const skills = new SkillRegistry(cfg.resolved.skillsDir);
  const replies: Array<{ threadId: string; text: string }> = [];
  const pipeline = new MessagePipeline({
    cfg,
    registry,
    runs,
    sessions,
    events,
    artifacts,
    confirms,
    agents,
    reply: async (threadId, text) => void replies.push({ threadId, text }),
  });
  const devices = new DeviceStore(db);
  const push = new PushService(db, events);
  const skillStore = new SkillStore(db);
  return { cfg, db, events, runs, sessions, artifacts, confirms, registry, agents, skills, pipeline, replies, devices, push, skillStore };
}

before(async () => {
  box = sandbox();
  ctx = build();
  gw = new Gateway({ ...ctx, imessage: undefined, scheduler: undefined, token: TOKEN, hookToken: HOOK_TOKEN } as never);
  await gw.start();
  base = `http://127.0.0.1:${gw.port}`;
});

after(async () => {
  await gw.stop();
  await ctx.registry.stop();
  box.cleanup();
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
const post = (path: string, body: unknown, token = TOKEN) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('gateway API', () => {
  test('status reports capacity and budget', async () => {
    const body = (await (await get('/api/status')).json()) as Record<string, number>;
    assert.equal(body.capacity, box.cfg.maxConcurrentRuns);
    assert.equal(typeof body.monthSpendUsd, 'number');
  });

  test('rejects an untrusted Host header (DNS rebinding)', async () => {
    // undici refuses to set Host, so this one goes over raw http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: gw.port, path: '/api/status', headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test('submits and reads back a run', async () => {
    const created = (await (await post('/api/runs', { prompt: 'say hello', project: 'proj' })).json()) as { run: { id: string } };
    await waitFor(() => ctx.runs.get(created.run.id)?.status === 'done', 15_000);
    const detail = (await (await get(`/api/runs/${created.run.id}`)).json()) as { run: { status: string }; artifacts: unknown[] };
    assert.equal(detail.run.status, 'done');
    assert.ok(detail.artifacts.length > 0);
  });

  test('404s an unknown route rather than serving the dashboard', async () => {
    assert.equal((await get('/api/nope')).status, 404);
  });

  test('serves the dashboard', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Switchboard/);
  });

  test('refuses to escape the public directory', async () => {
    assert.equal((await get('/../package.json')).status, 404);
  });
});

describe('PreToolUse gate', () => {
  test('rejects an unauthenticated hook caller', async () => {
    const res = await post(HOOK_PATH, { runId: 'r-x', tool: 'Read', input: {} }, 'wrong');
    assert.equal(res.status, 401);
  });

  test('denies a call for a run it has never heard of', async () => {
    const body = (await (await post(HOOK_PATH, { runId: 'r-nope', tool: 'Read', input: {} }, HOOK_TOKEN)).json()) as { decision: string };
    assert.equal(body.decision, 'deny');
  });

  test('allows a read inside the project', async () => {
    const run = ctx.runs.create({ id: 'r-gate1', prompt: 'x', project: 'proj', projectPath: box.projectDir });
    const body = (await (
      await post(HOOK_PATH, { runId: run.id, tool: 'Read', input: { file_path: join(box.projectDir, 'README.md') } }, HOOK_TOKEN)
    ).json()) as { decision: string };
    assert.equal(body.decision, 'allow');
  });

  test('denies a write outside the project', async () => {
    ctx.runs.create({ id: 'r-gate2', prompt: 'x', project: 'proj', projectPath: box.projectDir });
    const body = (await (await post(HOOK_PATH, { runId: 'r-gate2', tool: 'Write', input: { file_path: '/etc/hosts' } }, HOOK_TOKEN)).json()) as {
      decision: string;
      reason: string;
    };
    assert.equal(body.decision, 'deny');
    assert.match(body.reason, /outside the run workdir/);
  });

  test('an irreversible action waits for a human and defaults to deny on timeout', async () => {
    ctx.runs.create({ id: 'r-gate3', prompt: 'x', project: 'proj', projectPath: box.projectDir });
    const started = Date.now();
    const body = (await (
      await post(HOOK_PATH, { runId: 'r-gate3', tool: 'Bash', input: { command: 'git push origin main' } }, HOOK_TOKEN)
    ).json()) as { decision: string; reason: string };
    assert.equal(body.decision, 'deny');
    assert.match(body.reason, /timeout/);
    assert.ok(Date.now() - started >= 1800, 'should have actually waited for the confirm window');
  });

  test('an approved confirmation lets the action through', async () => {
    ctx.runs.create({ id: 'r-gate4', prompt: 'x', project: 'proj', projectPath: box.projectDir });
    const pending = post(HOOK_PATH, { runId: 'r-gate4', tool: 'Bash', input: { command: 'git push origin main' } }, HOOK_TOKEN);
    await waitFor(() => ctx.confirms.pending('r-gate4').length === 1, 3000);
    const id = ctx.confirms.pending('r-gate4')[0]!.id;
    ctx.confirms.answer(id, true, 'test');
    const body = (await (await pending).json()) as { decision: string };
    assert.equal(body.decision, 'allow');

    const audit = ctx.confirms.audit(10).find((c) => c.id === id)!;
    assert.equal(audit.status, 'approved');
    assert.equal(audit.answeredBy, 'test');
  });

  test('every gated action lands in the event log', () => {
    const gated = ctx.events.replay({ kinds: ['action.gated'], limit: 50 });
    assert.ok(gated.length >= 4);
    assert.ok(gated.every((e) => typeof e.data.rule === 'string'));
  });
});

describe('message pipeline', () => {
  test('control commands answer without starting a run', async () => {
    const before = ctx.runs.list({ limit: 100 }).length;
    await ctx.pipeline.handle({ channel: 'imessage', threadId: 'chat-9', sender: 'owner', text: 'status', receivedAt: new Date().toISOString() });
    assert.equal(ctx.runs.list({ limit: 100 }).length, before);
    assert.match(ctx.replies.at(-1)!.text, /slots/);
  });

  test('help is available', async () => {
    await ctx.pipeline.handle({ channel: 'imessage', threadId: 'chat-9', sender: 'owner', text: 'help', receivedAt: new Date().toISOString() });
    assert.match(ctx.replies.at(-1)!.text, /Switchboard/);
  });

  test('a task acks with the run id and remembers the project', async () => {
    await ctx.pipeline.handle({
      channel: 'imessage',
      threadId: 'chat-10',
      sender: 'owner',
      text: '@proj fix the readme',
      receivedAt: new Date().toISOString(),
    });
    assert.match(ctx.replies.at(-1)!.text, /on it in proj — r-/);
  });

  test('a confirmation reply is consumed before routing', async () => {
    ctx.runs.create({ id: 'r-pipe', prompt: 'x', project: 'proj', projectPath: box.projectDir });
    void ctx.confirms.request({ runId: 'r-pipe', tool: 'Bash', detail: 'git push', tier: 'confirm', channel: 'imessage' });
    await waitFor(() => ctx.confirms.pending('r-pipe').length === 1, 3000);
    await ctx.pipeline.handle({ channel: 'imessage', threadId: 'chat-11', sender: 'owner', text: 'no', receivedAt: new Date().toISOString() });
    assert.match(ctx.replies.at(-1)!.text, /denied/);
  });
});

describe('SSE', () => {
  test('streams backlog then live events', async () => {
    const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const reader = res.body!.getReader();
    ctx.events.append({ runId: null, kind: 'system.start', summary: 'sse probe', data: {}, source: 'test' });
    let seen = '';
    for (let i = 0; i < 6 && !seen.includes('sse probe'); i++) {
      const { value } = await reader.read();
      seen += new TextDecoder().decode(value);
    }
    assert.match(seen, /sse probe/);
    await reader.cancel();
  });
});

describe('device-scoped access', () => {
  test('a paired device token works where the shared token would', async () => {
    const { code } = ctx.devices.createPairingCode();
    const claimed = ctx.devices.claim(code, 'test phone') as { device: { id: string }; token: string };

    const res = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${claimed.token}` } });
    assert.equal(res.status, 200);

    // …and stops working the moment it is revoked.
    ctx.devices.revoke(claimed.device.id);
    const after = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: gw.port, path: '/api/status', headers: { host: 'phone.example.ts.net', authorization: `Bearer ${claimed.token}` } },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(after, 401);
  });

  test('pairing codes are minted and listed', async () => {
    const created = (await (await post('/api/devices/pair', {})).json()) as { code: string; expiresAt: string };
    assert.match(created.code, /^[a-z0-9]{3}-[a-z0-9]{3}$/);
    const listed = (await (await get('/api/devices')).json()) as { pending: Array<{ code: string }> };
    assert.ok(listed.pending.some((p) => p.code === created.code));
  });
});

describe('push endpoints', () => {
  test('serves the VAPID public key', async () => {
    const body = (await (await get('/api/push/key')).json()) as { publicKey: string };
    assert.equal(Buffer.from(body.publicKey, 'base64url').length, 65);
  });

  test('accepts and lists a subscription without leaking the endpoint', async () => {
    const { createECDH, randomBytes } = await import('node:crypto');
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const res = await post('/api/push/subscribe', {
      endpoint: 'https://push.example.com/very/secret/token',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    });
    assert.equal(res.status, 201);
    const listed = (await (await get('/api/push')).json()) as { subscriptions: Array<{ host: string }> };
    assert.equal(listed.subscriptions[0]!.host, 'push.example.com');
    assert.equal(JSON.stringify(listed).includes('secret'), false);
  });

  test('rejects a malformed subscription', async () => {
    assert.equal((await post('/api/push/subscribe', { endpoint: 'https://x' })).status, 400);
  });
});

describe('skill endpoints', () => {
  test('the review queue surfaces flagged skills, and a flag can be cleared', async () => {
    const { EMPTY_MANIFEST } = await import('../dist/skills/manifest.js');
    ctx.skillStore.register({ name: 'gw-demo', manifest: EMPTY_MANIFEST });
    ctx.skillStore.flag('gw-demo', 'failing');

    const queue = (await (await get('/api/skills/review')).json()) as { queue: Array<{ name: string; flagged: boolean }> };
    assert.ok(queue.queue.some((s) => s.name === 'gw-demo' && s.flagged));

    await post('/api/skills/gw-demo/unflag', {});
    assert.equal(ctx.skillStore.get('gw-demo')!.flagged, false);
  });

  test('trusted can be granted from the dashboard, and only from restricted', async () => {
    const { EMPTY_MANIFEST } = await import('../dist/skills/manifest.js');
    ctx.skillStore.register({ name: 'gw-trust', manifest: EMPTY_MANIFEST, trust: 'restricted' });
    await post('/api/skills/gw-trust/trust', { trust: 'trusted' });
    assert.equal(ctx.skillStore.get('gw-trust')!.trust, 'trusted');

    // A sandboxed skill cannot jump straight to trusted.
    ctx.skillStore.register({ name: 'gw-jump', manifest: EMPTY_MANIFEST });
    await post('/api/skills/gw-jump/trust', { trust: 'trusted' });
    assert.equal(ctx.skillStore.get('gw-jump')!.trust, 'sandboxed');
  });

  test('retire and restore round-trip', async () => {
    const { EMPTY_MANIFEST } = await import('../dist/skills/manifest.js');
    ctx.skillStore.register({ name: 'gw-retire', manifest: EMPTY_MANIFEST });
    await post('/api/skills/gw-retire/retire', { reason: 'test' });
    assert.ok(ctx.skillStore.get('gw-retire')!.retiredAt);
    await post('/api/skills/gw-retire/restore', {});
    assert.equal(ctx.skillStore.get('gw-retire')!.retiredAt, null);
  });

  test('404s an unknown skill', async () => {
    assert.equal((await get('/api/skills/nope-not-real')).status, 404);
  });
});

describe('offline replay', () => {
  test('SSE resumes from Last-Event-ID and returns only what was missed', async () => {
    const before = ctx.events.append({ runId: null, kind: 'system.start', summary: 'before the gap', data: {}, source: 'test' });
    ctx.events.append({ runId: null, kind: 'system.start', summary: 'during the gap', data: {}, source: 'test' });

    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(before.id) },
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /during the gap/);
    assert.equal(text.includes('before the gap'), false);
    await reader.cancel();
  });

  test('the websocket replays from a since cursor', async () => {
    const marker = ctx.events.append({ runId: null, kind: 'system.start', summary: 'ws marker', data: {}, source: 'test' });
    ctx.events.append({ runId: null, kind: 'system.start', summary: 'after ws marker', data: {}, source: 'test' });

    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/?since=${marker.id}&token=${TOKEN}`);
    const backlog = await new Promise<{ events: Array<{ summary: string }>; resumed: boolean }>((resolve, reject) => {
      ws.addEventListener('message', (ev) => resolve(JSON.parse(String((ev as MessageEvent).data))));
      ws.addEventListener('error', () => reject(new Error('ws failed')));
      setTimeout(() => reject(new Error('ws timed out')), 5000);
    });
    ws.close();
    assert.equal(backlog.resumed, true);
    assert.ok(backlog.events.some((e) => e.summary === 'after ws marker'));
    assert.equal(backlog.events.some((e) => e.summary === 'ws marker'), false);
  });
});

describe('PWA assets', () => {
  test('serves the manifest, service worker and icons', async () => {
    const manifest = await get('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /manifest\+json/);
    const parsed = (await manifest.json()) as { start_url: string; icons: unknown[] };
    assert.equal(parsed.start_url, '/');
    assert.ok(parsed.icons.length >= 2);

    assert.equal((await get('/sw.js')).status, 200);
    assert.equal((await get('/icon-192.png')).status, 200);
    assert.equal((await get('/pair.html')).status, 200);
  });
});

describe('proxied requests are not loopback', () => {
  /**
   * `tailscale serve` proxies to 127.0.0.1, so a tailnet request is
   * indistinguishable from a local one by address alone. If loopback still
   * skipped the token, exposing the gateway to the tailnet would expose it
   * without any authentication at all.
   */
  const proxied = (headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: gw.port, path: '/api/status', headers }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  test('a forwarded request with no credential is refused', async () => {
    assert.equal(await proxied({ host: 'johns-mac-mini.tail20dab6.ts.net', 'x-forwarded-for': '100.64.0.9' }), 401);
    assert.equal(await proxied({ host: 'phone.tail20dab6.ts.net', 'tailscale-user-login': 'someone@else.com' }), 401);
  });

  test('a forwarded request with a valid token is allowed', async () => {
    assert.equal(
      await proxied({
        host: 'johns-mac-mini.tail20dab6.ts.net',
        'x-forwarded-for': '100.64.0.9',
        authorization: `Bearer ${TOKEN}`,
      }),
      200,
    );
  });

  test('a genuinely local request still needs no token', async () => {
    assert.equal(await proxied({ host: '127.0.0.1' }), 200);
  });
});

describe('pairing bootstrap', () => {
  /**
   * These must go over raw http: undici silently drops a custom Host header, so
   * a `fetch` here would arrive as an ordinary loopback request and prove
   * nothing. A forwarding header is what makes it genuinely remote.
   */
  const remote = (path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        host: 'johns-mac-mini.tail20dab6.ts.net',
        'x-forwarded-for': '100.64.0.9',
      };
      if (body) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const req = httpRequest({ host: '127.0.0.1', port: gw.port, path, method, headers }, (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (text += c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  test('the pairing page and its assets are reachable without a token', async () => {
    // A new phone has no credential yet; if these were gated, pairing over the
    // tailnet would be impossible.
    for (const path of ['/pair.html', '/app.css', '/manifest.webmanifest', '/icon-192.png']) {
      assert.equal((await remote(path)).status, 200, path);
    }
  });

  test('claiming works without a token but still needs a valid code', async () => {
    const bad = await remote('/api/devices/claim', 'POST', JSON.stringify({ code: 'not-real', name: 'phone' }));
    assert.equal(bad.status, 400);

    const { code } = ctx.devices.createPairingCode();
    const good = await remote('/api/devices/claim', 'POST', JSON.stringify({ code, name: 'phone' }));
    assert.equal(good.status, 201);
    assert.ok((JSON.parse(good.text) as { token?: string }).token);
  });

  test('the bootstrap hole is exactly that hole and nothing more', async () => {
    // The dashboard, the API and the event stream all stay shut to a remote
    // caller with no credential.
    for (const path of ['/', '/app.js', '/api/status', '/api/runs', '/api/devices', '/events']) {
      assert.equal((await remote(path)).status, 401, path);
    }
  });
});

describe('browser navigation auth', () => {
  const nav = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; location?: string; setCookie?: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path,
          method: 'GET',
          headers: { host: 'johns-mac-mini.tail20dab6.ts.net', 'x-forwarded-for': '100.64.0.9', accept: 'text/html', ...headers },
        },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0, location: r.headers.location as string | undefined });
        },
      );
      req.on('error', reject);
      req.end();
    });

  test('claiming sets a cookie, because localStorage cannot authenticate a navigation', async () => {
    const { code } = ctx.devices.createPairingCode();
    const result = await new Promise<{ status: number; setCookie?: string; body: string }>((resolve, reject) => {
      const payload = JSON.stringify({ code, name: 'nav phone' });
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/devices/claim',
          method: 'POST',
          headers: {
            host: 'johns-mac-mini.tail20dab6.ts.net',
            'x-forwarded-for': '100.64.0.9',
            'x-forwarded-proto': 'https',
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        },
        (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, setCookie: (r.headers['set-cookie'] ?? [])[0], body }));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    assert.equal(result.status, 201);
    assert.ok(result.setCookie, 'claim must set a cookie');
    assert.match(result.setCookie!, /^swb_token=/);
    assert.match(result.setCookie!, /HttpOnly/);
    assert.match(result.setCookie!, /SameSite=Lax/);
    assert.match(result.setCookie!, /Secure/, 'https requests must get a Secure cookie');

    // That cookie must then get the dashboard itself, not just the API.
    const cookie = result.setCookie!.split(';')[0]!;
    assert.equal((await nav('/', { cookie })).status, 200);
    assert.equal((await nav('/app.js', { cookie })).status, 200);
  });

  test('an unpaired browser is sent to the pairing page, not shown a JSON error', async () => {
    const res = await nav('/');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/pair.html');
  });

  test('an unauthenticated API call still gets a plain 401', async () => {
    const res = await nav('/api/status', { accept: 'application/json' });
    assert.equal(res.status, 401);
  });

  test('a plain-http claim does not get a Secure cookie, or it would never be set', async () => {
    const { code } = ctx.devices.createPairingCode();
    const payload = JSON.stringify({ code, name: 'http phone' });
    const setCookie = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/devices/claim',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        },
        (r) => {
          r.resume();
          resolve((r.headers['set-cookie'] ?? [])[0]);
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    assert.ok(setCookie);
    assert.equal(/Secure/.test(setCookie!), false);
  });
});

describe('token to cookie upgrade', () => {
  test('a bearer-authenticated device is issued a cookie it did not have', async () => {
    const { code } = ctx.devices.createPairingCode();
    const claimed = ctx.devices.claim(code, 'legacy phone') as { token: string };

    const setCookie = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/status',
          headers: {
            host: 'johns-mac-mini.tail20dab6.ts.net',
            'x-forwarded-for': '100.64.0.9',
            authorization: `Bearer ${claimed.token}`,
          },
        },
        (r) => {
          r.resume();
          resolve((r.headers['set-cookie'] ?? [])[0]);
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.ok(setCookie, 'a device with no cookie should be issued one');
    assert.match(setCookie!, /^swb_token=/);
  });

  test('a request that already has the cookie is not re-issued one', async () => {
    const { code } = ctx.devices.createPairingCode();
    const claimed = ctx.devices.claim(code, 'cookied phone') as { token: string };
    const setCookie = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/status',
          headers: {
            host: 'johns-mac-mini.tail20dab6.ts.net',
            'x-forwarded-for': '100.64.0.9',
            cookie: `swb_token=${claimed.token}`,
          },
        },
        (r) => {
          r.resume();
          resolve((r.headers['set-cookie'] ?? [])[0]);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(setCookie, undefined);
  });

  test('a revoked device cannot resurrect itself with its old cookie', async () => {
    const { code } = ctx.devices.createPairingCode();
    const claimed = ctx.devices.claim(code, 'doomed phone') as { device: { id: string }; token: string };
    ctx.devices.revoke(claimed.device.id);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/status',
          headers: {
            host: 'johns-mac-mini.tail20dab6.ts.net',
            'x-forwarded-for': '100.64.0.9',
            cookie: `swb_token=${claimed.token}`,
          },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401);
  });
});
