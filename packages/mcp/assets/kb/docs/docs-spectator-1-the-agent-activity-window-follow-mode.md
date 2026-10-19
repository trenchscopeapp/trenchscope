---
id: docs-spectator-1-the-agent-activity-window-follow-mode
title: Spectator view (watch the agent cook) › The three surfaces › 1. The AGENT ACTIVITY window (follow mode)
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: 1. The AGENT ACTIVITY window (follow mode)
anchor: 1-the-agent-activity-window-follow-mode
url: https://dexterm.xyz/docs/spectator#1-the-agent-activity-window-follow-mode
tags:
  - docs
  - spectator
  - agent
  - activity
  - window
  - follow
  - mode
  - three
  - surfaces
  - view
  - watch
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

`--spectator-popup` opens the spectator window through dexterm's popup host. It is the docked native window on macOS when the native shell is built, and a browser tab on loopback otherwise, as with the chart popup (https://dexterm.xyz/docs/popup-chart#build-the-native-window). `agent serve` prints which one it opened. The window refreshes once a second and shows:

- **screen**: the screen the agent asked to show (screener, token, watchlist, ticket) with the token, feed, filter and highlight it picked. This line comes from the agent's navigation events. See limits (https://dexterm.xyz/docs/spectator#limits) for what it is not.
- **agents**: each connected agent with an `agent` badge, its tier (`observe`, `annotate` or `propose`), its status (`active`, `paused` or `killed`) and when it last did something.
- **activity**: newest first, up to 80 lines (the window keeps the last 200 events). Each line shows how long ago it happened, the agent, the phase, the tool, a short summary, the time the call took in ms and the age of the data it returned. Refused calls are marked.

| phase | meaning |
| --- | --- |
| `connect` / `disconnect` | an agent opened or closed a session (with its client and any mandate) |
| `result` | a read tool returned (`ok` or an error) |
| `nav` | a navigation tool asked the screen to move (`open_token`, `show_in_screener`, `switch_feed`, `add_to_watchlist`, `open_ticket`) |
| `proposal` | the agent made a proposal you would have to confirm (an alert, an order-plan draft, a watchlist add) |
| `refused` | the gate refused the call, with its reason (`never`, `tier`, `mandate`, `spoof`, …) |
| `note` / `subscribe` | the agent wrote a note, or subscribed to a live stream |
| `control` | you paused, resumed or killed the agent |

**Controls.** Each agent row has buttons:

- **pause**: the gate refuses the agent's next call. The agent stays connected and visible.
- **take over**: pauses the agent and marks you as the driver. The window shows `YOU HAVE TAKEN OVER`, and the agent stays frozen but visible.
- **resume**: shown for a paused agent. Its calls go through again and control goes back to the agent.
- **kill** (the panic button): closes every live session for that agent now and leaves it paused, so a reconnect stays frozen. To revoke the agent for good, run `dexterm agent rotate <name>` or `dexterm agent remove <name>`.

These four are the only messages the window can send, and each carries just an agent name. The `agent serve` process maps them to the bus's own pause, resume and kick, the same controls the roster popup uses, and checks them again before acting. The window has no button, message or path that can arm, sign, confirm, send or raise a cap.
