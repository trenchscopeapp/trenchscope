---
id: docs-agents-untrusted-by-default
title: Bring your own agent › Untrusted by default
kind: docs
page: agents
page_title: Bring your own agent
heading: Untrusted by default
anchor: untrusted-by-default
url: https://dexterm.xyz/docs/agents#untrusted-by-default
tags:
  - docs
  - agents
  - untrusted
  - default
  - bring
  - own
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

Every agent is treated as potentially compromised or buggy:

- **Per-agent identity.** A salted-hashed bearer token (shown once, stored only as a hash, constant-time verified); rotate or remove it to revoke instantly. One agent can never wear another's name.
- **The gate.** One function every call passes on every transport: session open, name not on the never-list, tier sufficient, inside any mandate, arguments valid against a **closed** schema and within a size cap, rate limits and quotas with room, and an idempotency key on every proposal.
- **Rate, quota and flood control.** Reads/min, navigation/10s and proposals/hour are per agent; sustained refusals trip a breaker that auto-pauses the agent.
- **Prompt firewall.** Every untrusted string an agent receives (token names, bios, tweets, fetched page text) is wrapped and sanitised; terminal-escape, bidi-override and zero-width characters are stripped from every result, event and audit line.
- **Proposals, never actions.** An order-plan proposal is a draft with `armed: false`, full stop; only your physical keypress arms it, and the signer-side caps still apply.
- **Roster + audit.** The roster popup lists every connected agent (name, tier, last activity, reads/proposals, rate usage) with per-agent **pause** and **kick**, and the full audit log records every connect, call, refusal, proposal and disconnect.
- **Watching adds no power.** The spectator view (https://dexterm.xyz/docs/spectator) only observes calls the gate already allowed or refused; its stream has no inbound command path and its window can send only pause, resume, take over and kill.
