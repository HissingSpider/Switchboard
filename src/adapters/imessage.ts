import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ImessageConfig } from '../config/schema.js';
import { resolveRef } from '../secrets/keychain.js';
import { logger } from '../core/logger.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { allowlisted } from './types.js';

const log = logger('imessage');

/** The bits of a BlueBubbles `new-message` webhook we care about. */
interface BlueBubblesWebhook {
  type?: string;
  data?: {
    guid?: string;
    text?: string;
    isFromMe?: boolean;
    handle?: { address?: string };
    chats?: Array<{ guid?: string; chatIdentifier?: string }>;
    attachments?: Array<{ guid?: string; transferName?: string; mimeType?: string }>;
  };
}

/**
 * iMessage in and out via BlueBubbles: webhook in, REST out.
 *
 * BlueBubbles runs alongside us on the Mac Mini and owns the Messages.app
 * integration; we never touch AppleScript directly. Inbound is a webhook the
 * gateway routes here; outbound is a POST to the BlueBubbles REST API.
 */
export class ImessageAdapter implements ChannelAdapter {
  readonly name = 'imessage' as const;
  onMessage?: (msg: InboundMessage) => void | Promise<void>;

  constructor(
    private readonly cfg: ImessageConfig,
    private readonly attachmentDir: string,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private get password(): string {
    return resolveRef(this.cfg.passwordRef) ?? '';
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(path, this.cfg.serverUrl);
    u.searchParams.set('password', this.password);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    mkdirSync(this.attachmentDir, { recursive: true });
    const ok = await this.ping();
    log.info(ok ? 'BlueBubbles reachable' : 'BlueBubbles NOT reachable — outbound texts will fail', { server: this.cfg.serverUrl });
  }

  async stop(): Promise<void> {
    /* webhook-driven; nothing to tear down */
  }

  async ping(): Promise<boolean> {
    if (!this.cfg.serverUrl) return false;
    try {
      const res = await fetch(this.url('/api/v1/server/info'), { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Called by the gateway when the BlueBubbles webhook fires. */
  async handleWebhook(body: unknown): Promise<{ accepted: boolean; reason?: string }> {
    const payload = body as BlueBubblesWebhook;
    if (payload.type && payload.type !== 'new-message') return { accepted: false, reason: `ignoring ${payload.type}` };
    const data = payload.data;
    if (!data) return { accepted: false, reason: 'no data' };
    if (data.isFromMe) return { accepted: false, reason: 'own message' };

    const sender = data.handle?.address ?? '';
    if (!allowlisted(this.cfg.allowlist, sender)) {
      // Silently drop. Telling a stranger they're not on the list is itself information.
      log.warn('dropped message from non-allowlisted sender', { sender });
      return { accepted: false, reason: 'not allowlisted' };
    }

    const threadId = data.chats?.[0]?.guid ?? data.chats?.[0]?.chatIdentifier ?? sender;
    const attachments = await this.downloadAttachments(data.attachments ?? []);
    const text = (data.text ?? '').trim();
    if (!text && !attachments.length) return { accepted: false, reason: 'empty' };

    const msg: InboundMessage = {
      channel: 'imessage',
      threadId,
      sender,
      text,
      attachments,
      receivedAt: new Date().toISOString(),
    };
    await this.onMessage?.(msg);
    return { accepted: true };
  }

  private async downloadAttachments(
    list: Array<{ guid?: string; transferName?: string; mimeType?: string }>,
  ): Promise<Array<{ name: string; path: string; mime?: string }>> {
    const out: Array<{ name: string; path: string; mime?: string }> = [];
    for (const a of list) {
      if (!a.guid) continue;
      try {
        const res = await fetch(this.url(`/api/v1/attachment/${a.guid}/download`), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const name = basename(a.transferName ?? `${a.guid}.bin`);
        const path = join(this.attachmentDir, `${Date.now()}-${name}`);
        writeFileSync(path, buf);
        out.push({ name, path, mime: a.mimeType });
      } catch (err) {
        log.warn('attachment download failed', { guid: a.guid, err: (err as Error).message });
      }
    }
    return out;
  }

  async send(msg: OutboundMessage): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await fetch(this.url('/api/v1/message/text'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatGuid: msg.threadId,
          message: msg.text,
          method: 'private-api',
          tempGuid: `swb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        log.warn('send failed', { status: res.status, body: await res.text().catch(() => '') });
        return false;
      }
      for (const path of msg.attachments ?? []) await this.sendAttachment(msg.threadId, path);
      return true;
    } catch (err) {
      log.error('send threw', { err: (err as Error).message });
      return false;
    }
  }

  private async sendAttachment(chatGuid: string, path: string): Promise<boolean> {
    try {
      const { readFileSync } = await import('node:fs');
      const form = new FormData();
      form.set('chatGuid', chatGuid);
      form.set('tempGuid', `swb-att-${Date.now()}`);
      form.set('name', basename(path));
      form.set('attachment', new Blob([new Uint8Array(readFileSync(path))]), basename(path));
      const res = await fetch(this.url('/api/v1/message/attachment'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      return res.ok;
    } catch (err) {
      log.warn('attachment send failed', { path, err: (err as Error).message });
      return false;
    }
  }
}
