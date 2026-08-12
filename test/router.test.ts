import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage, parseCommand } from '../dist/router/intent.js';
import { resolveProject, stripProjectPrefix } from '../dist/router/projects.js';
import { parseCron, cronMatches, nextRun } from '../dist/scheduler/cron.js';
import { SkillRegistry, parseFrontmatter } from '../dist/skills/loader.js';
import { scaffoldSkill, testSkill } from '../dist/skills/scaffold.js';
import { parseAgentFile, validateAgents, surfaceVoice } from '../dist/agents/registry.js';
import { normalizeHandle, allowlisted } from '../dist/adapters/types.js';
import { classify, diagnose } from '../dist/runner/failures.js';
import { inferTaskClass, effectiveCaps } from '../dist/runner/profiles.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
before(() => {
  box = sandbox({ projects: [] });
});
after(() => box.cleanup());

const cfg = () => ({
  ...box.cfg,
  projects: [
    { name: 'swb', path: box.projectDir, aliases: ['switchboard'] },
    { name: 'site', path: box.projectDir },
  ],
});

describe('project resolution', () => {
  test('explicit @prefix wins and is stripped', () => {
    const r = resolveProject(cfg() as never, '@swb fix the login bug');
    assert.equal(r.match?.project.name, 'swb');
    assert.equal(r.match?.via, 'explicit');
    assert.equal(r.text, 'fix the login bug');
  });

  test('aliases resolve', () => {
    assert.equal(resolveProject(cfg() as never, '@switchboard do it').match?.project.name, 'swb');
  });

  test('a mention in the body is a weaker match', () => {
    const r = resolveProject(cfg() as never, 'can you look at the site build?');
    assert.equal(r.match?.project.name, 'site');
    assert.equal(r.match?.via, 'mention');
  });

  test('sticky project is the last resort', () => {
    const r = resolveProject(cfg() as never, 'and fix the other one too', 'swb');
    assert.equal(r.match?.via, 'sticky');
  });

  test('an unknown explicit prefix matches nothing rather than guessing', () => {
    assert.equal(resolveProject(cfg() as never, '@nosuch do a thing').match, undefined);
  });

  test('prefix forms', () => {
    assert.deepEqual(stripProjectPrefix('in swb: go'), { text: 'go', key: 'swb' });
    assert.deepEqual(stripProjectPrefix('swb> go'), { text: 'go', key: 'swb' });
  });
});

describe('intent routing', () => {
  test('control commands never become runs', () => {
    for (const [text, kind] of [
      ['status', 'status'],
      ['/runs 5', 'runs'],
      ['kill r-abc', 'kill'],
      ['cost', 'cost'],
      ['reset', 'reset'],
      ['help', 'help'],
    ] as const) {
      assert.equal(parseCommand(text)?.kind, kind, text);
    }
  });

  test('follow-up command captures the run and the text', () => {
    const cmd = parseCommand('tell r-8k2wq also update the readme');
    assert.deepEqual(cmd, { kind: 'follow', runId: 'r-8k2wq', text: 'also update the readme' });
  });

  test('task verbs route to the task lane', () => {
    const r = routeMessage(cfg() as never, '@swb fix the failing test');
    assert.equal(r.intent, 'task');
    assert.equal(r.taskClass, 'coding');
    assert.equal(r.continueSession, false);
  });

  test('questions route to the query lane and keep the session', () => {
    const r = routeMessage(cfg() as never, 'what does the gateway bind to?');
    assert.equal(r.intent, 'query');
    assert.equal(r.continueSession, true);
  });

  test('greetings stay chat', () => {
    assert.equal(routeMessage(cfg() as never, 'hey').intent, 'chat');
  });

  test('!agent selects an agent for the message', () => {
    assert.equal(routeMessage(cfg() as never, '!ops restart the service').agent, 'ops');
  });

  test('GUI language picks the computer-use class', () => {
    assert.equal(inferTaskClass('take a screenshot of the settings pane', false), 'computer-use');
  });
});

describe('cron', () => {
  test('parses fields and steps', () => {
    const f = parseCron('*/15 9-17 * * 1-5');
    assert.deepEqual(f.minute, [0, 15, 30, 45]);
    assert.equal(f.hour.length, 9);
    assert.deepEqual(f.dow, [1, 2, 3, 4, 5]);
  });

  test('aliases work', () => {
    assert.deepEqual(parseCron('@daily').minute, [0]);
  });

  test('matches the right minute', () => {
    const f = parseCron('30 8 * * *');
    assert.equal(cronMatches(f, new Date(2026, 0, 5, 8, 30)), true);
    assert.equal(cronMatches(f, new Date(2026, 0, 5, 8, 31)), false);
  });

  test('dom and dow together are an OR, as in real cron', () => {
    const f = parseCron('0 0 1 * 0');
    assert.equal(cronMatches(f, new Date(2026, 2, 1)), true); // the 1st
    assert.equal(cronMatches(f, new Date(2026, 2, 8)), true); // a Sunday
    assert.equal(cronMatches(f, new Date(2026, 2, 10)), false);
  });

  test('rejects nonsense', () => {
    assert.throws(() => parseCron('* * *'));
    assert.throws(() => parseCron('99 * * * *'));
  });

  test('nextRun is strictly in the future', () => {
    const from = new Date(2026, 0, 1, 8, 30);
    const next = nextRun(parseCron('30 8 * * *'), from)!;
    assert.equal(next.getDate(), 2);
  });
});

describe('skills', () => {
  test('frontmatter parses', () => {
    const { data, body } = parseFrontmatter('---\nname: x\ndescription: does a thing\n---\nbody here\n');
    assert.equal(data.name, 'x');
    assert.equal(body.trim(), 'body here');
  });

  test('scaffold, load, catalogue and select', () => {
    const root = join(box.root, 'skills-test');
    mkdirSync(root, { recursive: true });
    scaffoldSkill(root, 'deploy-site', 'Deploy the marketing site to production and verify the build afterwards');
    const reg = new SkillRegistry(root);
    assert.equal(reg.all().length, 1);
    assert.match(reg.catalogue(), /deploy-site/);
    assert.equal(reg.select('deploy the site')[0]?.name, 'deploy-site');
    assert.match(reg.expand('deploy-site')!, /# Skill: deploy-site/);
  });

  test('rejects a bad name', () => {
    assert.throws(() => scaffoldSkill(join(box.root, 'skills-test'), 'Bad Name', 'x'), /kebab-case/);
  });

  test('testSkill reports phrases that fail to select', () => {
    const root = join(box.root, 'skills-test');
    const r = testSkill(root, 'deploy-site', ['deploy the site', 'make me a sandwich']);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /make me a sandwich/);
  });
});

describe('agents', () => {
  test('markdown frontmatter becomes config, body becomes persona', () => {
    const file = join(box.root, 'dev.md');
    writeFileSync(file, `---\nname: dev\ndescription: writes code\ntaskClass: coding\ndefaultFor: [imessage, dashboard]\n---\nBe terse.\n`);
    const { agent } = parseAgentFile(file);
    assert.equal(agent.name, 'dev');
    assert.equal(agent.taskClass, 'coding');
    assert.deepEqual(agent.defaultFor, ['imessage', 'dashboard']);
    assert.equal(agent.persona, 'Be terse.');
  });

  test('two agents cannot both own a channel', () => {
    const v = validateAgents(
      [
        { name: 'a', defaultFor: ['imessage'] },
        { name: 'b', defaultFor: ['imessage'] },
      ],
      box.cfg,
    );
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /both claim to be default/);
  });

  test('surface voice differs per channel but is never empty for chat channels', () => {
    assert.match(surfaceVoice('imessage'), /text message/);
    assert.match(surfaceVoice('dashboard'), /Markdown/);
  });
});

describe('channel allowlist', () => {
  test('phone numbers normalise across formats', () => {
    assert.equal(normalizeHandle('+1 (555) 010-9999'), normalizeHandle('5550109999'));
    assert.equal(normalizeHandle('Me@Example.com'), 'me@example.com');
  });

  test('an empty allowlist accepts nobody', () => {
    assert.equal(allowlisted([], '+15550109999'), false);
    assert.equal(allowlisted(['+1-555-010-9999'], '5550109999'), true);
  });
});

describe('failure classification', () => {
  test('recognises the failures that halt everything', () => {
    assert.equal(classify('Your credit balance is too low'), 'credit_exhausted');
    assert.equal(classify('authentication_error: invalid api key'), 'auth_expired');
    assert.equal(classify('429 too many requests'), 'rate_limited');
  });

  test('a killed run is not reported as a crash', () => {
    const d = diagnose({ status: 'killed', error: 'stuck: no output for 300s', exitCode: 143 } as never);
    assert.equal(d.kind, 'stuck');
    assert.equal(d.halt, false);
  });

  test('credit exhaustion halts the daemon', () => {
    const d = diagnose({ status: 'failed', exitCode: 1, error: '' } as never, 'Credit balance is too low.', '');
    assert.equal(d.halt, true);
    assert.equal(d.retryable, false);
  });
});

describe('execution profiles', () => {
  test('assistant runs get tighter caps than coding runs', () => {
    const coding = effectiveCaps(box.cfg, 'coding');
    const assistant = effectiveCaps(box.cfg, 'assistant');
    assert.ok(assistant.maxCostUsd < coding.maxCostUsd);
    assert.ok(assistant.maxTurns < coding.maxTurns);
  });
});
