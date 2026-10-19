---
id: docs-voice
title: Jarvis voice mode
kind: docs
page: voice
page_title: Jarvis voice mode
url: https://dexterm.xyz/docs/voice
tags:
  - docs
  - voice
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

Push-to-talk on v, an instant local command path, Claude for analysis, spoken replies, popups. Voice only ever proposes; it can never confirm, sign, flip LIVE or raise a cap.

`v` is push-to-talk. Press it once and the mic opens (a red `● LISTENING` badge sits on the band under the header the whole time it is live); say what you want; press `v` again to send. The first press enables voice for the run and asks macOS for Microphone and Speech permission. Everything is free and local: speech-out is the neural Piper voice once it is set up (otherwise the built-in `say`), speech-in is on-device Apple Speech (compiled once with `swiftc`) or a local whisper.cpp `base.en` model, and the only model in the loop is your own `claude` login, for analysis questions. No paid speech API exists in the code, no key is read, nothing is recorded to disk.
