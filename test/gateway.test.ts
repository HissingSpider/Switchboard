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
  return { cfg, db, events, runs, sessions, artifacts, confirms, registry, agents, skills, pipeline, replies };
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
