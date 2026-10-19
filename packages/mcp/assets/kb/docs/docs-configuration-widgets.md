---
id: docs-configuration-widgets
title: Configuration and files on disk › Widgets
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Widgets
anchor: widgets
url: https://dexterm.xyz/docs/configuration#widgets
tags:
  - docs
  - configuration
  - widgets
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

A pack widget is an html page the popup host serves in a loopback HUD window, the same window technology as the popup chart (https://dexterm.xyz/docs/popup-chart). It is the only way third-party UI gets into dexterm, and it is small on purpose: a widget can **receive and render**; it cannot fetch, import, run anything in the terminal process, or send anything but close / focus / drag.

- `widgets/<name>/widget.json` declares pages and their topics, a subset of `rows · token · narrative · positions · alerts · theme`: the screener's public columns, the open coin, the narrative board, your positions (symbol, size, PnL), the alert log, the theme. Nothing in a view model names a key, a signer, a cap, a mandate or the gate; pair / source ids and provenance internals are not sent.
- The window is two documents: the host's own wrapper page (it owns the connection to the terminal, the title strip and the close button) and, inside it, the pack page in a sandboxed frame. The pack page runs under a hash-only CSP: the html is served exactly as installed (nothing is substituted into it, there is no nonce), and every inline `<script>` and `<style>` block runs because its sha256 is in the header — only the text you read before enabling the widget. It has no network of its own at all (no fetch, no socket, no remote scripts, styles, images or fonts), no cookies or storage (an opaque origin), no inline handlers, no eval, no runtime script injection where the engine supports Trusted Types, and no way to navigate anywhere: a document may always navigate itself, which a sandbox alone cannot stop, so the wrapper's `frame-src` names the one document the frame may show and the engine refuses any other before a request exists — the wrapper then closes the widget and logs why. Verified in headless Chromium and WebKit. One kind of connection no content-security directive covers — a `<link rel=preconnect>` built at run time makes WebKit open a bare TCP connection to a host and port the page chose — so the SDK, which runs first in the frame, seals the DOM: the insertion methods, every HTML-parsing entry point (the static `Document.parseHTMLUnsafe` included), `adoptNode` / `importNode`, the element-taking setters and WebRTC are locked on the prototypes before any pack script runs, a click on a link that targets another window (and any form submit) is cancelled before the engine can open a connection for it, a MutationObserver closes the widget if a loader element ever appears anyway, and none of it depends on Trusted Types, which the system WebKit of macOS 14 and 15 lacks (verified inside the real native shell on that WebKit, and in headless Chromium and WebKit with Trusted Types stripped, with a raw TCP sink). Widgets open only in the native popup shell (macOS 14 or newer), whose windows are routed through a loopback sink proxy of the host's as a further backstop for named hosts. A page that carries a loader (`<script src>`, `<link>`, a frame, `<meta http-equiv>`, `@import`, or a `__NONCE__` placeholder) is refused at install, again at open and again when the host issues the window's ticket. A frozen `dexterm` object is injected ahead of the pack markup: `dexterm.on(topic, fn)`, `dexterm.theme` (also CSS variables), `dexterm.close()`, `dexterm.log()`; the frame can say only ready / log / close back, and the terminal's socket accepts nothing but the generic events from a widget.
- Consent is yours and re-checked: a widget installs disabled; `dexterm pack widget <pack> <name> --enable` after you read the page; at every open the app re-hashes the installed pack and refuses a page edited since. A workspace can list a widget popup (`{ "kind": "widget", "widget": "<pack>/<name>" }`) but cannot enable it.
- **Beta.** One example widget (`packs/example-widgets`, the MOVERS tiles), a popup window only. The in-process plugin sandbox from the design (terminal columns and panels, host-mediated fetch, per-plugin storage) is not built. API and limits: `packages/popup/WIDGETS.md` in the repo.
