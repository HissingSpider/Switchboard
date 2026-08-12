/**
 * Voice pipeline vocabulary.
 *
 * One audio format end to end: 16 kHz mono signed 16-bit little-endian PCM.
 * whisper.cpp wants exactly that, Piper emits it, and the browser can produce
 * and consume it without a codec. Resampling happens once, in the client, so
 * nothing downstream has to care.
 */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
export const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE; // 640

export function msToBytes(ms: number): number {
  return Math.round((SAMPLE_RATE * ms) / 1000) * BYTES_PER_SAMPLE;
}

export function bytesToMs(bytes: number): number {
  return (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
}

/** Control messages the client and server exchange alongside the binary audio. */
export type VoiceClientMessage =
  | { type: 'hello'; threadId?: string; agent?: string; project?: string; sampleRate: number }
  | { type: 'start' } // push-to-talk pressed, or wake word fired client-side
  | { type: 'stop' } // push-to-talk released
  | { type: 'text'; text: string } // typed fallback, same pipeline
  | { type: 'interrupt' } // user tapped to cut off playback
  | { type: 'bye' };

export type VoiceServerMessage =
  | { type: 'ready'; sessionId: string; threadId: string; agent?: string; sttReady: boolean; ttsReady: boolean }
  | { type: 'listening' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'thinking'; lane: Lane }
  | { type: 'say'; text: string; audioBytes: number } // audio follows as binary frames
  | { type: 'audio_end' }
  | { type: 'interrupted'; reason: 'barge-in' | 'user' }
  | { type: 'run_started'; runId: string }
  | { type: 'run_finished'; runId: string; summary: string }
  | { type: 'confirm_escalated'; confirmId: string; via: string }
  | { type: 'error'; message: string };

/** How fast a turn has to come back, which decides how we handle it. */
export type Lane = 'instant' | 'query' | 'task';

export interface Transcript {
  text: string;
  /** Model confidence where the engine reports one; 1 when it doesn't. */
  confidence: number;
  /** Wall-clock the engine took, for the latency budget. */
  ms: number;
  partial: boolean;
}

export interface SttEngine {
  readonly name: string;
  readonly available: boolean;
  /** Transcribe a complete utterance. */
  transcribe(pcm: Buffer): Promise<Transcript>;
  /** Optional: a cheap partial for the utterance so far, to show while speaking. */
  partial?(pcm: Buffer): Promise<Transcript | undefined>;
  warm?(): Promise<void>;
  dispose?(): void;
}

export interface TtsEngine {
  readonly name: string;
  readonly available: boolean;
  /** Synthesise one sentence to 16 kHz mono PCM16. */
  synthesize(text: string): Promise<Buffer>;
  warm?(): Promise<void>;
  dispose?(): void;
}

export interface VadResult {
  speech: boolean;
  /** RMS of the frame, 0..1. Used for barge-in thresholds. */
  energy: number;
}

export interface VadEngine {
  readonly name: string;
  /** One 20 ms frame in, a verdict out. Must be cheap — this runs 50×/second. */
  process(frame: Buffer): VadResult;
  reset(): void;
}

/** Turn a WAV file (as produced by `say`/piper) into raw PCM16 @16 kHz. */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return wav;
  // Walk the chunk list rather than assuming a 44-byte header; `say` emits LIST
  // chunks and Piper sometimes emits a fact chunk.
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length));
    offset += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

/** Wrap raw PCM16 in a WAV header — what CLI engines want on stdin. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Split streamed text into speakable sentences.
 *
 * TTS latency is dominated by waiting for the whole reply, so we synthesise the
 * first sentence the moment it's complete. Returns finished sentences plus
 * whatever tail is still incomplete.
 */
export function splitSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /([^.!?…\n]+[.!?…]+|\n+)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(buffer)) !== null) {
    const piece = match[0].trim();
    if (piece) sentences.push(piece);
    consumed = match.index + match[0].length;
  }
  rest = buffer.slice(consumed);
  // A very long clause with no terminator still has to be spoken eventually.
  if (!sentences.length && rest.length > 220) {
    const cut = rest.lastIndexOf(' ', 200);
    if (cut > 40) {
      sentences.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
  }
  return { sentences, rest };
}

/** Strip things that sound wrong read aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_>]/g, '')
    .replace(/\b([a-z0-9]{2,})[-_]([a-z0-9]{2,})\b/gi, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
