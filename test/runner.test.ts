import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { RunStore } from '../dist/store/runs.js';
import { SessionStore } from '../dist/store/sessions.js';
import { ArtifactStore } from '../dist/store/artifacts.js';
import { RunRegistry, BudgetExceededError } from '../dist/runner/registry.js';
import { ClaudeProcess } from '../dist/runner/claude.js';
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
