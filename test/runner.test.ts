import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { RunStore } from '../dist/store/runs.js';
import { SessionStore } from '../dist/store/sessions.js';
import { ArtifactStore } from '../dist/store/artifacts.js';
import { RunRegistry, BudgetExceededError, HaltedError } from '../dist/runner/registry.js';
import { FailureMonitor } from '../dist/runner/failures.js';
import { setCredentialClockForTest } from '../dist/runner/credentials.js';
import { ClaudeProcess } from '../dist/runner/claude.js';
import { modelFor } from '../dist/runner/profiles.js';
import { ESCALATE, needsTools } from '../dist/runner/chat.js';
import { GitWrapper } from '../dist/runner/git.js';
import { installHook } from '../dist/runner/hook.js';
import { sandbox, fakeClaudeShim, waitFor, type Sandbox } from './helpers.ts';

let box: Sandbox;
let bin: string;

function harness(overrides: Record<string, unknown> = {}) {
  const cfg = { ...box.cfg, claudeBin: bin, ...overrides };
  const db = openDb(join(box.root, `run-${Math.random().toString(36).slice(2)}.db`));
  const events = new EventLog(db);
  const runs = new RunStore(db);
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(cfg.resolved.artifactsDir);
  const registry = new RunRegistry(cfg as never, events, runs, sessions, artifacts, 'test-hook-token');
  registry.start();
  return { cfg, db, events, runs, sessions, artifacts, registry };
}

before(() => {
  box = sandbox();
  bin = fakeClaudeShim(box.root);
});
after(() => box.cleanup());

describe('claude process wrapper', () => {
  test('builds the argument list we expect', () => {
    const p = new ClaudeProcess({
      bin: 'claude',
      cwd: '/tmp',
      prompt: 'hello',
      maxTurns: 12,
      model: 'claude-opus-5',
      resumeSessionId: 'sess-1',
      appendSystemPrompt: 'be terse',
      allowedTools: ['Read', 'Bash'],
      permissionMode: 'bypassPermissions',
      interactive: true,
    });
    const args = p.buildArgs().join(' ');
    assert.match(args, /--output-format stream-json/);
    assert.match(args, /--input-format stream-json/);
    assert.match(args, /--resume sess-1/);
    assert.match(args, /--max-turns 12/);
    assert.match(args, /--allowedTools Read,Bash/);
    // In interactive mode the prompt goes over stdin, not argv.
    assert.equal(args.includes('hello'), false);
  });

  test('parses a stream into typed events', async () => {
    const p = new ClaudeProcess({ bin, cwd: box.root, prompt: 'SCENARIO:turns=2 hello', interactive: true });
    const kinds: string[] = [];
    p.on('event', (e: { type: string }) => kinds.push(e.type));
    p.start();
    // Interactive mode stays open for follow-ups, so the turn ends at `result`;
    // closing stdin is what actually ends the process.
    await new Promise((r) => p.on('event', (e: { type: string }) => e.type === 'result' && r(null)));
    p.finishInput();
    await new Promise((r) => p.on('event', (e: { type: string }) => e.type === 'exit' && r(null)));
    assert.ok(kinds.includes('init'));
    assert.equal(kinds.filter((k) => k === 'text').length, 2);
    assert.ok(kinds.includes('result'));
    assert.equal(p.sessionId, '00000000-0000-4000-8000-000000000001');
    assert.equal(p.costUsd, 0.0123);
  });
});

describe('end-to-end runs', () => {
  test('a run reaches done, records cost and captures artifacts', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'say hello', project: 'proj', channel: 'cli', threadId: 't1' });
    await waitFor(() => h.runs.get(run.id)?.status === 'done');

    const final = h.runs.get(run.id)!;
    assert.equal(final.status, 'done');
    assert.equal(final.costUsd, 0.0123);
    assert.ok(final.result?.startsWith('done:'));
    assert.ok(h.artifacts.read(run.id, 'transcript.jsonl'));

    const kinds = h.events.replay({ runId: run.id, limit: 200 }).map((e) => e.kind);
    assert.ok(kinds.includes('run.queued'));
    assert.ok(kinds.includes('run.started'));
    assert.ok(kinds.includes('run.finished'));
    await h.registry.stop();
  });

  test('the session id is remembered for the thread', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'hello', project: 'proj', channel: 'imessage', threadId: 'chat-1' });
    await waitFor(() => h.runs.get(run.id)?.status === 'done');
    assert.equal(h.sessions.get({ threadId: 'chat-1', project: 'proj' }), '00000000-0000-4000-8000-000000000001');
    await h.registry.stop();
  });

  test('a run that writes files lands on its own branch with a diff', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'SCENARIO:write make a file', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(run.id)?.status === 'done', 15_000);

    const final = h.runs.get(run.id)!;
    assert.equal(final.branch, `switchboard/${run.id}`);
    const diff = h.artifacts.read(run.id, 'changes.diff');
    assert.match(diff ?? '', /fake-output\.txt/);

    // The working tree is back on main, with the run parked on its branch.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: box.projectDir, encoding: 'utf8' }).trim();
    assert.equal(branch, 'main');
    assert.equal(existsSync(join(box.projectDir, 'fake-output.txt')), false);
    await h.registry.stop();
  });

  test('a failing run is marked failed', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'SCENARIO:fail do a thing', project: 'proj', channel: 'cli' });
    await waitFor(() => ['failed', 'killed'].includes(h.runs.get(run.id)?.status ?? ''));
    assert.equal(h.runs.get(run.id)!.status, 'failed');
    assert.match(h.artifacts.read(run.id, 'stderr.log') ?? '', /Credit balance/);
    await h.registry.stop();
  });

  test('kill stops a live run and reports 143 as a kill, not a crash', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'SCENARIO:hang forever', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(run.id)?.status === 'running');
    assert.equal(h.registry.kill(run.id, 'test kill'), true);
    await waitFor(() => h.runs.get(run.id)?.status === 'killed');
    assert.equal(h.runs.get(run.id)!.status, 'killed');
    await h.registry.stop();
  });

  test('a per-project lock serialises runs in the same repo', async () => {
    const h = harness({ maxConcurrentRuns: 4 });
    const a = h.registry.submit({ prompt: 'SCENARIO:hang one', project: 'proj', channel: 'cli' });
    const b = h.registry.submit({ prompt: 'two', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(a.id)?.status === 'running');
    assert.equal(h.runs.get(b.id)!.status, 'queued');
    h.registry.kill(a.id, 'done testing');
    await waitFor(() => h.runs.get(b.id)?.status === 'done', 20_000);
    await h.registry.stop();
  });

  test('the monthly budget refuses new work', async () => {
    const h = harness({ caps: { ...box.cfg.caps, monthlyBudgetUsd: 0.001 } });
    const first = h.registry.submit({ prompt: 'hello', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(first.id)?.status === 'done');
    assert.throws(() => h.registry.submit({ prompt: 'again', project: 'proj', channel: 'cli' }), BudgetExceededError);
    await h.registry.stop();
  });

  test('follow-ups are only accepted while a run is live', async () => {
    const h = harness();
    const run = h.registry.submit({ prompt: 'SCENARIO:hang', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(run.id)?.status === 'running');
    assert.equal(h.registry.followUp(run.id, 'also do this'), true);
    h.registry.kill(run.id);
    await waitFor(() => h.runs.get(run.id)?.status === 'killed');
    assert.equal(h.registry.followUp(run.id, 'too late'), false);
    await h.registry.stop();
  });
});

describe('git wrapper', () => {
  test('branch, diff, commit and park', async () => {
    const dir = box.projectDir;
    const git = new GitWrapper(dir);
    const started = await git.startRun('r-gittest');
    assert.equal(started.branch, 'switchboard/r-gittest');
    writeFileSync(join(dir, 'newfile.txt'), 'hi\n');
    const diff = await git.finishRun(started.baseSha);
    assert.equal(diff.filesChanged, 1);
    assert.equal(diff.insertions, 1);
    await git.commit('test commit');
    await git.park(started.base);
    assert.equal(existsSync(join(dir, 'newfile.txt')), false);
  });
});

describe('hook installation', () => {
  test('writes a script and a settings file that wires PreToolUse', () => {
    const setup = installHook(join(box.root, 'hookdata'));
    assert.ok(existsSync(setup.scriptPath));
    const settings = JSON.parse(readFileSync(setup.settingsPath, 'utf8')) as { hooks: { PreToolUse: unknown[] } };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.match(readFileSync(setup.scriptPath, 'utf8'), /permissionDecision/);
  });
});

describe('a run never destroys uncommitted work', () => {
  /**
   * This is a regression test for real data loss. A run does `git add -A` and
   * commits, then checks out the base branch — which deletes any file that only
   * existed in the operator's uncommitted work, because the run's branch now
   * owns it. A source file vanished mid-session this way, and a gitignored
   * build artifact hid the damage until much later.
   */
  test('an untracked file the operator was writing survives the run', async () => {
    const dir = box.projectDir;
    const mine = join(dir, 'my-work-in-progress.ts');
    writeFileSync(mine, 'export const mine = 1;\n');

    const git = new GitWrapper(dir);
    const started = await git.startRun('r-stash1');
    assert.equal(started.stashed, true, 'a dirty tree must be stashed');
    assert.equal(existsSync(mine), false, 'the run should start from a clean tree');

    // The run does its own work and commits it to the branch.
    writeFileSync(join(dir, 'agent-output.txt'), 'what the agent did\n');
    await git.commit('the agent’s work');

    const restored = await git.restore(started.base, started.stashed);
    assert.equal(restored.restored, true, restored.problem ?? '');
    assert.equal(existsSync(mine), true, 'the operator’s file must come back');
    assert.equal(readFileSync(mine, 'utf8'), 'export const mine = 1;\n');
    assert.equal(existsSync(join(dir, 'agent-output.txt')), false, 'the agent’s work stays on its branch');

    rmSync(mine, { force: true });
  });

  test('a modified tracked file is restored too, not just untracked ones', async () => {
    const dir = box.projectDir;
    const readme = join(dir, 'README.md');
    const original = readFileSync(readme, 'utf8');
    writeFileSync(readme, `${original}my unsaved edit\n`);

    const git = new GitWrapper(dir);
    const started = await git.startRun('r-stash2');
    assert.equal(readFileSync(readme, 'utf8'), original, 'the run starts from the committed state');

    await git.restore(started.base, started.stashed);
    assert.match(readFileSync(readme, 'utf8'), /my unsaved edit/);

    writeFileSync(readme, original);
  });

  test('a clean tree is not stashed, so nothing is disturbed', async () => {
    const git = new GitWrapper(box.projectDir);
    const started = await git.startRun('r-stash3');
    assert.equal(started.stashed, false);
    const restored = await git.restore(started.base, started.stashed);
    assert.equal(restored.restored, true);
  });
});

describe('model tiering', () => {
  const cfg = { models: { chat: 'haiku', query: 'sonnet', bridge: 'haiku' } } as never;

  test('each lane gets its own model, and task is left to the CLI', () => {
    assert.equal(modelFor(cfg, { intent: 'chat' }), 'haiku');
    assert.equal(modelFor(cfg, { intent: 'query' }), 'sonnet');
    assert.equal(modelFor(cfg, { intent: 'task' }), undefined);
  });

  test('an unknown intent is treated as task, never as the cheap lane', () => {
    // Getting this backwards would silently run real work on the small model.
    assert.equal(modelFor(cfg, {}), undefined);
  });

  test('most specific wins: explicit over agent over lane', () => {
    const agent = { name: 'dev', model: 'opus' } as never;
    assert.equal(modelFor(cfg, { intent: 'chat', agent }), 'opus');
    assert.equal(modelFor(cfg, { intent: 'chat', agent, explicit: 'sonnet' }), 'sonnet');
  });

  test('an agent with no model of its own still falls through to the lane', () => {
    assert.equal(modelFor(cfg, { intent: 'chat', agent: { name: 'dev' } as never }), 'haiku');
  });

  test('no models configured at all leaves every lane on the CLI default', () => {
    assert.equal(modelFor({} as never, { intent: 'chat' }), undefined);
  });
});

describe('the chat lane answers from a resident session', () => {
  const events = (h: ReturnType<typeof harness>, id: string) => h.events.replay({ runId: id, limit: 200 });
  const chatRun = (h: ReturnType<typeof harness>, prompt: string, threadId = 't1') =>
    h.registry.submit({ prompt, intent: 'chat', channel: 'imessage', threadId });

  test('a conversational turn is served without spawning a run process', async () => {
    const h = harness();
    await h.registry.chat.prewarm();
    const run = chatRun(h, 'how is it going');
    await waitFor(() => h.runs.get(run.id)?.status === 'done');

    const started = events(h, run.id).find((e) => e.kind === 'run.started');
    assert.equal(started?.data.warm, true, 'served from the warm session');
    await h.registry.stop();
  });

  test('the run record and the event log look the same either way', async () => {
    // The dashboard, the cost panel and the iMessage downsample are all reads
    // of the event log. None of them may be able to tell which path served a
    // turn, so the same events have to be there in the same order.
    const h = harness();
    await h.registry.chat.prewarm();
    const run = chatRun(h, 'say something');
    await waitFor(() => h.runs.get(run.id)?.status === 'done');

    const kinds = events(h, run.id).map((e) => e.kind);
    for (const required of ['run.queued', 'run.started', 'agent.text', 'run.finished']) {
      assert.ok(kinds.includes(required), `missing ${required} — got ${kinds.join(', ')}`);
    }
    const rec = h.runs.get(run.id)!;
    assert.equal(rec.status, 'done');
    assert.ok(rec.result && rec.result.length > 0, 'the answer is on the record');
    assert.ok(rec.finishedAt, 'finished, not left open');

    // The downsampler relays `result` off the finished event; without it the
    // person who asked gets a timing line instead of an answer.
    const finished = events(h, run.id).find((e) => e.kind === 'run.finished');
    assert.equal(finished?.data.result, rec.result);
    await h.registry.stop();
  });

  test('a question that needs tools falls back to a spawned run', async () => {
    // The fake echoes the prompt, so this reply carries the escalation
    // sentinel — the same shape as a real model declining a tool-free turn.
    const h = harness();
    await h.registry.chat.prewarm();
    const run = chatRun(h, `${ESCALATE} please`);
    await waitFor(() => h.runs.get(run.id)?.status === 'done', 20_000);

    const started = events(h, run.id).find((e) => e.kind === 'run.started');
    assert.notEqual(started?.data.warm, true, 'escalated to a real run');
    await h.registry.stop();
  });

  test('a chat run inside a project is never served warm', async () => {
    // A project means a repo, which means tools, which means gating — and the
    // hook reads SWB_RUN_ID from the process, so a shared process would
    // attribute the call to the wrong run.
    const h = harness();
    await h.registry.chat.prewarm();
    const run = h.registry.submit({ prompt: 'hi there', intent: 'chat', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(run.id)?.status === 'done', 20_000);
    const started = events(h, run.id).find((e) => e.kind === 'run.started');
    assert.notEqual(started?.data.warm, true);
    await h.registry.stop();
  });

  test('two threads do not read each other', async () => {
    // One resident process is one conversation. A thread switch has to recycle,
    // or an iMessage thread can see what was said on the dashboard.
    const h = harness();
    await h.registry.chat.prewarm();
    const a = chatRun(h, 'first thread', 'thread-a');
    await waitFor(() => h.runs.get(a.id)?.status === 'done');
    const b = chatRun(h, 'second thread', 'thread-b');
    await waitFor(() => h.runs.get(b.id)?.status === 'done', 20_000);

    assert.match(h.runs.get(a.id)!.result ?? '', /first thread/);
    assert.match(h.runs.get(b.id)!.result ?? '', /second thread/);
    await h.registry.stop();
  });

  test('with no chat model configured nothing is warmed', async () => {
    const h = harness({ models: {} });
    assert.equal(h.registry.chat.enabled, false);
    const run = chatRun(h, 'hello');
    await waitFor(() => h.runs.get(run.id)?.status === 'done', 20_000);
    const started = events(h, run.id).find((e) => e.kind === 'run.started');
    assert.notEqual(started?.data.warm, true);
    await h.registry.stop();
  });
});

describe('a resident session bills each turn once', () => {
  test('cost is the turn, not the running total', async () => {
    // `total_cost_usd` climbs for the life of the session. Billing it whole
    // would re-charge every earlier turn and drain the monthly budget at a
    // multiple of the real rate.
    const h = harness();
    await h.registry.chat.prewarm();

    const costs: number[] = [];
    for (const text of ['one', 'two', 'three']) {
      const run = h.registry.submit({ prompt: text, intent: 'chat', channel: 'imessage', threadId: 'billing' });
      await waitFor(() => h.runs.get(run.id)?.status === 'done', 20_000);
      costs.push(h.runs.get(run.id)!.costUsd);
    }

    assert.ok(costs.every((c) => c > 0), `every turn costs something: ${costs.join(', ')}`);
    // The later turns must not each carry the whole session's history.
    assert.ok(costs[2]! <= costs[1]! + 1e-9, `cost must not climb per turn: ${costs.join(', ')}`);
    assert.ok(costs[1]! <= costs[0]! + 1e-9, `cost must not climb per turn: ${costs.join(', ')}`);
    await h.registry.stop();
  });
});

describe('a misrouted chat is promoted, not just spawned', () => {
  test('needing tools moves the run to the query lane and its model', async () => {
    // Escalating without changing the model leaves a tool-using question on the
    // cheapest model, which is how a small model ends up looping on a tool.
    const h = harness();
    await h.registry.chat.prewarm();
    const run = h.registry.submit({
      prompt: `${ESCALATE} please`,
      intent: 'chat',
      channel: 'imessage',
      threadId: 'promote',
    });
    await waitFor(() => h.runs.get(run.id)?.status === 'done', 20_000);

    const rec = h.runs.get(run.id)!;
    assert.equal(rec.intent, 'query');
    assert.equal(rec.model, modelFor(h.cfg as never, { intent: 'query' }));
    assert.notEqual(rec.model, modelFor(h.cfg as never, { intent: 'chat' }));
    await h.registry.stop();
  });
});

describe('the tool-free lane knows what it cannot answer', () => {
  test('questions about this machine escalate without asking the model', () => {
    // The observed failure: asked to list the scratch directory, a tool-free
    // session answered from its own environment block and happened to be right.
    for (const q of [
      'List the files in your scratch directory.',
      'What is in ~/.switchboard?',
      'How many lines are in src/runner/registry.ts?',
      'read CLAUDE.md and summarise it',
      'what does my config look like',
      'show me the last commit',
      'run npm test',
      'check the logs',
      'what is the latest version of node',
    ]) {
      assert.equal(needsTools(q), true, `should escalate: ${q}`);
    }
  });

  test('ordinary conversation is still answered warm', () => {
    // Over-escalating costs a query run; the rule must not swallow the lane.
    for (const q of [
      'how is it going',
      'thanks, that helped',
      'what is the difference between a mutex and a semaphore',
      'explain tail call optimisation',
      'good morning',
      'why is TCP slow start called that',
    ]) {
      assert.equal(needsTools(q), false, `should stay warm: ${q}`);
    }
  });
});

describe('a halted daemon stops spending', () => {
  const halt = { message: 'Claude auth is no longer valid.', remedy: 'Log in again.' };

  test('submit refuses while halted, with the remedy', () => {
    // Before this, the daemon knew it was broken and kept proving it: three
    // scheduled runs died on the same expired login, minutes apart.
    const h = harness();
    h.registry.haltGate = () => halt;
    assert.throws(() => h.registry.submit({ prompt: 'anything', project: 'proj', channel: 'schedule' }), HaltedError);
    try {
      h.registry.submit({ prompt: 'anything', channel: 'cli' });
    } catch (err) {
      assert.match((err as Error).message, /auth is no longer valid/);
      assert.match((err as Error).message, /Log in again/);
    }
    assert.equal(h.runs.list({ limit: 10 }).length, 0, 'no row is written for work that cannot run');
  });

  test('clearing the halt lets work through again', async () => {
    const h = harness();
    let halted: typeof halt | null = halt;
    h.registry.haltGate = () => halted;
    assert.throws(() => h.registry.submit({ prompt: 'x', project: 'proj', channel: 'cli' }), HaltedError);
    halted = null;
    const run = h.registry.submit({ prompt: 'now it works', project: 'proj', channel: 'cli' });
    await waitFor(() => h.runs.get(run.id)?.status === 'done');
    await h.registry.stop();
  });
});

describe('expired auth un-halts itself', () => {
  const authFailure = {
    id: 'r-auth',
    status: 'failed',
    turns: 0,
    exitCode: 1,
    error: 'Invalid API key · Please run /login',
  } as never;

  test('a halt lifts when the stored credential expiry moves forward', () => {
    // The one halt with a free, exact signal: someone logs in on the Mac Mini
    // and the token's expiry advances. No probe, no spend, no waiting to be told.
    const db = openDb(join(box.root, `halt-${Math.random().toString(36).slice(2)}.db`));
    const monitor = new FailureMonitor(new EventLog(db), new RunStore(db), new ArtifactStore(box.cfg.resolved.artifactsDir));

    let expiresAt = Date.now() - 60_000;
    setCredentialClockForTest(() => ({ expiresAt, source: 'keychain' }));
    try {
      monitor.inspect(authFailure);
      assert.ok(monitor.haltReason, 'an expired login halts the daemon');
      assert.equal(monitor.recheck(), false, 'still broken, still halted');

      expiresAt = Date.now() + 60 * 60_000;
      assert.equal(monitor.recheck(), true, 'a fresh login lifts the halt');
      assert.equal(monitor.haltReason, null);
    } finally {
      setCredentialClockForTest(null);
    }
  });

  test('a halt with no local evidence stays a human decision', () => {
    // Exhausted credit cannot be observed from here, and guessing at recovery
    // would just burn a run to rediscover it.
    const db = openDb(join(box.root, `halt2-${Math.random().toString(36).slice(2)}.db`));
    const monitor = new FailureMonitor(new EventLog(db), new RunStore(db), new ArtifactStore(box.cfg.resolved.artifactsDir));
    monitor.inspect({ id: 'r-credit', status: 'failed', turns: 0, exitCode: 1, error: 'Credit balance is too low' } as never);
    assert.equal(monitor.haltReason?.kind, 'credit_exhausted');
    assert.equal(monitor.recheck(), false);
    assert.ok(monitor.haltReason, 'only a human clears this one');
  });
});
