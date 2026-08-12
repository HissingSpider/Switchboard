import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelegramConfig } from '../config/schema.js';
import { resolveRef } from '../secrets/keychain.js';
import { logger } from '../core/logger.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { allowlisted } from './types.js';

const log = logger('telegram');

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; file_size?: number }>;
  };
}

/**
 * Telegram is the dev channel: same routing, same downsample, but it can be
 * torn down and rebuilt without touching the phone number the real bridge uses.
 * Long polling means no webhook, no tunnel, no TLS to arrange.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const;
  onMessage?: (msg: InboundMessage) => void | Promise<void>;
  private offset = 0;
  private polling = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly cfg: TelegramConfig,
    private readonly attachmentDir: string,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private get token(): string {
    return resolveRef(this.cfg.botTokenRef) ?? '';
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    mkdirSync(this.attachmentDir, { recursive: true });
    this.polling = true;
    void this.pollLoop();
    log.info('telegram polling started');
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abort?.abort();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        this.abort = new AbortController();
        const res = await fetch(this.api('getUpdates'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ['message'] }),
          signal: this.abort.signal,
        });
        if (!res.ok) {
          await sleep(5000);
          continue;
        }
        const body = (await res.json()) as { ok: boolean; result: TgUpdate[] };
        for (const update of body.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (this.polling) {
          log.warn('poll failed', { err: (err as Error).message });
          await sleep(5000);
        }
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const m = update.message;
    if (!m) return;
    const sender = m.from?.username ? `@${m.from.username}` : String(m.from?.id ?? '');
    const idForm = String(m.from?.id ?? '');
    if (!allowlisted(this.cfg.allowlist, sender) && !allowlisted(this.cfg.allowlist, idForm)) {
      log.warn('dropped message from non-allowlisted sender', { sender });
      return;
    }
    const attachments = await this.downloadFiles(m);
    const text = (m.text ?? m.caption ?? '').trim();
    if (!text && !attachments.length) return;
    await this.onMessage?.({
      channel: 'telegram',
      threadId: String(m.chat.id),
      sender,
      text,
      attachments,
      receivedAt: new Date().toISOString(),
    });
  }

  private async downloadFiles(m: NonNullable<TgUpdate['message']>): Promise<Array<{ name: string; path: string; mime?: string }>> {
    const targets: Array<{ fileId: string; name: string; mime?: string }> = [];
    if (m.document) targets.push({ fileId: m.document.file_id, name: m.document.file_name ?? 'document', mime: m.document.mime_type });
    const largest = m.photo?.[m.photo.length - 1];
    if (largest) targets.push({ fileId: largest.file_id, name: `photo-${largest.file_id.slice(0, 8)}.jpg`, mime: 'image/jpeg' });

    const out: Array<{ name: string; path: string; mime?: string }> = [];
    for (const t of targets) {
      try {
        const infoRes = await fetch(this.api(`getFile?file_id=${t.fileId}`));
        const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
        if (!info.result?.file_path) continue;
        const fileRes = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.result.file_path}`);
        const path = join(this.attachmentDir, `${Date.now()}-${t.name}`);
        writeFileSync(path, Buffer.from(await fileRes.arrayBuffer()));
        out.push({ name: t.name, path, mime: t.mime });
      } catch (err) {
        log.warn('file download failed', { err: (err as Error).message });
      }
    }
    return out;
  }

  async send(msg: OutboundMessage): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      // Telegram caps a message at 4096 chars.
      for (const chunk of chunkText(msg.text, 4000)) {
        const res = await fetch(this.api('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: msg.threadId, text: chunk, disable_web_page_preview: true }),
        });
        if (!res.ok) return false;
      }
      for (const path of msg.attachments ?? []) {
        const form = new FormData();
        form.set('chat_id', msg.threadId);
        form.set('document', new Blob([new Uint8Array(readFileSync(path))]), path.split('/').pop()!);
        await fetch(this.api('sendDocument'), { method: 'POST', body: form });
      }
      return true;
    } catch (err) {
      log.error('send threw', { err: (err as Error).message });
      return false;
    }
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
