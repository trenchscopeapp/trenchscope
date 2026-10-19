---
id: dev-history
title: Check if a coin's creator rugged before (dev history)
kind: app-help
screen: token
feature: token-intel
tags:
  - app-help
  - dev
  - deployer
  - creator
  - serial
  - rugger
  - rugged
  - history
  - launches
tools:
  - dev_history
  - get_dev_history
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

The token screen's ON-CHAIN panel shows the creator's recorded track record (0.1.5): `Dev rugs (recorded)` (rugs out of labelled prior launches, with the sample n), `Dev launches seen`, `Dev sold its bag` (median minutes to the dev's exit) and `Dev linked` (funder or cluster from the wallet-intel scan). It comes from dexterm's own local history recorder (keyless creator links + code-only outcome labels), so it says `unknown` when there is no record; it is a risk flag from observed history, never a certificate. Alert on it with the rule field `devrugs`, e.g. `when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs`. Agents and the analyst use the `dev_history` MCP tool.
