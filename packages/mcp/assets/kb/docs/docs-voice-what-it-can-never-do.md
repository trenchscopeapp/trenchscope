---
id: docs-voice-what-it-can-never-do
title: Jarvis voice mode › What it can never do
kind: docs
page: voice
page_title: Jarvis voice mode
heading: What it can never do
anchor: what-it-can-never-do
url: https://dexterm.xyz/docs/voice#what-it-can-never-do
tags:
  - docs
  - voice
  - can
  - never
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

Voice creates proposals only. The ticket it opens is PAPER, in its editing phase, and the keypress gate stands: your `⏎` then `y` (plus the typed-back size above the threshold) is the only way to a fill. Spoken "confirm", "send it", "y", "sign it", "go live", "arm it", "raise my cap", "panic" and "/wallet …" are routed as questions or ignored; they cannot flip the ticket to LIVE, arm a plan, touch the signer's caps, run a wallet command or press anything. The router's output is a closed set of decision kinds, a guard rejects any decision that carries a mode, live, arm, caps, confirm, sign or send field, and an in-app test drives the real key loop with the executor, the confirm paths, the LIVE flip and the wallet commands booby-trapped: twenty-one hostile utterances, zero touches.
