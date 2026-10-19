// @dexterm/voice — JARVIS voice mode (task-1282). Public surface.
//
// Free and portable by requirement: macOS `say` for speech-out, on-device Apple Speech (compiled with
// swiftc) or local whisper.cpp for speech-in — no paid APIs, no shipped keys. Voice can only ask the
// analyst or trigger its existing safe actions; it can NEVER confirm, sign, or execute a trade.
export * from './types.ts';
export { route, isSafe, type VoiceDecision } from './router.ts';
export { spokenSummary, splitSentences, type SpokenSource } from './summary.ts';
export { speakable, humanizeNumber, type SpeakableOpts } from './speakable.ts';
export { VoiceController, type VoiceStatus, type VoiceControllerOpts, type LatencySample } from './controller.ts';
export { selectStt, selectTts, resolveSayVoice, type SttChoice, type TtsChoice } from './engines.ts';
export { voiceDoctor, type VoiceCheck, type VoiceCheckStatus, type VoiceDoctorDeps } from './doctor.ts';
export {
  resolveVoice, isBannedVoice, normalizeVoiceName, parseSayVoices, sanitizeSpeech,
  BANNED_VOICE_NAMES, BRITISH_MALE_PREFERENCE, MAX_SPEAK_CHARS, VOICE_STYLE_DEFAULTS, voiceStyleDefaults,
  type VoiceInfo, type VoiceResolution, type VoiceSource,
} from './tts/voices.ts';
export { SayTts, DEFAULT_RATE } from './tts/say.ts';
export { EspeakTts, DEFAULT_ESPEAK_VOICE, resolveEspeakBin, espeakVoiceFor } from './tts/espeak.ts';
export {
  PiperTts, DEFAULT_PIPER_VOICE, PIPER_MODEL, PIPER_PLAYERS,
  resolvePiperBin, resolvePiperRuntime, managedVenvPython, pickPlayer, type PiperRuntime,
} from './tts/piper.ts';
export {
  setupPiperRuntime, uninstallPiperRuntime, piperRuntimeStatus, piperRuntimePaths, readRuntimeRecord,
  detectPython, parsePythonVersion, pythonVersionOk, pythonFixLine,
  PIPER_PYPI_VERSION, MIN_PYTHON, DEFAULT_PYTHON_CANDIDATES,
  type SetupDeps, type SetupResult, type SetupStatus, type RunResult,
  type PiperRuntimeRecord, type RuntimeStatus, type UninstallResult,
} from './tts/piper-setup.ts';
export { FakeTts } from './tts/fake.ts';
export { WhisperStt, WHISPER_MODEL, WHISPER_MODEL_DIR, pickRecorder } from './stt/whisper.ts';
export {
  modelRegistry, downloadModel, modelStatus, specSizeMB,
  type ModelSpec, type ModelFile, type DownloadDeps, type DownloadResult, type DownloadStatus,
} from './download.ts';
export { AppleStt, ensureHelper } from './stt/apple.ts';
export { FakeStt, type FakeSttScript } from './stt/fake.ts';
