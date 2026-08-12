import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LoadedConfig } from '../config/load.js';
import { profileFor } from '../config/load.js';
import { logger } from '../core/logger.js';
import { authorize, isLoopback } from './auth.js';
import { HOOK_PATH } from '../runner/hook.js';
import { decide } from '../policy/policy.js';
import { argLine } from '../policy/match.js';
import type { RunRegistry } from '../runner/registry.js';
import type { RunStore } from '../store/runs.js';
import type { EventLog } from '../store/eventlog.js';
import type { ArtifactStore } from '../store/artifacts.js';
import type { SessionStore } from '../store/sessions.js';
import type { ConfirmService } from '../policy/confirm.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { SkillRegistry } from '../skills/loader.js';
import type { ImessageAdapter } from '../adapters/imessage.js';
import type { MessagePipeline } from '../router/pipeline.js';
import type { Scheduler } from '../scheduler/heartbeat.js';
import { children } from '../agents/handoff.js';
import type { VoiceServer } from '../voice/transport.js';
import { VOICE_PATH } from '../voice/transport.js';

const log = logger('gateway');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface GatewayDeps {
  cfg: LoadedConfig;
  events: EventLog;
  runs: RunStore;
  sessions: SessionStore;
  artifacts: ArtifactStore;
  registry: RunRegistry;
  confirms: ConfirmService;
  agents: AgentRegistry;
  skills: SkillRegistry;
  pipeline: MessagePipeline;
  imessage?: ImessageAdapter;
  scheduler?: Scheduler;
  voice?: VoiceServer;
  token: string;
  hookToken: string;
}

/**
 * One HTTP server for everything: the dashboard, its SSE/WS event stream, the
 * PreToolUse gate, the BlueBubbles webhook and the trigger endpoints.
 *
 * Bound to 127.0.0.1 by default. Reaching it from a phone is Tailscale's job,
 * not ours — but the token check applies to every non-loopback request either
 * way, and the Host header is checked to stop DNS rebinding.
 */
export class Gateway {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  /** Separate server for /voice: those sockets carry audio, not the event log. */
  private voiceWss: WebSocketServer | null = null;
  private readonly staticRoot: string;

  constructor(private readonly d: GatewayDeps) {
    this.staticRoot = fileURLToPath(new URL('../../public', import.meta.url));
  }

  async start(): Promise<void> {
    const { cfg } = this.d;
    this.server = createServer((req, res) => void this.route(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.voiceWss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      const auth = authorize(req, {
        token: this.d.token,
        trustedHosts: cfg.gateway.trustedHosts ?? [],
        allowLoopbackWithoutToken: true,
      });
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      // Voice gets its own socket handler: binary frames there are audio, not
      // event-log JSON, and the two must never share a connection.
      if (path === VOICE_PATH) {
        if (!this.d.voice?.enabled) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        this.voiceWss!.handleUpgrade(req, socket, head, (ws) => this.d.voice!.handleConnection(ws, req));
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });

    // Fan the event log out to every connected socket.
    this.d.events.subscribe((ev) => {
      const payload = JSON.stringify({ type: 'event', event: ev });
      for (const client of this.wss?.clients ?? []) {
        if (client.readyState === 1) client.send(payload);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(cfg.gateway.port, cfg.gateway.host, () => resolve());
    });
    log.info('gateway listening', { url: `http://${cfg.gateway.host}:${cfg.gateway.port}` });
  }

  /** The port actually bound — differs from config when the port is 0. */
  get port(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.d.cfg.gateway.port;
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    for (const c of this.voiceWss?.clients ?? []) c.terminate();
    this.wss?.close();
    this.voiceWss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const runId = url.searchParams.get('run') ?? undefined;
    const backlog = this.d.events.tail(200, runId);
    ws.send(JSON.stringify({ type: 'backlog', events: backlog }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; [k: string]: unknown };
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // The hook has its own token and must work before anything else.
      if (path === HOOK_PATH && req.method === 'POST') return await this.handleHook(req, res);

      // BlueBubbles posts here with its own shared password; it is not a dashboard client.
      if (path === (this.d.cfg.imessage.webhookPath ?? '/hooks/bluebubbles') && req.method === 'POST') {
        return await this.handleBlueBubbles(req, res);
      }
      if (path.startsWith('/hooks/trigger/') && req.method === 'POST') return await this.handleTrigger(req, res, path);

      const auth = authorize(req, {
        token: this.d.token,
        trustedHosts: this.d.cfg.gateway.trustedHosts ?? [],
        allowLoopbackWithoutToken: true,
      });
      if (!auth.ok) return json(res, auth.status, { error: auth.message });

      if (path.startsWith('/api/')) return await this.api(req, res, url);
      if (path === '/events') return this.sse(req, res, url);
      return this.static(res, path);
    } catch (err) {
      log.error('request failed', { path, err: (err as Error).message });
      json(res, 500, { error: (err as Error).message });
    }
  }

  // ---------------------------------------------------------------- API

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { runs, events, registry, artifacts, confirms, agents, skills, cfg } = this.d;
    const p = url.pathname.replace(/^\/api/, '');
    const method = req.method ?? 'GET';

    if (p === '/status') {
      return json(res, 200, {
        ...registry.status(),
        projects: cfg.projects.map((x) => x.name),
        agents: agents.all().map((a) => a.name),
        skills: skills.all().length,
        pendingConfirmations: confirms.pending().length,
        version: '0.1.0',
      });
    }

    if (p === '/runs' && method === 'GET') {
      return json(res, 200, {
        runs: runs.list({
          limit: Number(url.searchParams.get('limit') ?? 50),
          status: (url.searchParams.get('status') as never) ?? undefined,
          project: url.searchParams.get('project') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          before: url.searchParams.get('before') ?? undefined,
        }),
      });
    }

    if (p === '/runs' && method === 'POST') {
      const body = (await readJson(req)) as {
        prompt?: string;
        project?: string;
        agent?: string;
        taskClass?: never;
        intent?: never;
        threadId?: string;
      };
      if (!body.prompt) return json(res, 400, { error: 'prompt is required' });
      const run = registry.submit({
        prompt: body.prompt,
        project: body.project,
        agent: body.agent,
        taskClass: body.taskClass,
        intent: body.intent ?? 'task',
        channel: 'dashboard',
        threadId: body.threadId ?? 'dashboard',
      });
      return json(res, 201, { run });
    }

    const runMatch = /^\/runs\/([^/]+)(\/.*)?$/.exec(p);
    if (runMatch) {
      const rec = runs.resolve(runMatch[1]!);
      if (!rec) return json(res, 404, { error: 'no such run' });
      const sub = runMatch[2] ?? '';

      if (sub === '' && method === 'GET') {
        return json(res, 200, { run: rec, children: children(runs, rec.id), artifacts: artifacts.list(rec.id).map((a) => ({ name: a.name, bytes: a.bytes })) });
      }
      if (sub === '' && method === 'DELETE') {
        return json(res, 200, { killed: registry.kill(rec.id, 'killed from dashboard') });
      }
      if (sub === '/events') {
        return json(res, 200, { events: events.replay({ runId: rec.id, sinceId: Number(url.searchParams.get('since') ?? 0), limit: 2000 }) });
      }
      if (sub === '/diff') {
        const diff = artifacts.read(rec.id, 'changes.diff') ?? '';
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(diff);
      }
      if (sub === '/transcript') {
        const t = artifacts.read(rec.id, 'transcript.jsonl') ?? '';
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return void res.end(t);
      }
      if (sub === '/followup' && method === 'POST') {
        const body = (await readJson(req)) as { text?: string };
        if (!body.text) return json(res, 400, { error: 'text is required' });
        return json(res, 200, { delivered: registry.followUp(rec.id, body.text) });
      }
    }

    if (p === '/events') {
      return json(res, 200, {
        events: events.replay({
          sinceId: Number(url.searchParams.get('since') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 200),
          search: url.searchParams.get('q') ?? undefined,
        }),
      });
    }

    if (p === '/confirmations' && method === 'GET') {
      return json(res, 200, { pending: confirms.pending(), audit: confirms.audit(100) });
    }
    const confMatch = /^\/confirmations\/([^/]+)$/.exec(p);
    if (confMatch && method === 'POST') {
      const body = (await readJson(req)) as { approve?: boolean };
      const updated = confirms.answer(confMatch[1]!, Boolean(body.approve), 'dashboard');
      return updated ? json(res, 200, { confirmation: updated }) : json(res, 404, { error: 'no such pending confirmation' });
    }

    if (p === '/projects') {
      return json(res, 200, { projects: cfg.projects.map((x) => ({ ...x, exists: existsSync(x.path) })) });
    }
    if (p === '/agents') {
      return json(res, 200, { agents: agents.all(), problems: agents.lastProblems });
    }
    if (p === '/agents/reload' && method === 'POST') {
      return json(res, 200, agents.reload());
    }
    if (p === '/skills') {
      return json(res, 200, { skills: skills.all().map((s) => ({ name: s.name, description: s.description, scripts: s.scripts.length })), problems: skills.validate() });
    }
    if (p === '/cost') {
      const since = url.searchParams.get('since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
      return json(res, 200, {
        monthSpendUsd: runs.monthSpend(),
        monthBudgetUsd: cfg.caps.monthlyBudgetUsd,
        byProject: runs.spendByProject(since),
      });
    }
    if (p === '/voice') {
      return json(res, 200, { ...(this.d.voice?.status() ?? { enabled: false }), latency: this.d.voice?.latency() ?? [] });
    }

    if (p === '/schedules') {
      return json(res, 200, { jobs: this.d.scheduler?.list() ?? [] });
    }

    // The DeerDawn board is owned by DeerDawn, not by us. A heartbeat run
    // refreshes this file; the dashboard just renders whatever is there.
    if (p === '/board') {
      const file = join(cfg.resolved.dataDir, 'deerdawn-board.json');
      if (!existsSync(file)) {
        return json(res, 200, { board: null, hint: 'no board snapshot yet — add a heartbeat that writes deerdawn-board.json' });
      }
      try {
        return json(res, 200, { board: JSON.parse(readFileSync(file, 'utf8')) as unknown, updatedAt: statSync(file).mtime.toISOString() });
      } catch (err) {
        return json(res, 200, { board: null, hint: `snapshot unreadable: ${(err as Error).message}` });
      }
    }

    return json(res, 404, { error: `no route ${p}` });
  }

  // ------------------------------------------------------------- PreToolUse

  /**
   * The gate. Claude blocks here before every tool call. Allow is cheap; confirm
   * parks the request until a human answers on whatever channel started the run.
   */
  private async handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (provided !== this.d.hookToken || !isLoopback(req)) {
      return json(res, 401, { decision: 'deny', reason: 'unauthorized hook caller' });
    }

    const body = (await readJson(req)) as { runId?: string; tool?: string; input?: Record<string, unknown> };
    const runId = body.runId ?? '';
    const tool = body.tool ?? 'unknown';
    const input = body.input ?? {};
    const active = this.d.registry.getActive(runId);
    const rec = this.d.runs.get(runId);
    if (!rec) return json(res, 200, { decision: 'deny', reason: 'unknown run' });

    const profile = profileFor(this.d.cfg, active?.permissionProfile);
    const call = { tool, input };
    const verdict = decide(call, {
      profile,
      workdir: active?.workdir ?? rec.projectPath ?? undefined,
      extraWritable: [this.d.cfg.resolved.scratchDir, this.d.cfg.resolved.artifactsDir],
    });

    this.d.events.append({
      runId,
      kind: 'action.gated',
      source: 'policy',
      summary: `${verdict.tier} ${tool}: ${truncate(argLine(call), 140)} (${verdict.reason})`,
      data: { tool, input, tier: verdict.tier, rule: verdict.rule, reason: verdict.reason },
    });

    if (verdict.tier === 'allow') return json(res, 200, { decision: 'allow', reason: verdict.reason });
    if (verdict.tier === 'deny') return json(res, 200, { decision: 'deny', reason: verdict.reason });

    const outcome = await this.d.confirms.request({
      runId,
      tool,
      detail: argLine(call),
      tier: verdict.tier,
      channel: rec.channel,
    });
    // Timeout defaults to abort — silence is never consent.
    return json(res, 200, {
      decision: outcome.status === 'approved' ? 'allow' : 'deny',
      reason: outcome.status === 'approved' ? `approved by owner (${outcome.id})` : `not approved (${outcome.status})`,
    });
  }

  // --------------------------------------------------------------- webhooks

  private async handleBlueBubbles(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.d.imessage?.enabled) return json(res, 503, { error: 'imessage adapter disabled' });
    const body = await readJson(req);
    const result = await this.d.imessage.handleWebhook(body);
    return json(res, 200, result);
  }

  private async handleTrigger(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (provided !== this.d.token) return json(res, 401, { error: 'unauthorized' });
    const name = path.replace('/hooks/trigger/', '');
    const body = (await readJson(req)) as Record<string, unknown>;
    const fired = this.d.scheduler?.fireWebhook(name, body) ?? false;
    return json(res, fired ? 202 : 404, { fired });
  }

  // -------------------------------------------------------------------- SSE

  private sse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const runId = url.searchParams.get('run') ?? undefined;
    const since = Number(url.searchParams.get('since') ?? 0);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    for (const ev of this.d.events.replay({ runId, sinceId: since, limit: 300 })) {
      res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const unsub = this.d.events.subscribe((ev) => {
      res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    }, runId);

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsub();
    });
  }

  // ----------------------------------------------------------------- static

  private static(res: ServerResponse, path: string): void {
    const rel = path === '/' ? '/index.html' : path;
    // normalize() first so `..` can't escape the public dir.
    const file = join(this.staticRoot, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(this.staticRoot) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
