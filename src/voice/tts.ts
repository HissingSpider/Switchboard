import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandPath } from '../config/load.js';
import { SAMPLE_RATE, wavToPcm, speakable, splitSentences, type TtsEngine } from './types.js';

const exec = promisify(execFile);

function which(bin: string): string | undefined {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Piper: small, fast, and genuinely good. One process per sentence; a medium
 * voice synthesises a sentence in 60-120 ms on this hardware, which is under
 * the time it takes to play the sentence before it — so playback never gaps.
 */
export class PiperTts implements TtsEngine {
  readonly name = 'piper';
  private readonly binary?: string;
  private readonly model?: string;

  constructor(opts: { binary?: string; model?: string } = {}) {
    this.binary = opts.binary ? expandPath(opts.binary) : which('piper');
    const candidates = [opts.model, '~/.switchboard/models/piper/en_US-amy-medium.onnx', '~/.switchboard/models/piper/voice.onnx']
      .filter(Boolean)
      .map((p) => expandPath(p!));
    this.model = candidates.find((p) => existsSync(p));
  }

  get available(): boolean {
    return Boolean(this.binary && this.model);
  }

  get detail(): string {
    if (!this.binary) return 'piper not found on PATH';
    if (!this.model) return 'no piper voice model in ~/.switchboard/models/piper';
    return `${this.binary} with ${this.model}`;
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.available) throw new Error(`TTS unavailable: ${this.detail}`);
    const dir = mkdtempSync(join(tmpdir(), 'swb-tts-'));
    const out = join(dir, 'out.wav');
    try {
      // Piper resamples for us when asked, so everything downstream stays 16 kHz.
      await exec(this.binary!, ['--model', this.model!, '--output_file', out, '--sample_rate', String(SAMPLE_RATE)], {
        timeout: 20_000,
        input: speakable(text),
      } as never);
      return wavToPcm(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Kokoro through its Python CLI. Better prosody than Piper, meaningfully
 * slower to start, so it is worth it only if you keep the process warm — which
 * we do not yet. Available for people who prefer the voice.
 */
export class KokoroTts implements TtsEngine {
  readonly name = 'kokoro';
  private readonly binary?: string;

  constructor(opts: { binary?: string; voice?: string } = {}) {
    this.binary = opts.binary ? expandPath(opts.binary) : which('kokoro');
    this.voice = opts.voice ?? 'af_heart';
  }
  private readonly voice: string;

  get available(): boolean {
    return Boolean(this.binary);
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.available) throw new Error('kokoro not found on PATH');
    const dir = mkdtempSync(join(tmpdir(), 'swb-tts-'));
    const out = join(dir, 'out.wav');
    try {
      await exec(this.binary!, ['--text', speakable(text), '--voice', this.voice, '--output', out, '--sample-rate', String(SAMPLE_RATE)], {
        timeout: 30_000,
      });
      return wavToPcm(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * macOS `say`. Not as nice as Piper, but it is already installed on every Mac,
 * which means voice works the minute you clone the repo rather than after a
 * model download. This is the default until you install something better.
 */
export class MacSayTts implements TtsEngine {
  readonly name = 'macos-say';

  constructor(private readonly voice = 'Samantha') {}

  get available(): boolean {
    return process.platform === 'darwin' && Boolean(which('say'));
  }

  async synthesize(text: string): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), 'swb-tts-'));
    const out = join(dir, 'out.wav');
    try {
      // LEI16@16000 gives us exactly the format the rest of the pipeline wants.
      await exec('say', ['-v', this.voice, '-o', out, '--data-format=LEI16@16000', '--file-format=WAVE', speakable(text)], {
        timeout: 20_000,
      });
      return wavToPcm(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  static voices(): string[] {
    try {
      return execFileSync('say', ['-v', '?'], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.split(/\s{2,}/)[0]?.trim())
        .filter((v): v is string => Boolean(v));
    } catch {
      return [];
    }
  }
}

export class FakeTts implements TtsEngine {
  readonly name = 'fake';
  readonly available = true;
  spoken: string[] = [];

  async synthesize(text: string): Promise<Buffer> {
    this.spoken.push(text);
    // 80 ms of silence per word is close enough for timing assertions.
    return Buffer.alloc(Math.max(1, text.split(/\s+/).length) * 80 * 32);
  }
}

export function pickTts(opts: { engine?: string; voice?: string; piperModel?: string } = {}): TtsEngine {
  const wanted = opts.engine;
  const piper = new PiperTts({ model: opts.piperModel });
  const kokoro = new KokoroTts({ voice: opts.voice });
  const say = new MacSayTts(opts.voice);

  if (wanted === 'piper') return piper;
  if (wanted === 'kokoro') return kokoro;
  if (wanted === 'say') return say;
  if (piper.available) return piper;
  if (kokoro.available) return kokoro;
  return say;
}

export const TTS_INSTALL_HELP = [
  'TTS works out of the box with macOS `say`. For a better voice:',
  '  brew install piper   # or: pipx install piper-tts',
  '  mkdir -p ~/.switchboard/models/piper && cd ~/.switchboard/models/piper',
  '  curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
  '  curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json',
].join('\n');

/**
 * Sentence-streamed synthesis.
 *
 * Feed it text as the model produces it; it synthesises each complete sentence
 * immediately and hands you PCM while the model is still writing the next one.
 * `cancel()` stops the queue mid-flight, which is what barge-in needs.
 */
export class SentenceStreamer {
  private buffer = '';
  private queue: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(
    private readonly tts: TtsEngine,
    private readonly onAudio: (pcm: Buffer, sentence: string) => void | Promise<void>,
  ) {}

  /** Push more text. Returns once every sentence completed so far is synthesised. */
  push(chunk: string): void {
    this.buffer += chunk;
    const { sentences, rest } = splitSentences(this.buffer);
    this.buffer = rest;
    for (const sentence of sentences) this.enqueue(sentence);
  }

  /** Flush whatever is left, even without a terminator. */
  end(): Promise<void> {
    if (this.buffer.trim()) {
      this.enqueue(this.buffer.trim());
      this.buffer = '';
    }
    return this.queue;
  }

  private enqueue(sentence: string): void {
    this.queue = this.queue.then(async () => {
      if (this.cancelled || !sentence.trim()) return;
      const pcm = await this.tts.synthesize(sentence).catch(() => Buffer.alloc(0));
      if (this.cancelled || !pcm.length) return;
      await this.onAudio(pcm, sentence);
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.buffer = '';
  }

  get idle(): Promise<void> {
    return this.queue;
  }
}
