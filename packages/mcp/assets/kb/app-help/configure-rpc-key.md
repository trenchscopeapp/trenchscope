---
id: configure-rpc-key
title: Configure a Helius / RPC key for holders
kind: app-help
screen: all
feature: keyless
tags:
  - app-help
  - helius
  - rpc
  - key
  - holders
  - free
  - api
  - ranked
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

trenchscope is free-forever and keyless by default. The one real keyless gap is the ranked top-holder list: add a free RPC key for it. Save a Helius key ONLY at `~/.dexterm/helius.key` (mode 600, never a repo or command line), or set `DEXTERM_RPC_URL` to any read-only RPC. `trenchscope doctor` prints the exact command. Without a key the holders panel shows count + top-10% via Jupiter.
