---
id: scan-mode
title: Use AI scan mode
kind: app-help
screen: all
feature: scan
tags:
  - app-help
  - scan
  - watcher
  - observe
  - auto
  - ai
  - monitor
keys:
  - Z
  - R
actions:
  - scan.toggle
  - scan.resume
flags:
  - --scan
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

Scan mode is an observe-only AI watcher (off by default, zero extra requests). Toggle it with `Z` (or `/scan on|off` on the screener line, or `--scan` at launch); `R` resumes a paused scan. It can only surface findings, never take a UI action or trade (structurally observe-only). The analyst can turn it on or off for you.

Keys: `Z`, `R`.
