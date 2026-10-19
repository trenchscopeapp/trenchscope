// Engine selection (task-1282). Picks the STT and TTS engines for this machine, honouring explicit
// env overrides and falling back gracefully. The app degrades to text (never crashes) when nothing is
// available; selectStt() returns null in that case and the controller says so.

import type { SttEngine, TtsEngine } from './types.ts';
import { AppleStt } from './stt/apple.ts';
import { WhisperStt } from './stt/whisper.ts';
import { FakeStt } from './stt/fake.ts';
import { SayTts } from './tts/say.ts';
import { EspeakTts, espeakVoiceFor } from './tts/espeak.ts';
import { PiperTts } from './tts/piper.ts';
import { FakeTts } from './tts/fake.ts';
import { resolveVoice, type VoiceResolution } from './tts/voices.ts';

export type SttChoice = 'auto' | 'apple' | 'whisper' | 'fake' | 'none';
export type TtsChoice = 'auto' | 'say' | 'piper' | 'espeak' | 'fake' | 'none';

/**
 * Resolve the STT engine. `auto` prefers Apple Speech (on-device, streaming), then whisper base.en,
 * then none. An explicit choice is returned even if it later proves unavailable, so the doctor and the
 * status line can report exactly why voice-in is off.
 */
export async function selectStt(choice: SttChoice = (process.env.DEXTERM_VOICE_STT as SttChoice) || 'auto'): Promise<SttEngine | null> {
  if (choice === 'none') return null;
  if (choice === 'fake') return new FakeStt();
  if (choice === 'apple') return new AppleStt();
  if (choice === 'whisper') return new WhisperStt();
  // auto: probe in preference order.
  const apple = new AppleStt();
  if (await apple.available()) return apple;
  const whisper = new WhisperStt();
  if (await whisper.available()) return whisper;
  return null;
}

/**
 * Resolve the default `say` voice for this machine: the user's configured voice if it is installed and
 * safe, else a deep British male (Daniel first), never a novelty voice and never the OS system default.
 * Returns the full resolution (voice + why) so the controller and `trenchscope doctor` can show it.
 */
export async function resolveSayVoice(say: SayTts, configured?: string | null): Promise<VoiceResolution> {
  const installed = await say.listVoicesDetailed();
  return resolveVoice({ configured, installed });
}

/**
 * Resolve the TTS engine. `auto` uses macOS `say` when present, else none (voice replies off). When
 * `say` is chosen, its default voice is resolved to an explicit deep British male so it can NEVER fall
 * back to the machine's system voice (task-1393). `configuredVoice` is the user's `config.voice.name`.
 */
export async function selectTts(
  choice: TtsChoice = (process.env.DEXTERM_VOICE_TTS as TtsChoice) || 'auto',
  configuredVoice?: string | null,
): Promise<TtsEngine | null> {
  if (choice === 'none') return null;
  if (choice === 'fake') return new FakeTts();
  // Piper and espeak are the off-macOS engines. A macOS voice name (config.voice.name is e.g.
  // "Eddy (English (UK))") is NEVER passed to them verbatim: Piper's voice is its model, and espeak
  // only honours a real espeak voice token (espeakVoiceFor drops a Mac name → the British default).
  if (choice === 'piper') { const p = new PiperTts(); return (await p.available()) ? p : null; }
  if (choice === 'espeak') { const e = new EspeakTts(espeakVoiceFor(configuredVoice) ?? undefined); return (await e.available()) ? e : null; }

  // On macOS, prefer Piper alan (neural) when the managed runtime is installed (task-1416:
  // `trenchscope voice setup` → venv + model + afplay), else the built-in `say`. Off macOS, `say` does not
  // exist — use the portable engines below. An explicit `choice==='say'` always skips Piper.
  if (choice === 'say' || (choice === 'auto' && process.platform === 'darwin')) {
    if (choice === 'auto') {
      const piperMac = new PiperTts();
      if (await piperMac.available()) return piperMac;
    }
    const probe = new SayTts();
    if (choice === 'auto' && !(await probe.available())) return null;
    const r = await resolveSayVoice(probe, configuredVoice);
    // No safe voice installed (only novelty voices): voice-out stays OFF so `say` can never be invoked
    // without an explicit voice and fall back to the machine's system voice (task-1393). Text still works.
    if (r.voice === null) return null;
    return new SayTts(r.voice);
  }

  // auto, non-darwin: Piper (neural, higher quality) when it can speak aloud, else espeak-ng, else
  // text-only. Neither engine is ever handed a macOS voice name (task-1408).
  const piper = new PiperTts();
  if (await piper.available()) return piper;
  const espeak = new EspeakTts(espeakVoiceFor(configuredVoice) ?? undefined);
  return (await espeak.available()) ? espeak : null;
}
