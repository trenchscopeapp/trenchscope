---
id: docs-popup-chart-security-model
title: Popup chart › Security model
kind: docs
page: popup-chart
page_title: Popup chart
heading: Security model
anchor: security-model
url: https://dexterm.xyz/docs/popup-chart#security-model
tags:
  - docs
  - popup-chart
  - security
  - model
  - popup
  - chart
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/popup-chart.md
date: 2026-10-16
---

- The server binds **127.0.0.1 only** on a random port. LAN, Tailscale and `::1` are refused; a strict `Host` check guards against DNS rebinding and a strict `Origin` check guards the WebSocket; no CORS header is ever sent.
- Every popup opens with a **single-use ticket** (32 random bytes, 30 s). The page it buys embeds a one-time WebSocket token. The native shell receives the URL over stdin, never argv. The browser fallback necessarily passes the URL to `open`, so it is briefly visible in `ps` to another local user; the worst case there is a failed window, never a key or a trade.
- All script and style on the page is inlined under a CSP nonce; the vendored chart library is the one static file the server answers (exact path, from memory); `img-src` is none; the shell denies new-window requests and pins every navigation to the exact loopback origin (parsed, not string-prefixed).
- Popups receive **view models and theme tokens only**: never keys, signer state or trade capability. Messages from the popup are checked against a closed set of UI event names and payload values (the six intervals, known indicator ids); anything else is dropped, reported to the terminal as `popup.dropped`, and never echoed.
- Untrusted strings (token name, symbol, address) are rendered with `textContent` only; a hostile token name never reaches the page HTML.

A ported attack suite (50 probes: traversal, wrong Host, other methods, WebSocket abuse, bad payloads) runs against the in-app server in the test suite.
