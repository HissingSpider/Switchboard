#!/usr/bin/env node
/**
 * Collect everything the brief needs, in one read of the event log.
 * Deterministic work belongs here so the model only has to write prose.
 *
 *   node collect.mjs [--hours 16]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const hours = Number(args[args.indexOf('--hours') + 1]) || 16;
const dataDir = process.env.SWB_DATA_DIR || join(homedir(), '.switchboard');
const db = new DatabaseSync(join(dataDir, 'switchboard.db'), { readOnly: true });

const since = new Date(Date.now() - hours * 3600_000).toISOString();

const runs = db
  .prepare(
    `SELECT id, status, project, agent, cost_usd AS costUsd, prompt, result, error, branch, created_at AS createdAt
     FROM runs WHERE created_at >= ? ORDER BY created_at ASC`,
  )
  .all(since);

const pending = db.prepare(`SELECT id, run_id AS runId, tool, detail FROM confirmations WHERE status = 'pending'`).all();

const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
const { spend } = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM runs WHERE created_at >= ?`).get(monthStart);

const errors = db
  .prepare(`SELECT run_id AS runId, summary FROM events WHERE kind = 'system.error' AND ts >= ? ORDER BY id DESC LIMIT 10`)
  .all(since);

console.log(
  JSON.stringify(
    {
      since,
      counts: {
        total: runs.length,
        done: runs.filter((r) => r.status === 'done').length,
        failed: runs.filter((r) => r.status === 'failed').length,
        killed: runs.filter((r) => r.status === 'killed').length,
      },
      runs,
      pendingConfirmations: pending,
      errors,
      spendThisMonthUsd: Number(spend.toFixed(4)),
    },
    null,
    2,
  ),
);
db.close();
