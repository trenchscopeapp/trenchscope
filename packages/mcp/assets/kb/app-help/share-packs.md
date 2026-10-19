---
id: share-packs
title: Share or install packs (trenchscope pack)
kind: app-help
screen: all
feature: packs
tags:
  - app-help
  - pack
  - packs
  - share
  - install
  - export
  - sign
  - trust
  - lock
  - bundle
commands:
  - pack
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

`trenchscope pack list|verify|add|remove|export|lock|sign|trust|signers|keymap|widget` shares themes, keymaps, rules and widgets as plain files with a sha256 lock and an optional ssh signature. A pack never runs code: widgets land disabled, unsigned rules load disabled, and a keymap merges only on the explicit command.

CLI: `trenchscope pack`.
