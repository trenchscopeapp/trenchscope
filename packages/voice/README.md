# @dexterm/voice — JARVIS voice mode (task-1282)

Free and portable by requirement: no paid speech APIs, no shipped keys. Everything here either ships
with macOS or runs locally with no key. If a component is missing, `dexterm doctor` says exactly what
to install and voice **degrades to text** — it never crashes.

## Pieces

- `router.ts` — deterministic, LLM-free intent router. The safety contract: voice can ONLY ask the
  analyst or trigger the analyst's safe actions (navigate, open a token, set a filter, add to the
  watchlist, or OPEN a PAPER ticket in its editing phase). It can **never** confirm, sign, or execute
  a trade. `isSafe()` + its test assert this for every utterance.
- `stt/` — speech-in engines: `apple` (on-device `SFSpeechRecognizer` via a Swift helper compiled with
  `swiftc`, no key, streaming, macOS only), `whisper` (whisper.cpp `base.en`, local, no key — the
  DEFAULT voice-in off macOS; never `large-v3-turbo` on a CPU-only Mac: ~55–93 s/clip; mic capture via
  `rec`/`sox`, `arecord` on Linux, or `ffmpeg`), and `fake` (scripted, for headless tests).
- `tts/` — speech-out engines: `piper` (Piper neural voice, local, no key — the PREFERRED/default engine
  EVERYWHERE it is installed, on macOS as well as off; synthesises WAVs played through `afplay` on macOS
  or `aplay`/`paplay`/`ffplay` off macOS, kept pre-warmed so the first word starts in ~0.2 s; task-1416),
  `say` (built-in macOS `say`, no key, interruptible, voice picker — the macOS fallback), `espeak`
  (espeak-ng, the portable last-resort baseline off macOS), and `fake`. Every engine shares one contract:
  untrusted text is sanitised, delivered on stdin, one speak queue (never two voices), and a macOS voice
  name is never passed verbatim to Piper/espeak.
- `tts/piper-setup.ts` — the managed macOS Piper runtime (`dexterm voice setup` / `uninstall`): a private
  virtualenv at `~/.dexterm/piper/venv` with `pip install piper-tts` (the prebuilt macOS tarball from
  rhasspy is broken — it needs a libespeak-ng dylib it does not bundle — so we run `python -m piper`),
  plus the voice model. Confirmation-gated, offline after setup, no key, needs Python 3.9+. All
  system/network effects are injected so it is unit-testable.
- `download.ts` — the checksum-verified, confirmation-gated downloader for the two optional models
  (whisper `base.en`, the Piper voice). Nothing is fetched without an explicit yes.
- `summary.ts` — the first ~2 sentences of an analyst answer, for the spoken reply.
- `controller.ts` — the push-to-talk state machine (toggle; terminals have no key-up). The mic is live
  ONLY in the `listening` mode — the single place `listen()` is called — so the on-screen indicator can
  never disagree with the real mic. Interruptible speech, mute, voice picker, and key-release →
  first-spoken-word latency capture.
- `doctor.ts` — the voice checks `dexterm doctor` renders (warn-only; never fails the doctor).

## In the app

- `v` — push-to-talk (press to talk, press to send; auto-enables voice on first use).
- `m` — mute · `,` — change voice · `esc` — stop speaking / cancel listening.
- A red `● LISTENING` badge on the band under the header whenever the mic is live.

## The neural voice (macOS + Linux)

The Piper neural voice (en_GB-alan-medium) is the default speaking voice wherever it is installed.
- **macOS:** `dexterm voice setup` builds the managed runtime (venv + model) and Piper becomes the default
  automatically, with `say` as the fallback. First word starts in ~0.2 s thanks to a pre-warmed standby
  process; measured on an Intel Mac: warm 179 ms, cold 1.7 s (task-1416).
- **off macOS:** install the rhasspy/piper prebuilt binary into `~/.dexterm/piper/` and run
  `dexterm voice download piper-voice`.

## Models

whisper `base.en` and the Piper voice are not shipped (free-forever: no bundled large binaries, no keys).
`dexterm doctor` reports each engine's real status and how to install it, `dexterm voice setup` installs
the neural voice on macOS, and `dexterm voice download <whisper|piper-voice>` fetches a model from the
official source — only after an explicit yes, and only if it matches the checksum pinned in `download.ts`.
On Debian, do NOT `apt install piper` (that is an unrelated gaming-mouse tool); the Piper TTS binary is
the rhasspy/piper prebuilt release, and whisper.cpp is not packaged either — use its prebuilt release.
Real speaker/mic I/O on Linux is not covered by the test suite; synthesis-to-WAV and whisper transcription
are verified in Docker (task-1408) and, for the macOS venv runtime, on a real Mac with afplay + whisper
(task-1416).

## Latency

`node packages/voice/tools/voice-bench.mjs [--real-claude] [--recompile]` measures the key-release → first-word
budget. Router and `say` are measured live; STT numbers come from the spike (no headless mic). See the
task-1282 handoff for a full table.

## Privacy

Nothing is recorded to disk unless `DEXTERM_VOICE_RECORD=1`. The whisper path writes a transient WAV to
the OS temp dir and deletes it immediately after transcription; Apple Speech keeps no file. Transcribed
text is treated as untrusted user input, like any typed text.
