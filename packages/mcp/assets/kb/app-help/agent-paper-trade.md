---
id: agent-paper-trade
title: Let an agent paper trade
kind: app-help
screen: all
feature: mcp
tags:
  - app-help
  - agent
  - mcp
  - paper
  - autonomous
  - experimental
  - confirm
  - close
  - simulated
flags:
  - --agent-paper
tools:
  - paper_open_ticket
  - paper_size_ticket
  - paper_confirm
  - paper_close
  - paper_positions
  - paper_pnl
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

Experimental, paper only, off by default. Arm a mandate yourself (its caps, by keypress), then start `trenchscope --spectate-mcp --agent-paper <mandate-id>`: an agent connected through `trenchscope mcp` can then open, size, confirm and close SIMULATED (paper) trades inside those caps with paper_open_ticket / paper_size_ticket / paper_confirm / paper_close, and read paper_positions / paper_pnl. The agent is untrusted: it can never sign, send a real transaction, touch keys, or raise a cap; its per-trade cap is a quarter of the mandate's, and a size over any cap is refused. Caps are re-read from your armed mandate on every call, so revoking it or the panic key stops the agent. Every call is journaled and shows in this terminal's agent activity; Ctrl+P pauses, Ctrl+K stops for the rest of the run, any key takes over, and quitting turns it off. Figures are simulated and are not a result.
