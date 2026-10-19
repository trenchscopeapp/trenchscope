---
id: login-with-x
title: Connect your X account (trenchscope x)
kind: app-help
screen: all
feature: login-with-x
tags:
  - app-help
  - x
  - twitter
  - login
  - oauth
  - account
  - social
  - connect
  - client
commands:
  - x
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

`trenchscope x status|set-client-id|login|logout` connects your X (Twitter) account via OAuth2 PKCE on a loopback callback. Tokens stay in `~/.dexterm/x` (0600), are never printed, and the scopes are read-only. It only improves social signal; nothing is posted.

CLI: `trenchscope x`.
