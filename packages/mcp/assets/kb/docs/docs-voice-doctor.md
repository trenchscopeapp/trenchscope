---
id: docs-voice-doctor
title: Jarvis voice mode › Doctor
kind: docs
page: voice
page_title: Jarvis voice mode
heading: Doctor
anchor: doctor
url: https://dexterm.xyz/docs/voice#doctor
tags:
  - docs
  - voice
  - doctor
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

`dexterm doctor` has a voice section. When the neural voice is set up it shows `Voice out (Piper)` as the default with `Voice out (say, fallback)` beneath it; when it is not, it shows `Voice out (say)` plus a `Neural voice (Piper)` hint whose fix is `dexterm voice setup`. It also shows `Voice in (Apple Speech)` or `Voice in (whisper)` and a mic-capture note. Every line is a warning at worst and voice degrades to text; the doctor never fails because of voice. `dexterm voice status` shows the same engine summary and which models are installed.
