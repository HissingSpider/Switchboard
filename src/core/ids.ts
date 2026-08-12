import { randomBytes, randomUUID } from 'node:crypto';

/** Crockford-ish base32 without ambiguous chars — short IDs that survive being read aloud / texted. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function shortId(len = 5): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Run IDs are what the human types back at us ("kill r-8k2wq"), so keep them short and prefixed. */
export function runId(): string {
  return `r-${shortId(5)}`;
}

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
