import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, HARD_DENY, isObviouslyReadOnly } from '../dist/policy/policy.js';
import { specMatches, argLine, parseSpec } from '../dist/policy/match.js';
import { parseConfirmReply } from '../dist/policy/confirm.js';
import { DEFAULT_PERMISSION_PROFILES } from '../dist/config/schema.js';

const coding = DEFAULT_PERMISSION_PROFILES.find((p) => p.name === 'coding')!;
const readonly = DEFAULT_PERMISSION_PROFILES.find((p) => p.name === 'readonly')!;

describe('spec matching', () => {
  test('bare tool names match any input', () => {
    assert.equal(specMatches('Bash', { tool: 'Bash', input: { command: 'ls' } }), true);
    assert.equal(specMatches('Bash', { tool: 'Read', input: {} }), false);
  });

  test('globs match the tool argument line', () => {
    assert.equal(specMatches('Bash(git *)', { tool: 'Bash', input: { command: 'git status' } }), true);
    assert.equal(specMatches('Bash(git *)', { tool: 'Bash', input: { command: 'rm -rf /' } }), false);
  });

  test('shell chaining cannot slip past a prefix rule', () => {
    assert.equal(specMatches('Bash(git push*)', { tool: 'Bash', input: { command: 'cd repo && git push origin main' } }), true);
  });

  test('MCP tool prefixes match with wildcards', () => {
    assert.equal(specMatches('mcp__*__send*', { tool: 'mcp__slack__send_message', input: {} }), true);
    assert.equal(specMatches('mcp__*__send*', { tool: 'mcp__slack__read_channel', input: {} }), false);
  });

  test('argLine picks the right field per tool', () => {
    assert.equal(argLine({ tool: 'Bash', input: { command: 'ls -la' } }), 'ls -la');
    assert.equal(argLine({ tool: 'Write', input: { file_path: '/tmp/x' } }), '/tmp/x');
    assert.equal(argLine({ tool: 'WebFetch', input: { url: 'https://x.dev' } }), 'https://x.dev');
  });

  test('parseSpec splits tool and argument', () => {
    assert.deepEqual(parseSpec('Bash(git *)'), { tool: 'Bash', arg: 'git *' });
    assert.deepEqual(parseSpec('Read'), { tool: 'Read' });
  });
});

describe('policy decisions', () => {
  test('hard denies beat any profile', () => {
    for (const h of HARD_DENY) {
      const verdict = decide({ tool: 'Bash', input: { command: 'sudo rm -rf /' } }, { profile: coding });
      assert.equal(verdict.tier, 'deny', `${h.spec} should not be reachable`);
      break;
    }
  });

  test('irreversible actions need a human even when the profile allows them', () => {
    const permissive = { ...coding, allow: ['Bash'], confirm: [], deny: [] };
    const verdict = decide({ tool: 'Bash', input: { command: 'git push origin main' } }, { profile: permissive });
    assert.equal(verdict.tier, 'confirm');
    assert.match(verdict.reason, /irreversible/);
  });

  test('writes outside the workdir are denied', () => {
    const verdict = decide({ tool: 'Write', input: { file_path: '/etc/hosts' } }, { profile: coding, workdir: '/tmp/project' });
    assert.equal(verdict.tier, 'deny');
    assert.equal(verdict.rule, 'write-scope');
  });

  test('writes inside the workdir are allowed', () => {
    const verdict = decide({ tool: 'Write', input: { file_path: '/tmp/project/src/a.ts' } }, { profile: coding, workdir: '/tmp/project' });
    assert.equal(verdict.tier, 'allow');
  });

  test('extraWritable opens up the scratch dir', () => {
    const verdict = decide(
      { tool: 'Write', input: { file_path: '/tmp/scratch/note.md' } },
      { profile: coding, workdir: '/tmp/project', extraWritable: ['/tmp/scratch'] },
    );
    assert.equal(verdict.tier, 'allow');
  });

  test('readonly profile denies writes outright', () => {
    assert.equal(decide({ tool: 'Write', input: { file_path: '/tmp/p/x' } }, { profile: readonly, workdir: '/tmp/p' }).tier, 'deny');
    assert.equal(decide({ tool: 'Read', input: { file_path: '/tmp/p/x' } }, { profile: readonly, workdir: '/tmp/p' }).tier, 'allow');
  });

  test('unmatched calls fall back to the profile default', () => {
    const verdict = decide({ tool: 'SomeUnknownTool', input: {} }, { profile: coding });
    assert.equal(verdict.tier, coding.fallback);
  });
});

describe('confirm replies', () => {
  test('accepts targeted approvals', () => {
    assert.deepEqual(parseConfirmReply('ok 3f9x'), { answer: 'approve', id: '3f9x' });
    assert.deepEqual(parseConfirmReply('no c-3f9x'), { answer: 'deny', id: '3f9x' });
  });

  test('accepts bare yes/no', () => {
    assert.deepEqual(parseConfirmReply('yes'), { answer: 'approve' });
    assert.deepEqual(parseConfirmReply('  STOP '), { answer: 'deny' });
  });

  test('ignores anything that is not an answer', () => {
    assert.equal(parseConfirmReply('fix the login bug'), undefined);
    assert.equal(parseConfirmReply('yes, but only the first part'), undefined);
  });
});

describe('read-only calls do not cost a confirmation', () => {
  const call = (tool: string, input: Record<string, unknown> = {}) => ({ tool, input });
  const assistant = DEFAULT_PERMISSION_PROFILES.find((p) => p.name === 'assistant')!;

  test('a schema lookup is allowed rather than queued for a human', () => {
    // The observed failure: `needs approval: ToolSearch — no rule matched`,
    // then a 600-second timer, for loading a tool definition.
    const d = decide(call('ToolSearch', { query: 'select:Read' }), { profile: assistant });
    assert.equal(d.tier, 'allow');
    assert.equal(d.rule, 'read-only');
  });

  test('MCP reads are recognised by their leading verb', () => {
    for (const name of ['mcp__dd__get_context', 'mcp__dd__list_projects', 'mcp__dd__search_context', 'mcp__dd__find_known_paths']) {
      assert.equal(decide(call(name), { profile: assistant }).tier, 'allow', name);
    }
  });

  test('a read verb on a mutating name is not a read', () => {
    // `search*` alone would let this through; the whole-name check is the point.
    assert.equal(isObviouslyReadOnly(call('mcp__x__search_and_replace')), false);
    assert.equal(isObviouslyReadOnly(call('mcp__x__list_and_delete')), false);
    assert.equal(isObviouslyReadOnly(call('mcp__x__get_or_create')), false);
  });

  test('matching is on words, not substrings', () => {
    // "get_settings" contains "set"; reading it as a mutation would gate every
    // settings read on the machine.
    assert.equal(isObviouslyReadOnly(call('mcp__x__get_settings')), true);
    assert.equal(isObviouslyReadOnly(call('mcp__x__getSettings')), true);
  });

  test('a name that does not advertise itself as a read stays gated', () => {
    // Honest limit: only the name is evidence, and this one says nothing.
    assert.equal(isObviouslyReadOnly(call('mcp__dd__start_session')), false);
    assert.equal(isObviouslyReadOnly(call('mcp__x__do_the_thing')), false);
  });

  test('a profile that closed itself is not widened', () => {
    // `fallback: deny` means no. A built-in must never turn that into yes.
    assert.equal(decide(call('mcp__dd__get_context'), { profile: readonly }).tier, 'deny');
    assert.equal(decide(call('ToolSearch'), { profile: readonly }).tier, 'deny');
  });

  test('an explicit deny still beats the read-only rule', () => {
    const strict = { ...coding, deny: [...coding.deny, 'ToolSearch'] };
    assert.equal(decide(call('ToolSearch'), { profile: strict }).tier, 'deny');
  });

  test('an explicit confirm still beats the read-only rule', () => {
    const cautious = { ...coding, confirm: [...coding.confirm, 'mcp__*__get*'] };
    assert.equal(decide(call('mcp__dd__get_context'), { profile: cautious }).tier, 'confirm');
  });

  test('an irreversible shape is never reclassified as a read', () => {
    assert.equal(isObviouslyReadOnly(call('mcp__x__send_email')), false);
    assert.equal(decide(call('mcp__x__send_email'), { profile: coding }).tier, 'confirm');
  });
});
