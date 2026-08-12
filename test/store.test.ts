import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, kvGet, kvSet } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { RunStore } from '../dist/store/runs.js';
import { SessionStore } from '../dist/store/sessions.js';
import { ArtifactStore } from '../dist/store/artifacts.js';
import { Downsampler } from '../dist/adapters/downsample.js';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
before(() => {
  box = sandbox();
});
after(() => box.cleanup());

describe('event log', () => {
  test('appends, replays and tails in order', () => {
    const db = openDb(join(box.root, 'ev.db'));
    const log = new EventLog(db);
    for (let i = 0; i < 5; i++) log.append({ runId: 'r-1', kind: 'agent.text', summary: `line ${i}`, data: {}, source: 'test' });
    log.append({ runId: 'r-2', kind: 'agent.text', summary: 'other run', data: {}, source: 'test' });

    const replayed = log.replay({ runId: 'r-1' });
    assert.equal(replayed.length, 5);
    assert.equal(replayed[0]!.summary, 'line 0');
    assert.equal(log.tail(2, 'r-1').map((e) => e.summary).join(','), 'line 3,line 4');
    assert.equal(log.lastId(), 6);
    db.close();
  });

  test('sinceId gives incremental reads', () => {
    const db = openDb(join(box.root, 'ev2.db'));
    const log = new EventLog(db);
    const first = log.append({ runId: null, kind: 'system.start', summary: 'a', data: {}, source: 'test' });
    log.append({ runId: null, kind: 'system.start', summary: 'b', data: {}, source: 'test' });
    assert.deepEqual(log.replay({ sinceId: first.id }).map((e) => e.summary), ['b']);
    db.close();
  });

  test('subscribers see live events', async () => {
    const db = openDb(join(box.root, 'ev3.db'));
    const log = new EventLog(db);
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.summary), 'r-9');
    log.append({ runId: 'r-9', kind: 'agent.text', summary: 'mine', data: {}, source: 'test' });
    log.append({ runId: 'r-8', kind: 'agent.text', summary: 'not mine', data: {}, source: 'test' });
    off();
    log.append({ runId: 'r-9', kind: 'agent.text', summary: 'after unsub', data: {}, source: 'test' });
    assert.deepEqual(seen, ['mine']);
    db.close();
  });

  test('data survives the round trip as structured JSON', () => {
    const db = openDb(join(box.root, 'ev4.db'));
    const log = new EventLog(db);
    log.append({ runId: null, kind: 'git.diff', summary: 'x', data: { files: [{ path: 'a.ts', added: 3 }] }, source: 'test' });
    const back = log.replay({})[0]!;
    assert.deepEqual((back.data as { files: unknown[] }).files, [{ path: 'a.ts', added: 3 }]);
    db.close();
  });
});

describe('run store', () => {
  test('creates, updates and resolves by prefix', () => {
    const db = openDb(join(box.root, 'runs.db'));
    const runs = new RunStore(db);
    runs.create({ id: 'r-abcde', prompt: 'do a thing', project: 'proj' });
    runs.update('r-abcde', { status: 'running', costUsd: 0.5 });

    assert.equal(runs.get('r-abcde')!.status, 'running');
    assert.equal(runs.resolve('abcde')!.id, 'r-abcde');
    assert.equal(runs.resolve('nope'), undefined);
    assert.equal(runs.active().length, 1);
    db.close();
  });

  test('ambiguous prefixes resolve to nothing rather than the wrong run', () => {
    const db = openDb(join(box.root, 'runs2.db'));
    const runs = new RunStore(db);
    runs.create({ id: 'r-aa111', prompt: 'x' });
    runs.create({ id: 'r-aa222', prompt: 'y' });
    assert.equal(runs.resolve('aa'), undefined);
    db.close();
  });

  test('month spend only counts this month', () => {
    const db = openDb(join(box.root, 'runs3.db'));
    const runs = new RunStore(db);
    runs.create({ id: 'r-now', prompt: 'x' });
    runs.update('r-now', { costUsd: 1.25 });
    db.prepare(`INSERT INTO runs (id, created_at, status, prompt, cost_usd) VALUES ('r-old', '2020-01-01T00:00:00Z', 'done', 'old', 99)`).run();
    assert.equal(runs.monthSpend(), 1.25);
    db.close();
  });

  test('orphans are reconciled on boot', () => {
    const db = openDb(join(box.root, 'runs4.db'));
    const runs = new RunStore(db);
    runs.create({ id: 'r-orph', prompt: 'x' });
    runs.update('r-orph', { status: 'running' });
    assert.deepEqual(runs.reconcileOrphans(), ['r-orph']);
    assert.equal(runs.get('r-orph')!.status, 'failed');
    db.close();
  });
});

describe('sessions', () => {
  test('keys on thread, agent and project independently', () => {
    const db = openDb(join(box.root, 'sess.db'));
    const s = new SessionStore(db);
    s.set({ threadId: 't1', agent: 'dev', project: 'a' }, 'sid-1');
    s.set({ threadId: 't1', agent: 'dev', project: 'b' }, 'sid-2');
    assert.equal(s.get({ threadId: 't1', agent: 'dev', project: 'a' }), 'sid-1');
    assert.equal(s.get({ threadId: 't1', agent: 'dev', project: 'b' }), 'sid-2');
    assert.equal(s.get({ threadId: 't1' }), undefined);
    assert.equal(s.clearThread('t1'), 2);
    db.close();
  });
});

describe('artifacts', () => {
  test('writes, reads and lists per run', () => {
    const store = new ArtifactStore(join(box.root, 'artifacts'));
    store.write('r-art', 'result.txt', 'hello');
    store.append('r-art', 'transcript.jsonl', '{"a":1}');
    store.append('r-art', 'transcript.jsonl', '{"a":2}');
    assert.equal(store.read('r-art', 'result.txt'), 'hello');
    assert.equal(store.read('r-art', 'transcript.jsonl')!.trim().split('\n').length, 2);
    assert.deepEqual(store.list('r-art').map((a) => a.name).sort(), ['result.txt', 'transcript.jsonl']);
  });
});

describe('kv', () => {
  test('round-trips', () => {
    const db = openDb(join(box.root, 'kv.db'));
    kvSet(db, 'a', 'b');
    assert.equal(kvGet(db, 'a'), 'b');
    assert.equal(kvGet(db, 'missing'), undefined);
    db.close();
  });
});

describe('downsampler', () => {
  test('lets critical events through immediately', () => {
    const d = new Downsampler();
    const out = d.consider({ id: 1, ts: new Date().toISOString(), runId: 'r-1', kind: 'action.confirm_requested', summary: 'needs you', data: {}, source: 'policy' });
    assert.equal(out, 'needs you');
  });

  test('swallows noise between intervals', () => {
    const d = new Downsampler({ minIntervalMs: 60_000, maxChars: 200 });
    const now = Date.now();
    const ev = (kind: string, summary: string) => ({ id: 1, ts: new Date().toISOString(), runId: 'r-1', kind, summary, data: { tool: 'Bash' }, source: 'runner' }) as never;
    assert.ok(d.consider(ev('run.started', 'r-1 started'), now));
    assert.equal(d.consider(ev('agent.text', 'chatter'), now + 1000), undefined);
    assert.ok(d.consider(ev('run.finished', 'r-1 done'), now + 2000));
  });
});
