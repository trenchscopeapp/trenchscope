---
id: setup-neural-voice
title: Set up the neural voice (make it sound better)
kind: app-help
screen: all
feature: jarvis
tags:
  - app-help
  - voice
  - neural
  - piper
  - better
  - quality
  - natural
  - realistic
  - nicer
  - improve
  - install
  - alan
commands:
  - voice
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

trenchscope can speak with a neural British voice (Piper, en_GB-alan-medium) that sounds markedly more natural than the built-in system voices. Run `trenchscope voice setup` to install it: it asks first, builds a private local Python runtime and downloads a ~61 MB checksum-verified voice from the official source, then runs fully offline with no key. Once installed it becomes the DEFAULT speaking voice automatically (the system voice stays as the fallback); `trenchscope voice uninstall` removes it. It needs Python 3.9+ — `trenchscope doctor` prints the exact fix if it is missing, and shows which engine is speaking.

CLI: `trenchscope voice`.
