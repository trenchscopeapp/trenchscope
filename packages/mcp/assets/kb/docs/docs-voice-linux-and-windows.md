---
id: docs-voice-linux-and-windows
title: Jarvis voice mode › Linux and Windows
kind: docs
page: voice
page_title: Jarvis voice mode
heading: Linux and Windows
anchor: linux-and-windows
url: https://dexterm.xyz/docs/voice#linux-and-windows
tags:
  - docs
  - voice
  - linux
  - windows
  - jarvis
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/voice.md
date: 2026-10-16
---

**Linux is beta (since 0.1.2); Windows voice input is not built.** macOS is the platform voice mode was built and measured on. Off macOS the engines below exist on main, but no person has yet verified real speaker or microphone I/O on Linux hardware. Treat Linux voice as beta. Every voice action has a keyboard equivalent.

- **Speech out (Linux).** The neural Piper engine is the default when its prebuilt binary and the `en_GB-alan-medium` voice are installed (`dexterm voice download piper-voice` fetches the voice from Hugging Face, asks first and checks a pinned checksum). `espeak-ng` is the fallback. Both play their WAV through `aplay`, `paplay` or `ffplay`. Synthesis to WAV is verified in Docker on Linux, but real speaker output is not covered by the test suite. `dexterm doctor` names what is missing. Don't use `apt install piper`, which installs an unrelated tool.
- **Speech in (Linux).** Apple Speech is macOS-only. The local whisper.cpp engine (`dexterm voice download whisper` fetches its `base.en` model) records with `sox`, `arecord` (alsa-utils) or `ffmpeg -f alsa`. Real microphone capture on Linux is not yet verified on hardware.
- **Windows.** Untested. `espeak-ng` or Piper may speak through `ffplay`, but microphone capture has no Windows-specific input (the `ffmpeg` capture uses a macOS or Linux device), so treat push-to-talk on Windows as not built.
- **Unchanged everywhere.** The router, the clarify-never-guess rules and the hard limits above are platform-independent. Another platform adds engines, not powers: voice can never confirm, sign, flip LIVE or raise a cap.
