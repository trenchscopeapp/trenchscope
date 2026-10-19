---
id: docs-agents-agent-paper-trading
title: Bring your own agent › Agent paper trading
kind: docs
page: agents
page_title: Bring your own agent
heading: Agent paper trading
anchor: agent-paper-trading
url: https://dexterm.xyz/docs/agents#agent-paper-trading
tags:
  - docs
  - agents
  - agent
  - paper
  - trading
  - bring
  - own
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

**Status: experimental, paper only, off by default (since 0.1.5).** By default an agent can only read and navigate; it cannot trade at all. If you choose to, you can let an agent you connected over `dexterm mcp` run a full **paper** trade loop inside a **trading mandate** you armed yourself. Nothing here is live: every fill books the **simulated** paper wallet.

Two steps, both yours:

1. Draft and arm a mandate (`dexterm mandate draft` / `arm`, or the plans screen). Its caps are per-trade, per-coin and total size, a loss limit, open positions, price impact, allowed sides and an optional mint allow-list, and arming needs a physical keypress.
2. Start the terminal with the agent activity view and name that mandate: `dexterm --spectate-mcp --agent-paper <mandate-id>`. Quitting turns it off again.

While it is on, the agent can use six tools:

- `paper_open_ticket` opens a simulated ticket for a mint and side. It stays inert until confirmed.
- `paper_size_ticket` sets the simulated size. A buy over any cap is **refused**, never clamped up.
- `paper_confirm` re-checks the caps and your controls, fetches a fresh keyless quote and books the simulated fill.
- `paper_close` closes a fraction of a held simulated position.
- `paper_positions` and `paper_pnl` read the simulated positions and PnL. They are read-only.

The guarantees, each covered by tests:

- **It can never sign or send.** No MCP tool can build, sign or send a real transaction, touch a wallet or key, or change a cap. The paper tools book the simulated ledger only. A registry test enumerates every MCP tool, fails on any tool not on its reviewed allow-list, and checks that the paper path imports nothing that signs, sends or arms.
- **Caps come from your mandate.** The agent's tools never carry caps: on every call the server re-reads the mandate from the hash-chained plans journal you armed it in, and a journal that fails its hash check is refused. That protects the mandate from the agent's tools; it is not tamper-proofing against other software running as your own user. The agent runs at the most restricted confirmation tier, so its per-trade cap is a quarter of the mandate's. Revoking the mandate, letting it expire or pressing the panic key stops the agent on its next call.
- **You stay in control, and you see everything.** Every call and every refusal shows in this terminal's agent activity, labelled PAPER, and is appended to its own hash-chained audit journal. Ctrl+P pauses and resumes, Ctrl+K stops it for the rest of the run, and any key while the agent is driving takes over; all of them halt its paper calls. Trading calls are refused while nothing is watching.
- **Only the agent you connected.** The in-app analyst and the scan never get the paper tools. The loopback agent bus does not offer them either.

Figures are simulated. They are for learning the flow, not a result, and never a prediction or a recommendation. This is not financial advice.
