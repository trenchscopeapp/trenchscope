# Pack widgets — the popup widget API (task-1358 Tier 5)

A **widget** is an html page a pack ships that the popup host serves in a loopback HUD window, fed the terminal's
public view models. It is the only way third-party UI gets into dexterm, and it is deliberately small: a widget can
**receive** and **render**; it cannot fetch, import, load a script or stylesheet from anywhere, execute anything in the
terminal process, or send anything but the generic close / focus / drag every popup has. Exactly the inline
`<script>`/`<style>` text the user read before enabling it is what runs: each block is allow-listed in the page's CSP by
its sha256 (there is no nonce on a widget page — see "What the page cannot do").

Example: `packs/example-widgets/` (MOVERS tiles). Status: **beta** — one example widget, six topics, a popup window
only (no terminal columns or panels; the task-1288 plugin sandbox for in-process plugins is not built).

## Where a widget comes from

```
<pack>/
  pack.json                     contents.widgets: ["widgets/<name>"]
  widgets/<name>/widget.json    { name, version, api: 1, widgets: [{ id, title, page, topics[], min? }] }
  widgets/<name>/<page>.html    the page (≤ 512 KB; a plain file inside the widget directory; no symlinks; inline
                                script/style only — see the refusal list below)
```

`topics` ⊂ `rows · token · narrative · positions · alerts · theme` (max 6). `widget.json` has no capability
field: there is nothing to grant. A pack that adds one (`capabilities`, `enabled`, `entry`, …) is refused by name.

Install registers the widget **disabled** (`config.plugins['<pack>/<name>'] = { enabled: false, capabilities: [] }`).
The user enables it after reading the page:

```sh
dexterm pack widget <pack> <name> --enable       # consent; re-checks the pack still hashes to its install record
```

Open it from a workspace (`{ "kind": "widget", "widget": "<pack>/<name>[/<id>]" }` in `popups`, then `ctrl+w o`) or
start with `--workspace <pack>/<workspace>`. At open time the app re-checks: enabled, pack integrity (sha256 lock vs
the recorded hash), the page is a regular file under the widget directory, size. A page edited after install is
refused with the reason.

## What the page gets

The server inlines the SDK (`src/pages/widget-sdk.js`) into the frame document's `<head>` ahead of the pack's own markup
(allow-listed by its hash like every other block), and defines one frozen global:

| | |
|---|---|
| `dexterm.on(topic, fn)` | `fn(payload)` on every push of a declared topic; the current value is replayed to a late listener |
| `dexterm.off(topic, fn)` | |
| `dexterm.theme` | the terminal's theme tokens; also set as CSS variables `--bg --panel --border --borderFocus --text --muted --dim --accent --up --down --warn --ai --pump --dbc` |
| `dexterm.topics` · `dexterm.key` | the declared topics; `<pack>/<widget>/<id>` |
| `dexterm.close()` | ask the terminal to close the window (Esc does the same) |
| `dexterm.log(text)` | a line in the terminal's popup log (sanitised there, 200 chars) |

Payloads (`src/protocol.ts`): `rows` → `WidgetRowsVM` (the screener's public columns: symbol, name, mint, launchpad,
price, mcap, liq, vol5m/1h/24, chg, ageMin, holders, org, top10, flags, verified; ≤ 200 rows); `token` →
`TokenDetailVM` (the open coin; nothing until one is open); `narrative` → `NarrativeBoardVM`; `positions` →
`WidgetPositionsVM` (paper + live rows: symbol, mint, tokens, value, unrealised; no fills, no caps); `alerts` →
`WidgetAlertsVM` (rule fires/proposals + the alert log); `theme` → `ThemeTokens`. Pushes are throttled to one per
second per widget + topic; `rows` changes every 10 s with the feed.

Nothing in a payload names a key, a signer, a cap, a mandate or the gate (`widgets.ts` refuses to push a payload
whose keys look money-shaped, as a last line). Pair/source ids and provenance internals are not included.

## What the page cannot do

A widget window is **two documents** (r3). `/popup/widget` is the host's own **wrapper** page — rendered under the same
nonce CSP as every built-in popup; it owns the WebSocket, the title strip, the close button and Escape — and it holds the
pack page in `<iframe sandbox="allow-scripts">`. The wrapper's CSP names exactly one document the frame may ever show:
`frame-src http://127.0.0.1:<port>/popup/widget-frame`. `/popup/widget-frame?f=<one-shot token>` is the pack page: served
**byte-verbatim** (CR LF → LF only, as the parser itself does — the server substitutes nothing into it, no nonce, no token,
no placeholder of any kind, so nothing an author writes can borrow a value from the host), with our `<head>` (the widget
key, its topics, the host origin, and the SDK) spliced in ahead of the pack markup, under a **hash-only** CSP:
`default-src 'none'; script-src 'sha256-<SDK>' 'sha256-<each inline script>'; style-src 'sha256-<each inline style>' |
'none'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors http://127.0.0.1:<port>; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none';
sandbox allow-scripts`. View models travel wrapper → frame by `postMessage` (the SDK accepts them only from its parent
window at the host origin); the frame can say only `ready`, `log`, `close` back, and the wrapper forwards only those. So:

- write plain `<script>` and `<style>` tags: each block runs because its exact text is in the hash list, and only
  those blocks run. There is no nonce to write and none to steal (`script.nonce` is readable by same-document
  scripts; a hash cannot be borrowed by another tag). `'strict-dynamic'` is never set, so a script a hashed script
  inserts at runtime has no authorisation; an external script can never match a hash;
- a page that carries a **loader** is refused — at install (`dexterm pack add`/`verify`), again at open and again
  when the host issues the ticket (`src/widget-html.ts`): the `__NONCE__` token, `<script src|href|xlink:href>`, any
  `<link>`, `<iframe>` / `<frame>` / `<embed>` / `<object>` / `<base>`, `<meta http-equiv>`, `@import` (or an escaped
  `@\…`), more than 64 inline blocks. (Comments are not read; a `<style>` block is.)
- **the page cannot navigate anywhere.** A document may always navigate *itself* — `sandbox` only stops it navigating
  other browsing contexts, `form-action` / `base-uri` do not cover it, and CSP `navigate-to` never shipped — which is
  why the pack page is a *nested* document: the **parent's** `frame-src` governs every navigation of the child, whoever
  initiates it, and it allows one exact path on our origin. `location.href = 'https://…'` (or to any other route of
  ours) is refused by the engine before a request exists; the wrapper hears the `frame-src` violation, drops the frame,
  logs `widget <key> blocked: …` to the terminal and closes the window. A second frame `load` alone is not treated as a
  navigation (r6: WebKit fires one for an in-page `#fragment` link too) — the wrapper pings the document and closes the
  widget only when our SDK does not answer. Verified in headless
  Chromium and WebKit (internal evidence, task-1358 r3); the native shell additionally pins every
  navigation to the loopback origin (`nav_allowed`);
- **the page has no network.** `connect-src 'none'` (no fetch, XHR, beacon, EventSource, WebSocket, WebTransport — not
  even ours; the wrapper holds the socket and its token, and no token, popup id or port is in the frame document), no
  images, fonts or media from anywhere, and the sandbox has no `allow-popups`, `allow-forms`, `allow-downloads`,
  `allow-top-navigation`: `window.open`, a form submit, `<a target=_top>` and `top.location =` are all refused. Three
  connections CSP has **no directive for** are closed by the SDK's seal (next bullet): a runtime
  `<link rel=preconnect|dns-prefetch>` — which makes WebKit resolve a name and open a bare TCP connection to a host:port
  the page chose, with nothing fetched (the r3 verifier's finding); WebRTC; and (r6, the fifth verifier's finding) a
  **click on a link that targets another window** — `<a target=_blank>` script-clicked makes WebKit open a bare TCP
  connection to the link's host:port before the sandbox refuses the popup. The seal cancels every click / auxclick whose
  path holds a link with a target other than `_self`, a `download` or a `ping`, and every form submit, in a capture-phase
  listener on `window` that runs before anything a pack registers and that nothing can remove; shadow roots are forced
  open so a link cannot hide from it;
- **the DOM is sealed (r4).** The SDK is the first script of the frame document and the page cannot obtain a second
  realm (a nested frame is created but sealed off from it by the sandbox — both frames have opaque origins — and every
  HTML-parsing sink is a Trusted Types sink), so before any pack script runs the SDK replaces the DOM's insertion
  methods on the prototypes (`appendChild` / `insertBefore` / `replaceChild`, `append` / `prepend` / `replaceChildren` /
  `moveBefore`, `before` / `after` / `replaceWith`, `insertAdjacentElement`, `Range.insertNode` / `surroundContents`) with
  non-writable, non-configurable guards that refuse any node whose subtree holds a **loader** (`link`, `meta`, `base`,
  `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `portal`, `fencedframe`, `script`) — however it was made:
  `createElement`, a fragment, a shadow root, a template clone, `adoptNode` / `importNode` from `createHTMLDocument`, a
  custom element extending `HTMLLinkElement`, SVG `foreignObject` —, makes every HTML-parsing entry point throw outright
  (`innerHTML` / `outerHTML` setters, `insertAdjacentHTML`, `document.write` / `writeln` / `open`, `setHTML`,
  `setHTMLUnsafe`, `createContextualFragment`, `DOMParser`, XSLT, and — r5 — the **static** `Document.parseHTMLUnsafe` /
  `Document.parseHTML` and `document.execCommand`), guards the other doors a node from a foreign document can come
  through (r5: `adoptNode` / `importNode`, the element-taking setters `table.caption` / `tHead` / `tFoot`,
  `document.body`, `select.add`, `options.add`), cancels activations that target another window (r6, previous bullet),
  forces every shadow root open, and removes `RTCPeerConnection`. The natives live only in the SDK's closure: `delete`,
  `defineProperty` and `setPrototypeOf` do not recover them. A MutationObserver is the belt behind all of it: if a
  loader element (a `<meta>` only with `http-equiv` — a plain meta the parser reaches after the SDK is harmless) ever
  becomes part of the document anyway, it is removed and the wrapper closes the widget (after the fact, so a belt — the
  guards are the control). Ordinary DOM work (`createElement` + `textContent`,
  `append` of text and elements, `caption` / `select` of honest elements, CSSOM, `style`) is untouched. **The seal does
  not depend on Trusted Types**: the system WKWebView on macOS 14/15 (WebKit 605, Safari < 26) has none, and that is
  the shipping configuration — verified on it directly (`handoffs/task-1358-r5-evidence/shell-seal.mjs`: 35 vectors
  inside the real native shell, `tt=false`, 0 connections to a LAN and a loopback sink, 0 loader elements, data path
  intact), in headless Chromium 151 and WebKit 26.5 with the Trusted Types directives stripped from the CSP
  (`seal-probe-v2.mjs`), and against the fourth verifier's own bypass (`verifier-bypass.mjs`, 0 hits). The frame tells
  the wrapper whether the Trusted Types API exists (`ready.tt`); the wrapper shows `live · no Trusted Types` and logs it;
- **the native shell adds a sink proxy (r4, macOS 14+).** The shell routes every WebView connection through a loopback
  proxy of the host's (`src/sinkproxy.ts`, `DEXTERM_POPUP_PROXY`) that tunnels only to the popup server's own origin and
  answers everything else 403, reporting the target to the terminal (`proxy.refused`). Measured on macOS 15:
  WKWebView sends **named** hosts through it (`CONNECT host:port`) but connects to IP literals — loopback, LAN, and so
  presumably any — directly, so the proxy is a backstop for named destinations, not the primary control (the seal is).
  Widgets open **only** in the native shell, and only once the shell has confirmed the proxy (`shell.ready.sink_proxy`);
  under the browser fallback `open({ kind: 'widget' })` is refused with the reason;
- **the page has no identity.** No `allow-same-origin`: the frame runs in an opaque origin — no cookies, no storage, no
  reach into the wrapper's DOM or its socket (`parent.document` throws), and `postMessage` to the wrapper carries only
  `ready` / `log` (200 chars, sanitised in the terminal) / `close`; anything else it posts is ignored by the wrapper and
  never reaches the socket, whose server side also accepts nothing but the generic `ready`, `perf`, `log`,
  `popup.close-request`, `popup.focus`, `popup.drag` from a widget — never a roster, plan or chart event. A widget
  cannot propose, annotate, open a ticket or navigate the terminal: those have no message at all;
- inline handlers (`onclick=`) do not fire; `script.src =`, `eval` and the HTML sinks throw under Trusted Types where
  the engine has them (Chromium; the Safari 26 engine) — the system WKWebView of macOS 14/15 does not, and there the
  hash list alone decides what runs while the DOM seal refuses every HTML-parsing entry point itself;
- the html cannot change headers; the wrapper ticket, the WebSocket token and the frame token are each single-use
  (30 s); the frame route answers only an `iframe` fetch from our own origin (`Sec-Fetch-Dest` / `Sec-Fetch-Site`
  where the engine sends them — every current one does) and never a top-level open; and the page only ever sees
  what was pushed to it.

Render every untrusted string (symbols, names, alert text) with `textContent`, never `innerHTML` (which is also
what Trusted Types enforce).

## Honest residual

A widget sees the public market rows, the open coin, the narrative board, the user's positions (symbol, size, PnL)
and the alert log: the worst a malicious page can do is *show* them misleadingly inside its own window (the
terminal is untouched). The sandbox is the browser's CSP + the host's allow-list, not an OS sandbox; a WebView bug
would be the escape. Where the WebView lacks Trusted Types (WebKit on macOS, at the time of writing) the runtime
sinks are closed by the hash list alone: an injected inline script runs only if its text is one of the reviewed
blocks, an injected external script only if the engine matches CSP hashes against an `integrity=` attribute (a CSP3
option; if that engine also serves the reviewed text from a foreign URL, the request URL is a channel — Chromium's
Trusted Types close it there). The DOM seal is JavaScript in the page's own realm: it is sound because the page has
no second realm (an engine guarantee we verified) and because every HTML-parsing entry point and every door for a
foreign-document node is enumerated and guarded — that enumeration is the WHATWG set as of 2026 (plus `moveBefore`,
`parseHTMLUnsafe`, `setHTMLUnsafe`); a future API the list does not name would be a hole until added, and the
MutationObserver belt would close the widget after the first such element rather than before it. The fourth verifier
found exactly such a gap (the static `Document.parseHTMLUnsafe` and the element-taking setters), now closed and
covered by the r5 probes. The sink proxy covers named hosts only (measured). The native shell with the proxy needs
macOS 14 or newer (the `mac-proxy` build links Network.framework symbols that older macOS lacks).
Columns/panels inside the terminal, `net.fetch` through the limiter and `storage.kv` from the task-1288 design are
not built.
