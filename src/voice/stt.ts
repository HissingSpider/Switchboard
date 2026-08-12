import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandPath } from '../config/load.js';
import { logger } from '../core/logger.js';
import { pcmToWav, bytesToMs, type SttEngine, type Transcript } from './types.js';

const exec = promisify(execFile);
const log = logger('stt');

const CANDIDATE_BINARIES = [
  'whisper-cli',
  'whisper-cpp',
  'main', // what whisper.cpp used to build as
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
];

const CANDIDATE_MODELS = [
  '~/.switchboard/models/ggml-base.en.bin',
  '~/.switchboard/models/ggml-small.en.bin',
  '/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin',
];

export interface WhisperOptions {
  binary?: string;
  model?: string;
  /** whisper.cpp threads. More than the P-core count makes it slower, not faster. */
  threads?: number;
  language?: string;
}

export function findWhisper(opts: WhisperOptions = {}): { binary?: string; model?: string } {
  const binary = opts.binary
    ? expandPath(opts.binary)
    : CANDIDATE_BINARIES.map((b) => (b.includes('/') ? b : whichSync(b))).find((p) => p && existsSync(p));
  const model = opts.model ? expandPath(opts.model) : CANDIDATE_MODELS.map(expandPath).find((p) => existsSync(p));
  return { binary: binary ?? undefined, model };
}

function whichSync(bin: string): string | undefined {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * whisper.cpp, which on this machine means Metal.
 *
 * We shell out per utterance rather than keeping a stream open: whisper.cpp's
 * streaming mode re-decodes overlapping windows and burns GPU continuously,
 * which on a machine that also has to run `claude -p` is a bad trade. An
 * utterance of two or three seconds transcribes in well under 300 ms with
 * base.en on Metal, which fits the turn budget.
 */
export class WhisperCppStt implements SttEngine {
  readonly name = 'whisper.cpp';
  private readonly binary?: string;
  private readonly model?: string;
  private warmed = false;

  constructor(private readonly opts: WhisperOptions = {}) {
    const found = findWhisper(opts);
    this.binary = found.binary;
    this.model = found.model;
  }

  get available(): boolean {
    return Boolean(this.binary && this.model);
  }

  get detail(): string {
    if (!this.binary) return 'whisper-cli not found on PATH';
    if (!this.model) return `no model found (looked in ${CANDIDATE_MODELS.join(', ')})`;
    return `${this.binary} with ${this.model}`;
  }

  /** First call loads the model into the GPU; do it before the user speaks. */
  async warm(): Promise<void> {
    if (this.warmed || !this.available) return;
    const silence = Buffer.alloc(16_000 * 2); // one second
    await this.transcribe(silence).catch(() => undefined);
    this.warmed = true;
  }

  async transcribe(pcm: Buffer): Promise<Transcript> {
    const started = Date.now();
    if (!this.available) throw new Error(`STT unavailable: ${this.detail}`);
    if (bytesToMs(pcm.length) < 150) return { text: '', confidence: 0, ms: 0, partial: false };

    const dir = mkdtempSync(join(tmpdir(), 'swb-stt-'));
    const wav = join(dir, 'in.wav');
    try {
      writeFileSync(wav, pcmToWav(pcm));
      const args = [
        '-m',
        this.model!,
        '-f',
        wav,
        '-t',
        String(this.opts.threads ?? 6),
        '-l',
        this.opts.language ?? 'en',
        '-nt', // no timestamps
        '-np', // no progress prints
        '--output-txt',
        '-of',
        join(dir, 'out'),
      ];
      await exec(this.binary!, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const outFile = join(dir, 'out.txt');
      const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
      return { text: cleanTranscript(text), confidence: text ? 1 : 0, ms: Date.now() - started, partial: false };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Apple's on-device dictation via the Speech framework, reached through a tiny
 * Swift shim. Zero install, but it needs a Speech Recognition grant and is
 * noticeably worse on technical vocabulary — so it's the fallback, not default.
 */
export class MacSpeechStt implements SttEngine {
  readonly name = 'macos-speech';

  constructor(private readonly helperPath: string) {}

  get available(): boolean {
    return existsSync(this.helperPath);
  }

  async transcribe(pcm: Buffer): Promise<Transcript> {
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'swb-stt-'));
    const wav = join(dir, 'in.wav');
    try {
      writeFileSync(wav, pcmToWav(pcm));
      const { stdout } = await exec(this.helperPath, [wav], { timeout: 30_000 });
      return { text: cleanTranscript(stdout.trim()), confidence: 0.8, ms: Date.now() - started, partial: false };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Deterministic engine for tests: reads the transcript out of the audio's tail. */
export class FakeStt implements SttEngine {
  readonly name = 'fake';
  readonly available = true;
  constructor(private readonly script: string[] = []) {}
  private index = 0;

  async transcribe(): Promise<Transcript> {
    const text = this.script[this.index++] ?? '';
    return { text, confidence: 1, ms: 1, partial: false };
  }
}

export function pickStt(opts: WhisperOptions & { helperPath?: string } = {}): SttEngine {
  const whisper = new WhisperCppStt(opts);
  if (whisper.available) return whisper;
  if (opts.helperPath) {
    const mac = new MacSpeechStt(opts.helperPath);
    if (mac.available) return mac;
  }
  log.warn('no STT engine available', { detail: whisper.detail });
  return whisper; // unavailable, but its `detail` explains why
}

/** whisper.cpp emits bracketed non-speech markers and stray blank lines. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const WHISPER_INSTALL_HELP = [
  'STT needs whisper.cpp and a model:',
  '  brew install whisper-cpp',
  '  mkdir -p ~/.switchboard/models && cd ~/.switchboard/models',
  '  curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'base.en is the right size here — small.en is more accurate but roughly triples the turn latency.',
].join('\n');

/** Long-running process variant, kept for whisper.cpp builds that support --stream. */
export function spawnStreamingWhisper(binary: string, model: string, onPartial: (text: string) => void): { stop: () => void } {
  const child = spawn(binary, ['-m', model, '--step', '500', '--length', '5000', '-t', '6', '-nt'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const text = cleanTranscript(chunk);
    if (text) onPartial(text);
  });
  return { stop: () => child.kill('SIGTERM') };
}
