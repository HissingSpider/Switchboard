import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LoadedConfig } from '../config/load.js';
import { profileFor } from '../config/load.js';
import { logger } from '../core/logger.js';
import { authorize, isLoopback, bearerFrom, deviceCookie, isSecureRequest, cookieFrom, DEVICE_COOKIE } from './auth.js';
import { HOOK_PATH } from '../runner/hook.js';
import { decide } from '../policy/policy.js';
import { applySandbox, type SandboxContext } from '../skills/sandbox.js';
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
import type { DeviceStore } from './devices.js';
import type { PushService } from './push.js';
import type { SkillStore } from '../store/skills.js';
import { considerPromotion, grantTrusted, proposeTrusted } from '../skills/trust.js';
import { checkReachability, serveCommand } from '../net/reachability.js';
import type { InvestigationService } from '../investigate/loop.js';
import type { EntityRegistry } from '../investigate/entities.js';
import type { Vault } from '../vault/vault.js';
import type { QueueWorker } from '../queue/worker.js';
import { runChecks, healthFor, formatReport } from '../investigate/health.js';

const log = logger('gateway');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
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
  devices: DeviceStore;
  push: PushService;
  skillStore: SkillStore;
  investigations: InvestigationService;
  entities: EntityRegistry;
  vault: Vault;
  queue: QueueWorker;
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
      // No response object on an upgrade, so no cookie can be issued here — a
      // socket client has already been through an HTTP request to get one.
      const auth = this.authorizeRequest(req);
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

  /**
   * A device token is as good as the shared token. Loopback gets in without
   * either — that is the machine the daemon runs on.
   *
   * The exception that matters: a request that *presents* a credential is judged
   * on that credential alone, even from loopback. Under `tailscale serve` every
   * proxied request arrives from 127.0.0.1, so falling back to loopback trust
   * would let a revoked phone straight back in.
   */
  private authorizeRequest(req: IncomingMessage, res?: ServerResponse): { ok: true; device?: string } | { ok: false; status: number; message: string } {
    // `bearerFrom` also reads ?token=, because EventSource cannot set headers.
    const presented = bearerFrom(req);
    const base = authorize(req, {
      token: this.d.token,
      trustedHosts: this.d.cfg.gateway.trustedHosts ?? [],
      allowLoopbackWithoutToken: !presented,
    });
    if (base.ok) return { ok: true };
    // The Host check is not something a device token can override.
    if (base.status === 403) return base;
    const device = presented ? this.d.devices.authenticate(presented) : undefined;
    if (device) {
      // A device that authenticated with a bearer token but has no cookie yet
      // gets one now. Without it the device can call the API but can never load
      // a page, because a navigation carries no Authorization header.
      if (res && !cookieFrom(req, DEVICE_COOKIE) && !res.headersSent) {
        res.setHeader('set-cookie', deviceCookie(presented!, isSecureRequest(req)));
      }
      return { ok: true, device: device.id };
    }
    return { ok: false, status: 401, message: presented ? 'that token is not valid' : base.message };
  }

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const runId = url.searchParams.get('run') ?? undefined;
    const since = Number(url.searchParams.get('since') ?? 0);

    // A client that was offline reconnects with the last id it saw and gets
    // exactly what it missed. Without this a dropped connection silently loses
    // events, and the dashboard shows a run that never appears to finish.
    const backlog = since > 0 ? this.d.events.replay({ runId, sinceId: since, limit: 2000 }) : this.d.events.tail(200, runId);
    ws.send(JSON.stringify({ type: 'backlog', events: backlog, resumed: since > 0, lastId: this.d.events.lastId() }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; since?: number; run?: string };
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', lastId: this.d.events.lastId() }));
        } else if (msg.type === 'resume') {
          const missed = this.d.events.replay({ runId: msg.run ?? runId, sinceId: Number(msg.since ?? 0), limit: 2000 });
          ws.send(JSON.stringify({ type: 'backlog', events: missed, resumed: true, lastId: this.d.events.lastId() }));
        }
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

      // The bootstrap surface. A brand-new phone has no token yet, so the
      // pairing page and the claim endpoint have to be reachable without one —
      // otherwise pairing is impossible over the tailnet. Nothing here leaks:
      // the page is a static form, and claiming still requires a code that is
      // single-use, expires in five minutes, and is only ever shown on a screen
      // that is already trusted.
      if (isBootstrapPath(path, req.method ?? 'GET')) {
        if (path === '/api/devices/claim') return await this.api(req, res, url);
        return this.static(res, path);
      }

      const auth = this.authorizeRequest(req, res);
      if (!auth.ok) {
        // A browser asking for a page, with no credential, is an unpaired
        // device — send it somewhere it can do something about that instead of
        // showing it a JSON error.
        if (auth.status === 401 && wantsHtml(req) && !path.startsWith('/api/')) {
          res.writeHead(302, { location: '/pair.html' });
          return void res.end();
        }
        return json(res, auth.status, { error: auth.message });
      }

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
    // ---------------------------------------------------------- devices
    if (p === '/devices' && method === 'GET') {
      return json(res, 200, { devices: this.d.devices.list(true), pending: this.d.devices.pendingPairings() });
    }
    if (p === '/devices/pair' && method === 'POST') {
      // Only a client that is already trusted may mint a pairing code.
      return json(res, 201, this.d.devices.createPairingCode());
    }
    if (p === '/devices/claim' && method === 'POST') {
      const body = (await readJson(req)) as { code?: string; name?: string };
      if (!body.code) return json(res, 400, { error: 'code is required' });
      const result = this.d.devices.claim(body.code, body.name ?? 'phone', String(req.headers['user-agent'] ?? ''));
      if ('error' in result) return json(res, 400, result);
      // The cookie is what lets the browser load the dashboard at all; the
      // token in the body is for native clients and the websocket.
      res.setHeader('set-cookie', deviceCookie(result.token, isSecureRequest(req)));
      this.d.events.append({
        runId: null,
        kind: 'system.start',
        source: 'gateway',
        summary: `paired device "${result.device.name}" (${result.device.id})`,
        data: { deviceId: result.device.id },
      });
      return json(res, 201, result);
    }
    const deviceMatch = /^\/devices\/([^/]+)$/.exec(p);
    if (deviceMatch && method === 'DELETE') {
      return json(res, 200, { revoked: this.d.devices.revoke(deviceMatch[1]!) });
    }

    // ------------------------------------------------------------- push
    if (p === '/push/key') {
      return json(res, 200, { publicKey: this.d.push.publicKey });
    }
    if (p === '/push/subscribe' && method === 'POST') {
      const body = (await readJson(req)) as { endpoint?: string; keys?: { p256dh: string; auth: string }; deviceId?: string };
      if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) return json(res, 400, { error: 'endpoint and keys are required' });
      const sub = this.d.push.subscribe({ endpoint: body.endpoint, keys: body.keys, deviceId: body.deviceId ?? null });
      return json(res, 201, { subscription: { id: sub.id, createdAt: sub.createdAt } });
    }
    if (p === '/push/unsubscribe' && method === 'POST') {
      const body = (await readJson(req)) as { endpoint?: string };
      return json(res, 200, { removed: body.endpoint ? this.d.push.unsubscribe(body.endpoint) : false });
    }
    if (p === '/push/test' && method === 'POST') {
      const result = await this.d.push.send({ title: 'Switchboard', body: 'Push is working.', tag: 'test' });
      return json(res, 200, result);
    }
    if (p === '/push' && method === 'GET') {
      return json(res, 200, { subscriptions: this.d.push.list().map((sub) => ({ id: sub.id, deviceId: sub.deviceId, createdAt: sub.createdAt, lastOkAt: sub.lastOkAt, failures: sub.failures, host: safeHost(sub.endpoint) })) });
    }

    // ----------------------------------------------------------- skills
    if (p === '/skills/review') {
      const queue = this.d.skillStore.reviewQueue().map((skill) => ({
        ...skill,
        successRate: this.d.skillStore.successRate(skill.name),
        proposal: skill.trust === 'restricted' ? proposeTrusted(skill) : undefined,
      }));
      return json(res, 200, { queue, stale: this.d.skillStore.stale() });
    }
    const skillMatch = /^\/skills\/([^/]+)(\/.*)?$/.exec(p);
    if (skillMatch && skillMatch[1] !== 'review') {
      const name = skillMatch[1]!;
      const sub = skillMatch[2] ?? '';
      const record = this.d.skillStore.get(name);
      if (!record) return json(res, 404, { error: 'no such skill' });

      if (sub === '' && method === 'GET') {
        return json(res, 200, {
          skill: record,
          successRate: this.d.skillStore.successRate(name),
          history: this.d.skillStore.history(name),
          uses: this.d.skillStore.recentUses(name),
          body: skills.get(name)?.body,
        });
      }
      if (sub === '/trust' && method === 'POST') {
        const body = (await readJson(req)) as { trust?: string };
        if (body.trust === 'trusted') {
          const updated = grantTrusted(this.d.skillStore, name, 'owner (dashboard)');
          return json(res, 200, { skill: updated });
        }
        if (body.trust === 'sandboxed' || body.trust === 'restricted') {
          return json(res, 200, { skill: this.d.skillStore.setTrust(name, body.trust, 'owner (dashboard)') });
        }
        return json(res, 400, { error: 'trust must be sandboxed, restricted or trusted' });
      }
      if (sub === '/promote' && method === 'POST') {
        return json(res, 200, considerPromotion(this.d.skillStore, name));
      }
      if (sub === '/retire' && method === 'POST') {
        const body = (await readJson(req)) as { reason?: string };
        this.d.skillStore.retire(name, body.reason ?? 'retired from the dashboard');
        return json(res, 200, { retired: true });
      }
      if (sub === '/restore' && method === 'POST') {
        this.d.skillStore.restore(name);
        return json(res, 200, { restored: true });
      }
      if (sub === '/unflag' && method === 'POST') {
        this.d.skillStore.unflag(name);
        return json(res, 200, { unflagged: true });
      }
    }

    // --------------------------------------------------- investigations
    if (p === '/investigations' && method === 'GET') {
      return json(res, 200, { investigations: this.d.investigations.list(Number(url.searchParams.get('limit') ?? 25)) });
    }
    if (p === '/investigations' && method === 'POST') {
      const body = (await readJson(req)) as { question?: string; project?: string; originCheck?: string };
      if (!body.question) return json(res, 400, { error: 'question is required' });
      const inv = this.d.investigations.start({
        question: body.question,
        project: body.project,
        channel: 'dashboard',
        threadId: 'dashboard',
        originCheck: body.originCheck,
      });
      return json(res, 201, { investigation: inv });
    }
    const invMatch = /^\/investigations\/([^/]+)(\/.*)?$/.exec(p);
    if (invMatch) {
      const inv = this.d.investigations.get(invMatch[1]!);
      if (!inv) return json(res, 404, { error: 'no such investigation' });
      const sub = invMatch[2] ?? '';
      if (sub === '' && method === 'GET') {
        return json(res, 200, { investigation: inv, findings: this.d.investigations.findings(inv.id) });
      }
      if (sub === '/fix' && method === 'POST') {
        const run = await this.d.investigations.proposeFix(inv.id, { channel: 'dashboard', threadId: 'dashboard' });
        return run ? json(res, 201, { run }) : json(res, 409, { error: 'only an answered investigation can be turned into a fix' });
      }
    }

    // -------------------------------------------------------- health
    if (p === '/health' && method === 'GET') {
      return json(res, 200, { manifests: cfg.health });
    }
    const healthMatch = /^\/health\/([^/]+)$/.exec(p);
    if (healthMatch && method === 'POST') {
      const manifest = healthFor(cfg, healthMatch[1]!);
      if (!manifest) return json(res, 404, { error: 'no health manifest for that project' });
      const report = await runChecks(manifest);
      return json(res, 200, { report, text: formatReport(report) });
    }

    // -------------------------------------------------------- entities
    if (p === '/entities') {
      return json(res, 200, { entities: this.d.entities.all(), gaps: this.d.entities.gaps(), path: this.d.entities.path });
    }
    if (p === '/entities/reload' && method === 'POST') {
      return json(res, 200, { count: this.d.entities.reload() });
    }

    // ----------------------------------------------------------- vault
    if (p === '/vault') {
      return json(res, 200, { enabled: this.d.vault.enabled, problems: this.d.vault.problems, notes: this.d.vault.ours().slice(0, 200) });
    }
    if (p === '/vault/note' && method === 'GET') {
      const ref = url.searchParams.get('ref');
      if (!ref) return json(res, 400, { error: 'ref is required' });
      try {
        const note = this.d.vault.read(ref);
        return note ? json(res, 200, { note }) : json(res, 404, { error: 'no such note' });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    // ----------------------------------------------------------- queue
    if (p === '/queue' && method === 'GET') {
      return json(res, 200, this.d.queue.status());
    }
    if (p === '/queue/poll' && method === 'POST') {
      return json(res, 200, await this.d.queue.poll());
    }

    // ---------------------------------------------------- reachability
    if (p === '/reachability') {
      const report = await checkReachability(cfg.gateway);
      return json(res, 200, { ...report, serveCommand: serveCommand(cfg.gateway.port) });
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
    const workdir = active?.workdir ?? rec.projectPath ?? undefined;
    let verdict = decide(call, {
      profile,
      workdir,
      extraWritable: [this.d.cfg.resolved.scratchDir, this.d.cfg.resolved.artifactsDir],
    });

    // A run pinned to a skill is additionally confined to that skill's declared
    // capabilities. The manifest can only ever narrow the profile's answer.
    const sandbox = this.sandboxFor(rec.skill, workdir);
    verdict = applySandbox(verdict, call, sandbox);

    this.d.events.append({
      runId,
      kind: 'action.gated',
      source: 'policy',
      summary: `${verdict.tier} ${tool}: ${truncate(argLine(call), 140)} (${verdict.reason})`,
      data: { tool, input, tier: verdict.tier, rule: verdict.rule, reason: verdict.reason, skill: rec.skill ?? undefined },
    });

    if (verdict.tier === 'allow') return json(res, 200, { decision: 'allow', reason: verdict.reason });
    if (verdict.tier === 'deny') {
      // Investigation runs stop on the first denial rather than carrying on
      // without the tool: a diagnosis that quietly skipped the step it needed
      // is worse than one that stops and says what it wanted to do.
      if (profile.haltOnDeny) {
        this.d.registry.kill(runId, `halted: tried to ${tool} (${verdict.reason})`);
        return json(res, 200, {
          decision: 'deny',
          reason: `${verdict.reason}. This run is read-only and has been stopped — report what you would change instead.`,
        });
      }
      return json(res, 200, { decision: 'deny', reason: verdict.reason });
    }

    // A confirmation is the one thing worth waking someone for, so it goes out
    // as a push as well as through the usual notification rules.
    void this.d.push
      .sendApprovalRequest(`pending-${runId}`, runId, tool, argLine(call))
      .catch(() => undefined);

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

  /** Build the sandbox context for a skill-scoped run, if it is one. */
  private sandboxFor(skill: string | null, workdir: string | undefined): SandboxContext | undefined {
    if (!skill || !workdir) return undefined;
    const record = this.d.skillStore.get(skill);
    if (!record) return undefined;
    return {
      skill,
      manifest: record.manifest,
      workdir,
      skillDir: join(this.d.cfg.resolved.skillsDir, skill),
    };
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
    // EventSource resends the last id it saw as a header on reconnect. Honouring
    // it is the whole of offline replay for the dashboard: a phone that slept
    // through ten minutes of a run wakes up and gets exactly what it missed.
    const lastEventId = Number(req.headers['last-event-id'] ?? 0);
    const since = lastEventId || Number(url.searchParams.get('since') ?? 0);
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

const BOOTSTRAP_ASSETS = new Set(['/pair.html', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);

/** A top-level navigation, as opposed to a fetch or an API call. */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? '');
  return req.method === 'GET' && accept.includes('text/html');
}

function isBootstrapPath(path: string, method: string): boolean {
  if (path === '/api/devices/claim') return method === 'POST';
  return BOOTSTRAP_ASSETS.has(path);
}

/** Push endpoints are third-party URLs; show the host, never the token in the path. */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
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
