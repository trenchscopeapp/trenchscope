---
id: getting-started
title: Get started with dexterm
kind: app-help
screen: all
feature: doctor
tags:
  - app-help
  - start
  - install
  - first
  - run
  - setup
  - begin
commands:
  - doctor
flags:
  - --fixtures
  - --calm
  - --version
  - -h
  - --help
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

Run `trenchscope doctor` first: it checks Node, terminal colour, the claude CLI, each data source, the Helius key and a writable data dir, and prints the exact fix for anything not passing. Then run `dexterm` — the first launch shows a one-screen welcome; press any key to enter the live screener. Press `?` on any screen for that screen's full key list. Try `--fixtures` for an offline demo. `--version` prints the version; `--help` (or `-h`) prints usage.

CLI: `trenchscope doctor`.
