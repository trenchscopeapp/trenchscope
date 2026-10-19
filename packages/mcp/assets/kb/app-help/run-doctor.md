---
id: run-doctor
title: Diagnose problems with doctor
kind: app-help
screen: all
feature: doctor
tags:
  - app-help
  - doctor
  - diagnose
  - check
  - troubleshoot
  - broken
  - fix
  - problem
commands:
  - doctor
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

`trenchscope doctor` is the first stop for any problem: non-interactive, never touches your keys, exits 0 when trenchscope will run and 1 when something must be fixed. Every non-pass line prints the exact fix. `trenchscope doctor --offline` skips the network probes.

CLI: `trenchscope doctor`.
