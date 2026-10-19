---
id: docs-spectator-security-model
title: Spectator view (watch the agent cook) › Security model
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: Security model
anchor: security-model
url: https://dexterm.xyz/docs/spectator#security-model
tags:
  - docs
  - spectator
  - security
  - model
  - view
  - watch
  - agent
  - cook
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

- **Loopback only.** The stream binds `127.0.0.1` on a random port and refuses any connection whose remote address is not loopback. It never binds a LAN address or `::`.
- **Per-session token.** 32 random bytes, generated when the stream starts, compared in constant time, stored in `~/.dexterm/spectator.json` (0600) and never passed as an argument. A connection without the token in its first 10 seconds is closed.
- **No inbound command path.** The stream server holds only the event hub. It has no reference to the bus, the agent registry, the tool executor or any control, so no code path leads from the socket to anything that can change state. A test sends `tools/call`, `pause` and `roster.kick` at it and checks that the bus is untouched and the socket only ever sent events.
- **The window uses the popup host's security unchanged**: a single-use ticket and a one-time WebSocket token per window, loopback bind, strict Host and Origin checks, a nonce CSP, and an allow-list that admits only the four `spectator.*` control events. Every string is drawn as text, never as HTML.
- **Agents stay untrusted and cannot sign.** The spectator view only observes calls the gate already allowed or refused. No agent at any tier has a tool that can arm, sign, confirm, send, raise a cap, change the gate or touch a wallet, a mandate or the signer, and the spectator view adds no event or control that could. Watching an agent never gives it more power.

The trust page (https://dexterm.xyz/trust/#spectator) has the short version.
