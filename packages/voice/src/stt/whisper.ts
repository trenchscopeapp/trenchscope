// whisper.cpp STT engine (task-1282). Local, no key, no network once the model is downloaded. This is
// the portable fallback when Apple Speech is unavailable. The spike measured `base.en` at ~3.5–4.8 s
// batch on a CPU-only Intel Mac with good accuracy; `large-v3-turbo` was unusable (55–93 s) — so this
// engine defaults to `base.en` and the doctor steers the user to it, never to a turbo model on CPU.
//
// Capture: `sox`/`rec` or `ffmpeg -f avfoundation` writes a 16 kHz mono WAV while the key is held;
// stop() finalises the WAV and runs whisper-cli on it. The WAV lives in the OS temp dir and is
// DELETED immediately after transcription unless DEXTERM_VOICE_RECORD=1 — nothing is kept by default.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SttEngine, SttResult, SttSession } from '../types.ts';

export const WHISPER_BIN = process.env.DEXTERM_WHISPER_BIN || 'whisper-cli';
/** Default model — base.en, the spike's accurate+usable choice. Never large-v3-turbo on CPU. */
export const WHISPER_MODEL = process.env.DEXTERM_WHISPER_MODEL || join(homedir(), '.dexterm', 'models', 'ggml-base.en.bin');

/** Where the user is told to put the model (doctor fix line). */
export const WHISPER_MODEL_DIR = join(homedir(), '.dexterm', 'models');

type Recorder = { cmd: string; args: (wav: string) => string[]; stopSignal: NodeJS.Signals };

/**
 * Pick a mic-capture tool, best-first. sox (`rec`) is cross-platform; `arecord` (alsa-utils) is the
 * native Linux capture tool (task-1408) and finalises its WAV header on SIGINT; ffmpeg is last and its
 * input format is platform-specific (avfoundation on macOS, alsa on Linux). All write a 16 kHz mono
 * 16-bit WAV, which is what whisper.cpp wants. Returns null when nothing is installed.
 */
export function pickRecorder(): Recorder | null {
  if (which('rec')) return { cmd: 'rec', args: (wav) => ['-q', '-c', '1', '-r', '16000', '-b', '16', wav], stopSignal: 'SIGINT' };
  if (which('sox')) return { cmd: 'sox', args: (wav) => ['-q', '-d', '-c', '1', '-r', '16000', '-b', '16', wav], stopSignal: 'SIGINT' };
  if (process.platform !== 'darwin' && which('arecord')) {
    return { cmd: 'arecord', args: (wav) => ['-q', '-f', 'S16_LE', '-c', '1', '-r', '16000', wav], stopSignal: 'SIGINT' };
  }
  if (which('ffmpeg')) {
    const linux = process.platform === 'linux';
    const fmt = linux ? 'alsa' : 'avfoundation';
    const dev = process.env.DEXTERM_FFMPEG_MIC || (linux ? 'default' : ':default');
    return { cmd: 'ffmpeg', args: (wav) => ['-hide_banner', '-loglevel', 'error', '-f', fmt, '-i', dev, '-ac', '1', '-ar', '16000', '-y', wav], stopSignal: 'SIGINT' };
  }
  return null;
}

/** Synchronous PATH check without spawning (cheap; used by available() and pickRecorder). */
function which(bin: string): boolean {
  // Windows (task-1423): `;`-separated PATH and `.exe` binaries, same rule as piper.ts's which()
  const win = process.platform === 'win32';
  const paths = (process.env.PATH ?? '').split(win ? ';' : ':');
  for (const p of paths) { if (p && (existsSync(join(p, bin)) || (win && existsSync(join(p, `${bin}.exe`))))) return true; }
  return false;
}

export class WhisperStt implements SttEngine {
  readonly name = 'whisper';
  readonly label = 'whisper.cpp base.en (local, no key)';
  private model: string;
  private recordToDisk = process.env.DEXTERM_VOICE_RECORD === '1';

  constructor(model: string = WHISPER_MODEL) { this.model = model; }

  async available(): Promise<boolean> {
    return (which(WHISPER_BIN) || existsSync(WHISPER_BIN)) && existsSync(this.model) && pickRecorder() !== null;
  }

  async listen(): Promise<SttSession> {
    const rec = pickRecorder();
    if (!rec) throw new Error('no mic capture tool (install sox or ffmpeg)');
    const dir = mkdtempSync(join(tmpdir(), 'dexterm-voice-'));
    const wav = join(dir, 'capture.wav');
    const t0 = Date.now();
    const recorder: ChildProcess = spawn(rec.cmd, rec.args(wav), { stdio: 'ignore' });
    let cancelled = false;

    const cleanup = (): void => {
      if (this.recordToDisk) return; // explicit opt-in to keep the audio
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    };

    return {
      stop: async (): Promise<SttResult> => {
        // Ask the recorder to finalise the WAV header, then wait for it to exit.
        try { recorder.kill(rec.stopSignal); } catch { /* already gone */ }
        await new Promise<void>((r) => { recorder.on('close', () => r()); setTimeout(r, 2000); });
        if (cancelled || !existsSync(wav)) { cleanup(); return { text: '', confidence: 0 }; }
        try {
          const text = await transcribe(wav, this.model);
          return { text, confidence: text ? 0.9 : 0, firstPartialMs: null, speakerCount: 1 };
        } finally {
          cleanup();
        }
      },
      cancel: () => { cancelled = true; try { recorder.kill('SIGKILL'); } catch { /* ignore */ } cleanup(); },
    };
  }
}

/** Run whisper-cli on a finished WAV and return the transcript text. Rejects on a non-zero exit. */
function transcribe(wav: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(WHISPER_BIN, ['-m', model, '-f', wav, '-nt', '-l', 'en', '-t', '4'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out.replace(/\s+/g, ' ').trim()) : reject(new Error(`whisper exit ${code}: ${err.slice(-200)}`)));
  });
}
