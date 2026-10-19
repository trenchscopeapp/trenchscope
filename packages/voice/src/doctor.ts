// Voice-mode doctor checks (task-1282 scope item 4). Returns the same check shape the CLI doctor uses
// so `trenchscope doctor` can render them inline. Everything the checks depend on (platform, which engines
// resolved, whether swiftc / a whisper model / a mic tool are present) is injected, so the checks are
// deterministic in tests and never spawn or hang. The guiding rule: if a component is missing, say
// exactly what to install, and make clear voice DEGRADES TO TEXT rather than breaking the app.

export type VoiceCheckStatus = 'pass' | 'warn' | 'fail';

export interface VoiceCheck {
  name: string;
  status: VoiceCheckStatus;
  detail: string;
  fix?: string;
}

export interface VoiceDoctorDeps {
  platform: NodeJS.Platform;
  /** macOS `say` present (speech-out). */
  sayAvailable: boolean;
  /** Number of installed `say` voices (0 when say is missing). */
  voiceCount: number;
  /** swiftc present → the Apple Speech helper can be compiled. */
  swiftcPresent: boolean;
  /** whisper-cli present on PATH. */
  whisperBinPresent: boolean;
  /** whisper base.en model present on disk. */
  whisperModelPresent: boolean;
  /** A mic-capture tool (sox/rec or ffmpeg, or arecord on Linux) present — needed by the whisper path. */
  micToolPresent: boolean;
  /** The STT engine that resolved for this machine, or null when voice-in is unavailable. */
  resolvedStt: string | null;
  /** espeak-ng (or espeak) present — the portable Linux/Windows speech-out engine (task-1393 Part 2). */
  espeakPresent?: boolean;
  /** Piper runtime present — the preferred neural speech-out engine everywhere (binary off macOS, the
   *  managed venv on macOS; task-1408, task-1416). */
  piperPresent?: boolean;
  /** The Piper voice model (en_GB-alan-medium) present on disk. */
  piperVoicePresent?: boolean;
  /** The audio player that will play a Piper WAV (afplay on macOS; aplay/paplay/ffplay off), or null. */
  playerName?: string | null;
  /** The `say` voice that resolved as the default, or null when no safe voice is installed (task-1393). */
  resolvedVoice?: string | null;
  /** Why that voice was chosen (for the "default voice" line). */
  resolvedVoiceReason?: string;
}

/** Produce the voice checks. Never throws. */
export function voiceDoctor(deps: VoiceDoctorDeps): VoiceCheck[] {
  const checks: VoiceCheck[] = [];

  if (deps.platform !== 'darwin') {
    const win = deps.platform === 'win32';
    // Speech OUT off macOS: Piper (neural, preferred) → espeak-ng (baseline) → warn (task-1408).
    // NOTE: `apt install piper` on Debian is an UNRELATED gaming-mouse tool — never suggest it; the
    // Piper TTS binary comes from the rhasspy/piper prebuilt release, the voice from `trenchscope voice download`.
    const piperRelease = 'github.com/rhasspy/piper/releases';
    const whisperRelease = 'github.com/ggml-org/whisper.cpp/releases';
    const piperReady = !!deps.piperPresent && !!deps.piperVoicePresent && !!deps.playerName;
    // What Piper is still missing (for an upgrade hint / the no-voice fix).
    const piperBits: string[] = [];
    if (!deps.piperPresent) piperBits.push(`the Piper binary (prebuilt from ${piperRelease} into \`~/.dexterm/piper/\`, NOT \`apt install piper\`)`);
    if (!deps.piperVoicePresent) piperBits.push('the voice model (`trenchscope voice download piper-voice` — asks first, checksum-verified)');
    if (!deps.playerName) piperBits.push(win ? 'an audio player (ffplay from ffmpeg)' : 'an audio player (`sudo apt install alsa-utils` for aplay, or pulseaudio-utils for paplay)');

    if (piperReady) {
      checks.push({ name: 'Voice out (Piper)', status: 'pass', detail: `Piper neural voice ready — en_GB-alan-medium, plays via ${deps.playerName} (local, no key)` });
    } else if (deps.espeakPresent) {
      checks.push({
        name: 'Voice out (espeak-ng)', status: 'pass',
        detail: `espeak-ng ready — British male default (local, no key). For a higher-quality neural voice, add Piper: ${piperBits.join('; ')}`,
      });
    } else {
      checks.push({
        name: 'Voice out', status: 'warn',
        detail: `spoken replies are off on ${deps.platform} until a speech engine is installed; the analyst still answers in text`,
        fix: win
          ? 'Install espeak-ng (`choco install espeak` or the espeak-ng release). For a neural voice, add Piper (prebuilt from '
            + `${piperRelease}) + \`trenchscope voice download piper-voice\` + ffplay.`
          : 'Fastest: `sudo apt install espeak-ng`. Better (neural): install the Piper prebuilt binary from '
            + `${piperRelease} into \`~/.dexterm/piper/\`, run \`trenchscope voice download piper-voice\`, and \`sudo apt install alsa-utils\` for a player. `
            + 'Do NOT `apt install piper` — on Debian that is an unrelated mouse tool.',
      });
    }
    // Speech IN — whisper.cpp (the default off macOS). Not in Debian: use the prebuilt release.
    if (deps.resolvedStt === 'whisper' || (deps.whisperBinPresent && deps.whisperModelPresent && deps.micToolPresent)) {
      checks.push({ name: 'Voice in (whisper)', status: 'pass', detail: 'whisper.cpp base.en + a mic tool (local, no key)' });
    } else {
      const bits: string[] = [];
      if (!deps.whisperBinPresent) bits.push('no whisper-cli');
      else if (!deps.whisperModelPresent) bits.push('no base.en model');
      if (!deps.micToolPresent) bits.push('no mic tool (arecord/sox/ffmpeg)');
      checks.push({
        name: 'Voice in', status: 'warn',
        detail: `speech-to-text is off (${bits.join(', ') || 'whisper not set up'}); you can still type questions — voice degrades to text`,
        fix: `Install whisper.cpp (not in Debian — use the prebuilt release from ${whisperRelease}) + a mic tool `
          + '(`sudo apt install alsa-utils` for arecord, or sox), then `trenchscope voice download whisper` (asks first, checksum-verified).',
      });
    }
    if (win) {
      checks.push({
        name: 'Windows voice', status: 'warn',
        detail: 'espeak-ng (or Piper) is the supported Windows speech-out path; native SAPI is not wired in this build',
        fix: 'Use espeak-ng or Piper on Windows for now. (SAPI support is a later enhancement.)',
      });
    }
    return checks;
  }

  // Speech OUT — Piper neural (the default when set up, task-1416) → macOS `say` (fallback) → text.
  const macPiperReady = !!deps.piperPresent && !!deps.piperVoicePresent && !!deps.playerName;
  if (macPiperReady) {
    checks.push({
      name: 'Voice out (Piper)', status: 'pass',
      detail: `neural British voice is the default — en_GB-alan-medium, plays via ${deps.playerName} (local, no key); fallback: macOS \`say\``,
    });
  }
  if (deps.sayAvailable) {
    const role = macPiperReady ? 'the fallback if Piper is removed' : 'the default — press the voice key, then cycle the voice';
    checks.push({ name: macPiperReady ? 'Voice out (say, fallback)' : 'Voice out (say)', status: 'pass', detail: `macOS \`say\` ready · ${deps.voiceCount} voice${deps.voiceCount === 1 ? '' : 's'} · ${role}` });
    // Which `say` voice speaks, and why — so a machine can never silently use a novelty/odd system voice (task-1393).
    const voiceLabel = macPiperReady ? 'Fallback voice' : 'Default voice';
    if (deps.resolvedVoice) {
      checks.push({ name: voiceLabel, status: 'pass', detail: `${deps.resolvedVoiceReason ?? deps.resolvedVoice} · , changes it` });
    } else if (deps.resolvedVoice === null) {
      checks.push({
        name: voiceLabel, status: 'warn',
        detail: deps.resolvedVoiceReason ?? 'no safe voice installed — spoken replies are off (text still works)',
        fix: 'Install a British male voice in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (Daniel, English (UK)); the Enhanced/Premium download sounds best.',
      });
    }
    // Offer the higher-quality neural voice when it is not set up yet (never silent; the user decides).
    if (!macPiperReady) {
      checks.push({
        name: 'Neural voice (Piper)', status: 'warn',
        detail: 'a higher-quality neural British voice is available but not set up; `say` is speaking for now',
        fix: 'Run `trenchscope voice setup` to install it (asks first; a private Python runtime + a ~61 MB checksum-verified model; runs offline after, `trenchscope voice uninstall` removes it).',
      });
    }
  } else if (!macPiperReady) {
    checks.push({
      name: 'Voice out', status: 'warn',
      detail: 'macOS `say` not found; spoken replies are off, the analyst still answers in text',
      fix: '`say` ships with macOS — if it is missing, reinstall the Command Line Tools (`xcode-select --install`). Or set up the neural voice: `trenchscope voice setup`.',
    });
  }

  // Speech IN — Apple Speech (preferred) or whisper (fallback).
  if (deps.resolvedStt === 'apple' || deps.swiftcPresent) {
    checks.push({ name: 'Voice in (Apple Speech)', status: 'pass', detail: 'on-device Apple Speech via swiftc (no key, streaming) — the first run asks for Microphone + Speech permission at the Mac' });
  } else if (deps.resolvedStt === 'whisper' || (deps.whisperBinPresent && deps.whisperModelPresent && deps.micToolPresent)) {
    checks.push({ name: 'Voice in (whisper)', status: 'pass', detail: 'whisper.cpp base.en + a mic tool (local, no key)' });
  } else {
    // Nothing for voice-in: steer to the fastest free path and make clear text still works.
    const bits: string[] = [];
    if (!deps.swiftcPresent) bits.push('no swiftc (Apple Speech)');
    if (!deps.whisperBinPresent) bits.push('no whisper-cli');
    else if (!deps.whisperModelPresent) bits.push('no base.en model');
    if (!deps.micToolPresent) bits.push('no mic tool (sox/ffmpeg)');
    checks.push({
      name: 'Voice in', status: 'warn',
      detail: `speech-to-text is off (${bits.join(', ')}); you can still type questions — voice degrades to text`,
      fix: 'Fastest free path: install Xcode command line tools for Apple Speech (`xcode-select --install`). '
        + 'Or whisper: `brew install whisper-cpp sox`, then `trenchscope voice download whisper` (asks first, checksum-verified, writes '
        + '`~/.dexterm/models/ggml-base.en.bin`). Never use large-v3-turbo on a CPU-only Mac — it is unusably slow.',
    });
  }

  // Mic-capture tool note (only relevant to the whisper path; Apple Speech captures its own audio).
  if (!deps.micToolPresent && deps.resolvedStt !== 'apple') {
    checks.push({
      name: 'Mic capture', status: 'warn',
      detail: 'no sox/ffmpeg found; the whisper voice-in path needs one (Apple Speech does not)',
      fix: '`brew install sox` (smallest) or `brew install ffmpeg`.',
    });
  }

  return checks;
}
