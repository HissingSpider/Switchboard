import type { Channel } from '../store/runs.js';

export interface InboundMessage {
  channel: Channel;
  /** Conversation id — chat guid, telegram chat id, dashboard tab. */
  threadId: string;
  /** Who sent it, in whatever form the channel uses. */
  sender: string;
  text: string;
  attachments?: Array<{ name: string; path: string; mime?: string }>;
  receivedAt: string;
}

export interface OutboundMessage {
  threadId: string;
  text: string;
  /** File paths to send back alongside the text. */
  attachments?: string[];
}

export interface ChannelAdapter {
  readonly name: Channel;
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<boolean>;
  /** Set by the gateway; the adapter calls it for every allowed inbound message. */
  onMessage?: (msg: InboundMessage) => void | Promise<void>;
}

export function allowlisted(list: string[], sender: string): boolean {
  if (!list.length) return false;
  const normalized = normalizeHandle(sender);
  return list.some((entry) => normalizeHandle(entry) === normalized || entry === '*');
}

/** Phone numbers arrive in half a dozen shapes; compare on digits. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes('@')) return h;
  const digits = h.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits || h;
}
