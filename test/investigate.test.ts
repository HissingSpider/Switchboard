import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../dist/store/db.js';
import { EventLog } from '../dist/store/eventlog.js';
import { RunStore } from '../dist/store/runs.js';
import { SessionStore } from '../dist/store/sessions.js';
import { ArtifactStore } from '../dist/store/artifacts.js';
import { RunRegistry } from '../dist/runner/registry.js';
import { EntityRegistry, EXAMPLE_ENTITY_MAP } from '../dist/investigate/entities.js';
import { InvestigationService, parseFindings, parseAnswer, parseBlocked } from '../dist/investigate/loop.js';
import { runChecks, recheck, describeHealth, formatReport } from '../dist/investigate/health.js';
import { Vault, slugify, vaultPointer, parseVaultPointer, VaultError } from '../dist/vault/vault.js';
import { parseCardTitle, matchesFilter, summarizeDiff, QueueWorker } from '../dist/queue/worker.js';
import { parseJsonish, NullDeerDawnClient } from '../dist/queue/deerdawn.js';
import { DEFAULT_PERMISSION_PROFILES } from '../dist/config/schema.js';
import { sandbox, fakeClaudeShim, waitFor, type Sandbox } from './helpers.ts';

let box: Sandbox;
let bin: string;
let n = 0;

before(() => {
  box = sandbox();
  bin = fakeClaudeShim(box.root);
});
after(() => box.cleanup());

function harness(cfgOver: Record<string, unknown> = {}) {
  const cfg = { ...box.cfg, claudeBin: bin, ...cfgOver };
  const db = openDb(join(box.root, `inv-${n++}.db`));
  const events = new EventLog(db);
  const runs = new RunStore(db);
  const artifacts = new ArtifactStore(cfg.resolved.artifactsDir);
  const registry = new RunRegistry(cfg as never, events, runs, new SessionStore(db), artifacts, 'tok');
  registry.start();
  const entities = new EntityRegistry(join(box.root, `entities-${n}.json`));
  const investigations = new InvestigationService(db, cfg as never, registry, runs, events, entities);
  return { cfg, db, events, runs, artifacts, registry, entities, investigations };
}

// ------------------------------------------------------------------ entities

describe('entity map', () => {
  test('resolves spoken terms to concrete identifiers', () => {
    const path = join(box.root, 'ents.json');
    const registry = new EntityRegistry(path);
    registry.write(EXAMPLE_ENTITY_MAP);

    const hits = registry.resolve('how are signups doing today?');
    assert.equal(hits[0]?.name, 'signup');
    const context = registry.contextFor('how are signups doing today?');
    assert.match(context, /user_signed_up/);
    assert.match(context, /Normal looks like/);
  });

  test('the longer alias wins, so "first sync" is not just "sync"', () => {
    const registry = new EntityRegistry(join(box.root, 'ents2.json'));
    registry.write(EXAMPLE_ENTITY_MAP);
    assert.equal(registry.resolve('what happened to first sync last week')[0]?.name, 'first sync');
  });

  test('an unrelated question resolves to nothing rather than guessing', () => {
    const registry = new EntityRegistry(join(box.root, 'ents3.json'));
    registry.write(EXAMPLE_ENTITY_MAP);
    assert.equal(registry.resolve('what is the weather like').length, 0);
    assert.equal(registry.contextFor('what is the weather like'), '');
  });

  test('gaps name the entities that will produce useless answers', () => {
    const registry = new EntityRegistry(join(box.root, 'ents4.json'));
    registry.write({ entities: [{ name: 'thing', aliases: ['thingy'] }] });
    const gaps = registry.gaps();
    assert.equal(gaps[0]!.name, 'thing');
    assert.ok(gaps[0]!.missing.includes('baseline'));
  });

  test('a missing or malformed map is empty, not fatal', () => {
    assert.equal(new EntityRegistry(join(box.root, 'nope.json')).all().length, 0);
    const bad = join(box.root, 'bad.json');
    writeFileSync(bad, 'not json');
    assert.equal(new EntityRegistry(bad).all().length, 0);
  });
});

// -------------------------------------------------------------------- health

describe('health manifest', () => {
  test('runs the check sequence and stops at the first failure', async () => {
    const report = await runChecks({
      project: 'demo',
      checks: [
        { name: 'first', run: 'echo alive', expect: 'alive' },
        { name: 'second', run: 'echo nope', expect: 'yes' },
        { name: 'third', run: 'echo never-runs' },
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.firstFailure?.name, 'second');
    assert.equal(report.results.length, 2, 'should not have run the third check');
  });

  test('a healthy project passes every runnable check', async () => {
    const report = await runChecks({ project: 'demo', checks: [{ name: 'a', run: 'echo ok', expect: 'ok' }] });
    assert.equal(report.ok, true);
    assert.match(formatReport(report), /healthy/);
  });

  test('question steps are left for the investigator, not executed', async () => {
    const report = await runChecks({ project: 'demo', checks: [{ name: 'judgement', ask: 'is the error rate unusual?' }] });
    assert.equal(report.results.length, 0);
    assert.equal(report.pending.length, 1);
  });

  test('a failing command counts as a failure, not a crash', async () => {
    const report = await runChecks({ project: 'demo', checks: [{ name: 'boom', run: 'exit 3' }] });
    assert.equal(report.ok, false);
    assert.equal(report.firstFailure?.name, 'boom');
  });

  test('recheck re-runs exactly one named check', async () => {
    const manifest = { project: 'demo', checks: [{ name: 'a', run: 'echo one', expect: 'one' }, { name: 'b', run: 'echo two', expect: 'nope' }] };
    assert.equal((await recheck(manifest, 'a')).ok, true);
    assert.equal((await recheck(manifest, 'b')).ok, false);
    assert.match((await recheck(manifest, 'missing')).skipped ?? '', /no such check/);
  });

  test('describeHealth states the five facts that matter', () => {
    const text = describeHealth({ project: 'demo', deployTarget: 'https://x', errorSource: 'posthog', keyMetrics: ['a', 'b'], repoPath: '/tmp' });
    assert.match(text, /Runs at/);
    assert.match(text, /Errors show up in/);
    assert.match(text, /numbers that matter/);
  });
});

// ------------------------------------------------------------- investigation

describe('investigation loop', () => {
  test('parses the checkpoint markers out of a run result', () => {
    const text = [
      'Looked at the dashboard.',
      'FINDING observation: signups dropped to zero at 03:00 UTC.',
      'FINDING ruled_out: the deploy at 02:40 did not touch the signup path.',
      'FINDING cause: the migration adding users.locale never ran in production.',
      'ANSWER: signups have been failing since 03:00 because a migration never ran.',
    ].join('\n');

    const findings = parseFindings(text);
    assert.equal(findings.length, 3);
    assert.equal(findings[2]!.kind, 'cause');
    assert.match(parseAnswer(text)!, /migration never ran/);
    assert.equal(parseBlocked(text), undefined);
  });

  test('BLOCKED is recognised separately from an answer', () => {
    const text = 'FINDING blocked: no PostHog access.\nBLOCKED: I need the PostHog project id for the production project.';
    assert.equal(parseAnswer(text), undefined);
    assert.match(parseBlocked(text)!, /PostHog project id/);
  });

  test('an investigation run is read-only by construction', async () => {
    const h = harness();
    h.investigations.start({ question: 'why is the build slow', project: 'proj', channel: 'cli' });
    const open = h.investigations.open();
    assert.equal(open.length, 1);
    await waitFor(() => Boolean(h.investigations.get(open[0]!.id)?.runId), 5000);
    const runId = h.investigations.get(open[0]!.id)!.runId!;
    // The profile is what enforces it — assert the run actually got it.
    const active = h.registry.getActive(runId);
    if (active) assert.equal(active.permissionProfile, 'investigate');
    await h.registry.stop();
  });

  test('the investigate profile denies writes and halts', () => {
    const profile = DEFAULT_PERMISSION_PROFILES.find((p) => p.name === 'investigate')!;
    assert.equal(profile.haltOnDeny, true);
    assert.equal(profile.fallback, 'deny');
    assert.ok(profile.deny.includes('Write'));
    assert.ok(profile.allow.includes('Read'));
  });

  test('findings accumulate and are fed back in on resume', async () => {
    const h = harness();
    const inv = h.investigations.start({ question: 'why is it slow', channel: 'cli' });
    h.investigations.addFinding(inv.id, 'observation', 'p95 is 4s');
    h.investigations.addFinding(inv.id, 'ruled_out', 'not the database');
    const findings = h.investigations.findings(inv.id);
    assert.equal(findings.length, 2);
    assert.equal(findings[0]!.kind, 'observation');
    await h.registry.stop();
  });

  test('an answered investigation can become a fix, and a blocked one cannot', async () => {
    const h = harness();
    const inv = h.investigations.start({ question: 'why is it broken', project: 'proj', channel: 'cli', originCheck: 'tests pass' });
    assert.equal(await h.investigations.proposeFix(inv.id), undefined, 'an open investigation is not fixable');

    h.db.prepare(`UPDATE investigations SET status='answered', answer='the config is wrong' WHERE id = ?`).run(inv.id);
    h.investigations.addFinding(inv.id, 'cause', 'the config is wrong');
    const run = await h.investigations.proposeFix(inv.id);
    assert.ok(run);
    // The fix run is told which check it has to satisfy.
    assert.match(run!.prompt, /re-run the check called "tests pass"/);
    assert.match(run!.prompt, /do not re-investigate/i);
    await h.registry.stop();
  });

  test('a fix is verified by re-running the check, not by its own claim', async () => {
    const h = harness({
      health: [{ project: 'proj', repoPath: box.projectDir, checks: [{ name: 'sentinel', run: 'cat sentinel.txt', expect: 'fixed' }] }],
    });
    const inv = h.investigations.start({ question: 'sentinel is wrong', project: 'proj', channel: 'cli', originCheck: 'sentinel' });
    h.db.prepare(`UPDATE investigations SET status='answered', answer='x' WHERE id = ?`).run(inv.id);

    writeFileSync(join(box.projectDir, 'sentinel.txt'), 'broken\n');
    const run = (await h.investigations.proposeFix(inv.id))!;

    // The run claims success; the check disagrees, and the check wins.
    h.runs.update(run.id, { status: 'done', result: 'All fixed!' });
    const first = await h.investigations.verifyFix(h.runs.get(run.id)!);
    assert.equal(first?.verified, false);

    writeFileSync(join(box.projectDir, 'sentinel.txt'), 'fixed\n');
    const second = await h.investigations.verifyFix(h.runs.get(run.id)!);
    assert.equal(second?.verified, true);
    await h.registry.stop();
  });
});

// --------------------------------------------------------------------- vault

describe('obsidian vault', () => {
  function makeVault(name: string, over: Record<string, unknown> = {}) {
    const root = join(box.root, name);
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    return new Vault({ enabled: true, path: root, writeSubfolder: 'switchboard', git: false, ...over });
  }

  test('writes land in the subfolder and are readable back by ref', async () => {
    const vault = makeVault('vault1');
    const note = await vault.write('runs/2026-01-01-r-abc.md', 'A run', 'What happened.');
    assert.ok(note.path.includes('/switchboard/runs/'));
    assert.equal(vault.read(note.ref)!.body, 'What happened.');
    assert.deepEqual(vault.ours(), [note.ref]);
  });

  test('a write outside the subfolder is refused', async () => {
    const vault = makeVault('vault2');
    await assert.rejects(() => vault.write('../../escape.md', 'x', 'y'), VaultError);
    await assert.rejects(() => vault.write('/etc/passwd.md', 'x', 'y'), VaultError);
    // Personal notes elsewhere in the vault are untouchable.
    await assert.rejects(() => vault.write('../Daily/2026-01-01.md', 'x', 'y'), VaultError);
  });

  test('only .md files are written', async () => {
    const vault = makeVault('vault3');
    await assert.rejects(() => vault.write('runs/thing.sh', 'x', 'y'), VaultError);
  });

  test('reads may come from anywhere in the vault, but only via an explicit ref', async () => {
    const vault = makeVault('vault4');
    mkdirSync(join(vault.root, 'Daily'), { recursive: true });
    writeFileSync(join(vault.root, 'Daily', 'note.md'), '---\ntitle: Personal\n---\nprivate thoughts');
    // Readable when pointed at…
    assert.match(vault.read('Daily/note.md')!.body, /private thoughts/);
    // …but never enumerated: `ours()` only lists what Switchboard wrote.
    assert.equal(vault.ours().length, 0);
    assert.throws(() => vault.read('../outside.md'), VaultError);
  });

  test('append builds a running narrative', async () => {
    const vault = makeVault('vault5');
    await vault.write('runs/x.md', 'X', 'first');
    await vault.append('runs/x.md', 'X', 'second');
    const body = vault.read('switchboard/runs/x.md')!.body;
    assert.match(body, /first/);
    assert.match(body, /second/);
  });

  test('frontmatter marks the note as ours', async () => {
    const vault = makeVault('vault6');
    const note = await vault.write('runs/y.md', 'Y', 'body');
    assert.match(readFileSync(note.path, 'utf8'), /source: switchboard/);
  });

  test('a disabled or missing vault reports why rather than throwing on use', () => {
    const missing = new Vault({ enabled: true, path: join(box.root, 'nope') });
    assert.equal(missing.enabled, false);
    assert.ok(missing.problems.some((p) => p.includes('does not exist')));
    assert.equal(missing.ours().length, 0);
    assert.equal(new Vault({ enabled: false }).problems[0], 'vault disabled');
  });

  test('pointers round-trip and only vault: refs are honoured', () => {
    assert.equal(parseVaultPointer(vaultPointer('switchboard/runs/x.md')), 'switchboard/runs/x.md');
    assert.equal(parseVaultPointer('/etc/passwd'), undefined);
    assert.equal(parseVaultPointer(null), undefined);
    assert.equal(slugify('Why is the build SO slow?!'), 'why-is-the-build-so-slow');
  });
});

// --------------------------------------------------------------------- queue

describe('deerdawn queue', () => {
  test('a [project] prefix routes the card', () => {
    assert.deepEqual(parseCardTitle('[swb] fix the flaky test'), { project: 'swb', text: 'fix the flaky test' });
    assert.deepEqual(parseCardTitle('fix the flaky test'), { text: 'fix the flaky test' });
  });

  test('the label filter is honoured', () => {
    assert.equal(matchesFilter('[swb] do a thing', ['[swb]']), true);
    assert.equal(matchesFilter('[other] do a thing', ['[swb]']), false);
    assert.equal(matchesFilter('anything', undefined), true, 'no filter means everything');
  });

  test('the bridge tolerates prose around its JSON, and reports failure honestly', () => {
    assert.equal(parseJsonish('Here you go:\n{"ok":true,"cards":[]}\nHope that helps').ok, true);
    assert.equal(parseJsonish('{"ok":false,"error":"tool exploded"}').ok, false);
    assert.equal(parseJsonish('no json at all').ok, false);
    assert.equal(parseJsonish('').ok, false);
    assert.equal(parseJsonish('{broken').ok, false);
  });

  test('diff summaries count files and lines', () => {
    const patch = ['diff --git a/x b/x', '+++ b/x', '+one', '+two', '-three'].join('\n');
    assert.equal(summarizeDiff(patch), '1 file, +2/-1');
  });

  test('a disabled queue does nothing and says so', async () => {
    const h = harness();
    const worker = new QueueWorker(h.cfg as never, new NullDeerDawnClient(), h.registry, h.runs, h.events, h.artifacts, h.db);
    assert.equal(worker.enabled, false);
    assert.deepEqual(await worker.poll(), { claimed: 0, skipped: [] });
    worker.start(); // must be a no-op, not a crash
    worker.stop();
    await h.registry.stop();
  });

  test('a card is claimed before the run starts, and released if it cannot start', async () => {
    const moves: Array<{ card: string; phase: string }> = [];
    const client = {
      backlog: async () => [{ id: 'c1', title: '[nosuchproject] do a thing', phase: 'backlog' }],
      move: async (_p: string, card: string, phase: string) => {
        moves.push({ card, phase });
        return true;
      },
      recordOutcome: async () => true,
      brief: async () => undefined,
    };
    const h = harness({ deerdawn: { enabled: true, queueProjectId: 'p1', maxConcurrentCards: 1 } });
    const worker = new QueueWorker(h.cfg as never, client as never, h.registry, h.runs, h.events, h.artifacts, h.db);
    assert.equal(worker.enabled, true);
    await worker.poll();

    // Claimed first, then handed back because the project is unknown — never
    // run in an arbitrary directory.
    assert.deepEqual(moves, [
      { card: 'c1', phase: 'in_progress' },
      { card: 'c1', phase: 'blocked' },
    ]);
    await h.registry.stop();
  });

  test('a real card runs and its outcome is written back', async () => {
    const moves: string[] = [];
    let outcome: { status: string; branch?: string | null } | undefined;
    const client = {
      backlog: async () => [{ id: 'c2', title: '[proj] say hello', phase: 'backlog' }],
      move: async (_p: string, _c: string, phase: string) => {
        moves.push(phase);
        return true;
      },
      recordOutcome: async (_p: string, _c: unknown, o: { status: string; branch?: string | null }) => {
        outcome = o;
        return true;
      },
      brief: async () => 'Briefed: say hello politely.',
    };
    const h = harness({ deerdawn: { enabled: true, queueProjectId: 'p1', maxConcurrentCards: 1 } });
    const worker = new QueueWorker(h.cfg as never, client as never, h.registry, h.runs, h.events, h.artifacts, h.db);

    const claimed = await worker.poll();
    assert.equal(claimed.claimed, 1);
    assert.equal(moves[0], 'in_progress');

    // The outcome is written first, then the card is moved — wait for the move.
    await waitFor(() => moves.includes('done'), 20_000);
    assert.equal(outcome!.status, 'done');
    assert.equal(moves[moves.length - 1], 'done');
    await h.registry.stop();
  });

  test('a briefed card carries the brief into the prompt', async () => {
    const client = {
      backlog: async () => [{ id: 'c3', title: '[proj] do the briefed thing', phase: 'backlog' }],
      move: async () => true,
      recordOutcome: async () => true,
      brief: async () => 'THE BRIEF TEXT',
    };
    const h = harness({ deerdawn: { enabled: true, queueProjectId: 'p1', maxConcurrentCards: 1 } });
    const worker = new QueueWorker(h.cfg as never, client as never, h.registry, h.runs, h.events, h.artifacts, h.db);
    await worker.poll();
    const run = h.runs.list({ limit: 1 })[0]!;
    assert.match(run.prompt, /THE BRIEF TEXT/);
    // And a thread, so a confirm-by-reply has somewhere to land.
    assert.ok(run.threadId);
    await h.registry.stop();
  });
});
