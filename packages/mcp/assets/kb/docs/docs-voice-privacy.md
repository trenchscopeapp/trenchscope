---
id: docs-voice-privacy
title: Jarvis voice mode › Privacy
kind: docs
page: voice
page_title: Jarvis voice mode
heading: Privacy
anchor: privacy
url: https://dexterm.xyz/docs/voice#privacy
tags:
  - docs
  - voice
  - privacy
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

The Apple path keeps no audio file; the whisper path writes a temporary WAV and deletes it after transcription unless `DEXTERM_VOICE_RECORD=1`. Transcripts are treated as untrusted text: control characters are stripped before anything is drawn, and a voice question is capped at 400 characters like a typed one. Questions sent to the analyst land in your own Claude Code session store, the same as typed questions.
