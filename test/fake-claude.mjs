#!/usr/bin/env node
/**
 * A stand-in for `claude -p` that speaks the same stream-json protocol.
 *
 * Integration tests point `claudeBin` at this file. Behaviour is driven by the
 * prompt text so a test can ask for a specific shape of run:
 *
 *   "SCENARIO:tool"     emit a tool_use (exercises the PreToolUse gate)
 *   "SCENARIO:write"    actually write a file into cwd (exercises git/diff)
 *   "SCENARIO:hang"     produce nothing and wait (exercises the stuck sweeper)
 *   "SCENARIO:fail"     exit non-zero (exercises failure classification)
 *   "SCENARIO:expensive" report a huge cost (exercises the cost cap)
 *   "SCENARIO:turns=N"  emit N assistant turns
 *   anything else       one turn of text, then a successful result
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const sessionId = process.env.FAKE_SESSION_ID ?? '00000000-0000-4000-8000-000000000001';
const interactive = argv.includes('--input-format');

const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function promptFrom() {
  // Non-interactive: the prompt is the last bare argument.
  const bare = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  return bare[bare.length - 1] ?? '';
}

let prompt = interactive ? '' : promptFrom();

async function readFirstInteractivePrompt() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      try {
        const msg = JSON.parse(line);
        resolve(msg.message?.content?.[0]?.text ?? '');
      } catch {
        resolve('');
      }
    });
    // Guard against a test that never writes anything.
    setTimeout(() => resolve(''), 3000);
  });
}

async function main() {
  say({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'fake-model',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
  });

  if (interactive) prompt = await readFirstInteractivePrompt();

  if (prompt.includes('SCENARIO:hang')) {
    await sleep(600_000);
    return;
  }

  if (prompt.includes('SCENARIO:tool')) {
    say({
      type: 'assistant',
      session_id: sessionId,
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'git push origin main' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    say({
      type: 'user',
      session_id: sessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'blocked', is_error: true }] },
    });
  }

  if (prompt.includes('SCENARIO:write')) {
    writeFileSync(join(process.cwd(), 'fake-output.txt'), `written by fake claude at ${new Date().toISOString()}\n`);
    say({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: join(process.cwd(), 'fake-output.txt') } }] },
    });
  }

  const turnsMatch = /SCENARIO:turns=(\d+)/.exec(prompt);
  const turns = turnsMatch ? Number(turnsMatch[1]) : 1;
  for (let i = 0; i < turns; i++) {
    say({
      type: 'assistant',
      session_id: sessionId,
      message: {
        content: [{ type: 'text', text: `turn ${i + 1} for: ${prompt.slice(0, 60)}` }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    await sleep(10);
  }

  if (prompt.includes('SCENARIO:fail')) {
    process.stderr.write('Credit balance is too low to continue.\n');
    say({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: turns, total_cost_usd: 0.01, result: '' });
    process.exit(1);
  }

  say({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 120,
    num_turns: turns,
    total_cost_usd: prompt.includes('SCENARIO:expensive') ? 999 : 0.0123,
    result: `done: ${prompt.slice(0, 80)}`,
    usage: { input_tokens: 100 * turns, output_tokens: 50 * turns },
  });
  process.exit(0);
}

main();
