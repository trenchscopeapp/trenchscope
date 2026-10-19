---
id: docs-voice-latency
title: Jarvis voice mode › Latency
kind: docs
page: voice
page_title: Jarvis voice mode
heading: Latency
anchor: latency
url: https://dexterm.xyz/docs/voice#latency
tags:
  - docs
  - voice
  - latency
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

Measured on the development Mac (Intel i7-8700B, 2026-10-10), key-release to first spoken word, excluding speech-to-text:

| stage | measured |
|---|---|
| router (intent, clarify, provenance gate) | 0.01 ms median |
| `say` first audio | 0.8 ms median |
| Piper neural first audio, model pre-warmed (voice on) | ~0.18 s (cold, first-ever reply: ~1.7 s) |
| instant command path (router + say) | under 1 ms |
| Claude first token (warm `claude -p`, model only) | 3.1 s |
| Apple Speech helper, cached lookup | 0.2 ms; a one-time 4.1 s `swiftc` compile on first use |
| whisper `base.en` on a 2.3 s clip (CPU batch) | 3.0 to 3.3 s |

Apple Speech streams partial transcripts while you speak, so the perceived speech-to-text delay is well under a second; whisper is a batch fallback and feels like three seconds. Real analyst turns add tool round-trips on top of the first token.
