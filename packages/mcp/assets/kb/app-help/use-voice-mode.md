---
id: use-voice-mode
title: Use voice mode (Jarvis, push-to-talk)
kind: app-help
screen: all
feature: jarvis
tags:
  - app-help
  - voice
  - jarvis
  - talk
  - mic
  - microphone
  - push
  - listen
keys:
  - v
actions:
  - voice.talk
flags:
  - --sound
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Press `v` to start push-to-talk: speak, press `v` again to send (a red ● LISTENING badge shows while the mic is live; it also auto-closes after 15 s). Instant commands ("show the runners", "open bonk", "filter liquidity over 50k") run locally; questions go to `claude`. Voice only PROPOSES trades — it can never confirm, sign, arm or raise a cap. macOS only; every voice action also has a key. `--sound on|off` sets the sound/voice output at launch.

Keys: `v`.
