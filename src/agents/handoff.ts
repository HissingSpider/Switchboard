import type { RunRegistry } from '../runner/registry.js';
import type { RunStore, RunRecord } from '../store/runs.js';
import type { EventLog } from '../store/eventlog.js';

export interface HandoffRequest {
  fromRunId: string;
  toAgent: string;
  prompt: string;
  project?: string;
  timeoutMs?: number;
}

export interface HandoffResult {
  runId: string;
  status: RunRecord['status'];
  result: string | null;
  costUsd: number;
}

/**
 * One agent delegating a subtask to another. The child is a first-class run —
 * its own id, branch, caps and audit trail — linked back by parent_run_id, so a
 * handoff never hides work from the dashboard or the budget.
 */
export async function handoff(
  registry: RunRegistry,
  runs: RunStore,
  events: EventLog,
  req: HandoffRequest,
): Promise<HandoffResult> {
  const parent = runs.get(req.fromRunId);
  const child = registry.submit({
    prompt: req.prompt,
    agent: req.toAgent,
    project: req.project ?? parent?.project ?? undefined,
    intent: 'task',
    channel: parent?.channel ?? 'dashboard',
    parentRunId: req.fromRunId,
  });

  events.append({
    runId: req.fromRunId,
    kind: 'run.progress',
    source: 'runner',
    summary: `${req.fromRunId} handed off to ${req.toAgent} as ${child.id}`,
    data: { childRunId: child.id, toAgent: req.toAgent, prompt: req.prompt },
  });

  const finished = await waitForRun(registry, child.id, req.timeoutMs ?? 30 * 60_000);
  return {
    runId: child.id,
    status: finished?.status ?? 'failed',
    result: finished?.result ?? null,
    costUsd: finished?.costUsd ?? 0,
  };
}

export function waitForRun(registry: RunRegistry, runId: string, timeoutMs: number): Promise<RunRecord | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      registry.off('finished', onFinish);
      resolve(undefined);
    }, timeoutMs);
    const onFinish = (rec: RunRecord): void => {
      if (rec.id !== runId) return;
      clearTimeout(timer);
      registry.off('finished', onFinish);
      resolve(rec);
    };
    registry.on('finished', onFinish);
  });
}

/** Child runs of a run, for the dashboard's tree view. */
export function children(runs: RunStore, runId: string): RunRecord[] {
  return runs.list({ limit: 200 }).filter((r) => r.parentRunId === runId);
}
