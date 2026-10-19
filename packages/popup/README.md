# @dexterm/popup

The terminal is the hub; heavy views open as **frameless, transparent, always-on-top HUD windows** served
by a **loopback-only** server inside the TUI. Built from the task-1290 spike (`dexterm/research/popup-host`,
SPEC §8.5), promoted to a real in-app package.

Popups that ship today: a live **chart** (candles for the open token, from the existing data layer; `C` on the token
screen), the **token-detail** HUD (`I` on the token screen, task-1359: identity, market, risk and the wallet-intel
snipers / bundled cells, synced on every token tick), the **feeds** HUD (`M` on the trending screen, task-1359: the
board's posts as the token SOCIAL panel filters them, injection rows withheld, plus the official RSS headlines, newest
first; ⏎ asks the terminal to open item *i* — the mint is resolved terminal-side, the page never holds an address),
the narrative board, order plans, the agent roster, and (task-1340) the **bubble map** (`pages/bubbles.*`: the wallet-intel holder
graph as real circles, hover = rule text, click = `holder.selected` back to the terminal; text-only view model). The window technology is **wry** (Rust `tao` + `wry`, ~1.2 MB);
if it is not built or no display is available, popups fall back to the **OS default browser** and the app
says so (a toast in the terminal AND a banner on the page saying why).

**Pack widgets (task-1358 Tier 5, beta; r3 shape):** a pack may ship an html page the host serves as a `widget` popup —
two documents: our wrapper page (`pages/widget.html`, nonce CSP, owns the socket, `frame-src` = exactly the
`/popup/widget-frame` route) holding the pack page in `<iframe sandbox="allow-scripts">`, served under a hash-only CSP
(no nonce: each inline block is allow-listed by sha256 and the pack html is served verbatim; `connect-src 'none'`, opaque
origin; loaders are refused at install / open / ticket issue — `src/widget-html.ts`) with a small frozen SDK
(`dexterm.on(topic, fn)`, `dexterm.theme`, `dexterm.close()`) that talks to the wrapper by `postMessage`; it receives the
public view models of the topics it declared and can send nothing but ready / log / close. A page that tries to navigate
anywhere is refused by the wrapper's `frame-src` and the widget is closed. (r4) The SDK runs first in the frame and SEALS
the DOM — the insertion methods, the HTML-string sinks and WebRTC are locked on the prototypes — so a runtime
`<link rel=preconnect>` (the bare TCP connection no CSP directive covers) cannot be inserted; widgets open only in the
native shell, whose WebViews are routed through the host's loopback sink proxy (`src/sinkproxy.ts`; macOS 14+). Installed
disabled; the user enables it with `dexterm pack widget <pack> <name> --enable`. API + limits: [`WIDGETS.md`](./WIDGETS.md);
example: `packs/example-widgets/`.

## Chart v2 (task-1325)

The chart page is TradingView's open-source **Lightweight Charts™ 5.2.1** (Apache-2.0), vendored in
`vendor/lightweight-charts/` and served by this package's own loopback server — never a CDN, no network of its
own. It is fed ONLY by the terminal: the open token's cached candle series, its trade tape, and the
task-1323 `PositionSource`. Features: candles ⇄ line ⇄ area (`c`), volume pane (`v`), timeframes 1m/5m/15m/1h/
4h/1d (buttons + keys `1`–`6`, the popup's OWN timeframe, answered from `TokenLive.cachedSeries` — 5m/15m
derived from 1m, 4h/1d from 1h — with no fetch), crosshair OHLCV legend, wheel/pinch zoom, drag pan, auto/log/
percent scale (`a`/`l`/`p`), last-price line + a LIVE price line when the terminal's fast lane streams, buy/sell
markers from the tape (`b`), EMA 9/21 (`e`), VWAP (UTC-day anchored, `w`), volume 20-MA (`m`), horizontal line
(`h`) and trend line (`t`) drawing (`x` clears, Backspace undoes), ● LIVE / ◌ STALE badge (no tick for 20 s),
local-time axis, cyberspace theme from `popupThemeFrom(THEMES.cyberspace)`. When the coin is held: ENTRY line
(size + PnL %), STOP/TARGET lines when set, BUY/SELL fill markers (current position only) and the same
SIDE · SIZE · VALUE · AVG ENTRY · PRICE · UNREALIZED row the terminal shows. **1s is not offered**: the only
trade source is the ≤60-trade GeckoTerminal tape, refreshed at most every 20 s and 1–2 min behind — 1s bars
from it would be sparse, chunky and stale.

**Docking (macOS):** C opens the window flush right of the terminal window (same top + height), left of it when
the right has no room, pinned at the screen edge (on top) when neither side fits, and at the main screen's right
edge when the terminal is not Terminal.app / iTerm2. It follows the terminal (one `osascript` loop, ~0.3 % CPU)
until you drag the chart's title strip. The window opens unfocused, has no Dock icon, and never steals the
terminal's keyboard. `dock.ts` has the details.

## `openPopup` — the interface other lanes reuse

```ts
import { createPopupManager } from '@dexterm/popup';

const mgr = createPopupManager({
  theme,                 // ThemeTokens (map from the active TUI Theme; see cli/src/popup.ts popupThemeFrom)
  rain,                  // PopupRainConfig (from ~/.dexterm/popup.json; configurable cadence)
  hotkey,                // accelerator string, e.g. 'Control+Alt+Super+Shift+KeyB'
  onEvent: (ev) => {},   // ready / perf / popup.event / dropped / closed / probe.rejected
  onWarn:  (m) => {},    // "popups open in your browser: <reason>"
});

const h = await mgr.open({ kind: 'chart', title: 'WIF', data: chartVm });
h.setData(nextChartVm);  // the popup follows the open/highlighted coin
h.close();               // closing a popup NEVER affects the terminal
await mgr.shutdown();     // on quit
```

`open({ kind, route?, url?, title?, data?, geom? })`:

- `kind` — `'chart' | 'token' | 'feeds'`. The server serves the built-in page and pushes `data` over the WS.
- `url` — a fully-formed loopback URL for a **custom** page instead of a built-in kind. This is the hook the
  **trading lane's wallet bridge** uses: render its own loopback connect/sign page in a chromeless window
  instead of the default browser by passing its `url` here (the server does not own that page's data channel).
- `route` — force one of the built-in kinds explicitly.

The same `open(...)` is what **Jarvis** calls ("show me the bubble map for X") — one path, one security model.

`h.native` / `mgr.native` is `true` for a real frameless window, `false` under the browser fallback.
`mgr.hotkeyRegistered` reports whether the shell registered the global hotkey.

## Security model (loopback only, no keys near a popup)

Carried over verbatim from the spike (20/20 protocol tests; re-proven in `test/server.test.ts`):

- The server binds **127.0.0.1 only**, on a **random port**; never `0.0.0.0`/`::`. LAN/Tailscale/`::1` are refused.
- Every popup opens with a **single-use ticket** (32 random bytes, 30 s TTL) in the URL. The page the ticket
  buys embeds a **one-time WS token**; the WebSocket upgrade accepts it exactly once. The TUI hands the URL to
  the shell **over stdin, never argv**, so another local user's `ps` cannot read it.
- **Strict `Host`** (DNS-rebind guard) on every request and **strict `Origin`** on every WS upgrade; the remote
  address must be loopback. **No CORS header is ever set.** Unknown/unauthorised requests get an empty 404 and
  are reported to the TUI as `probe.rejected`.
- All JS/CSS is inlined under a **CSP nonce**; CSP forbids remote content, inline handlers, `eval`, images, fonts.
- Popups receive **view models and theme tokens only** — never keys, signer state, mandates, or trade capability.
  Popup→TUI messages are checked against an **allow-list of UI event names**; anything else (e.g. a `trade.buy`
  dressed as an event) is dropped and reported as `popup.dropped` and never acted on.
- Every untrusted string (token name, symbol, address, feed text) is rendered with `textContent`/`fillText`
  only — never markup. A hostile token name never reaches the page HTML (data travels over the WS, not the page).
- **task-1325:** the server answers exactly ONE static path besides ticketed pages:
  `GET /vendor/lightweight-charts.standalone.production.js` (no query string, read into memory at start —
  never a filesystem lookup, so traversal has nothing to reach; every other path/method/Host is an empty 404).
  `script-src` stays nonce-only: the external `<script src>` carries the page nonce. The chart page's
  `style-src` additionally allows exactly the attribution-logo `<style>` LWC injects, by its sha256 computed
  from the vendored file. Popup → TUI event payloads are validated against closed sets (the six intervals,
  known indicator ids, styles, scales) and rebuilt from the validated fields; junk is dropped as
  `popup.dropped` / `bad-payload` and never echoed (unknown event names are not echoed either). The shell
  also denies `target=_blank` new-window requests. `test/server.test.ts` + `cli/test/measure/popup-v2-1325/
  attack-1325.mjs` (50 probes) cover it.
- **task-1326 coin image:** the chart header's 16 px coin picture is an `<img>` whose source is the TUI's OWN
  loopback route `GET /img/<32 hex>.png` — the terminal's cached, re-encoded thumbnail (never the third-party
  bytes, never a remote URL, so an image host never sees a popup load). `img-src` opens to exactly that path
  prefix on our origin (`http://127.0.0.1:<port>/img/`) and stays `'none'` when no image provider is wired; the
  route is exact-match (no query string, lower-case hex only), the key never touches a filesystem path (the
  provider maps it to its cache), and the page ignores any `image` value that is not that shape.
- **Origin pin, parsed not prefixed** (`src/loopback.ts`, mirrored in the shell's `nav_allowed`): a custom
  `url`, the browser fallback's launch, the shell's initial load and every later navigation of a window are
  compared as a parsed URL — scheme `http`, **no userinfo**, hostname exactly `127.0.0.1`, port equal to the
  server's. `http://127.0.0.1:1@evil.example/` (host evil.example, userinfo "127.0.0.1:1"), `localhost`,
  `[::1]`, `127.0.0.1.evil.example`, another loopback port and `https:` are all refused; spellings that
  normalise to our IPv4 (`0x7f.1`, `127.0.0.%31`, `HTTP://`) are our host and pass.

### Browser-fallback caveat

The browser fallback necessarily passes the loopback URL as an argument to `open`/`xdg-open`, so it is briefly
visible in `ps` to another local user. The ticket is single-use and loopback-only, so the worst case is that a
racing local process redeems the ticket first and the window fails to load — it cannot read keys or send trades.
The native shell path does not have this exposure (URL travels over stdin).

## Config — `~/.dexterm/popup.json` (`DEXTERM_HOME` overrides the dir)

Both the global hotkey chord and the rain cadence are configurable; everything is optional and a missing or
malformed file degrades to the spike defaults (never throws).

```jsonc
{
  "hotkey": "Control+Alt+Super+Shift+KeyB",       // show/hide every popup; "" disables; garbage → default
  "hotkeyClose": "Control+Alt+Super+Shift+KeyW",  // close every popup (task-1325)
  "dock": { "enabled": true, "width": 560, "follow": true, "followEvery": 0.5 },  // task-1325
  "rain": { "enabled": true, "speedScale": 1, "density": 0.55 },
  "fpsCap": 60
}
```

## Install / update story

The shell is a tiny Rust binary built once and reused:

```sh
cd packages/popup && npm run build:shell          # cargo build --release → shell/wry/target/release/dexterm-shell-wry (~1.1 MB)
```

- `DEXTERM_POPUP_SHELL` overrides the binary location (a packaged install points it at the shipped binary).
- The dexterm CLI installer (`install.sh`) links `@dexterm/popup` and builds the shell when `cargo` is present
  (`DEXTERM_SKIP_SHELL=1` skips it); without cargo it prints the exact command, and popups use the browser
  fallback until then. `dexterm doctor` shows a **Chart window** line (ready / not built + the fix);
  `dexterm popup --self-test` reports which path is active.
- Updates ride with the dexterm CLI: the shell source lives in this package, so `npm run build:shell` after a
  pull rebuilds it. (Free-forever rule, task-1309: the native window is an *enhancement*; dexterm stays fully
  usable with the browser fallback and needs no paid service.)

## Self-test

```sh
dexterm popup --self-test            # open a chart popup on fixtures; report shell / hotkey / fps
dexterm popup --self-test --browser  # force the browser fallback path
dexterm popup --self-test --seconds 10
```

It does **not** block on a live 60 fps display or a live hotkey press. It reports the shell choice, whether the
global hotkey registered, and the measured frame rate, and clearly labels what still needs a human at an
**unlocked** Mac (confirming 60 fps and pressing the chord). It never claims 60 fps it did not measure.

## Layout

| path | what |
|---|---|
| `src/protocol.ts` | the typed protocol (TUI↔popup, TUI↔shell, server events, PopupHost, openPopup) |
| `src/server.ts` | loopback server: tickets, one-time WS tokens, Host/Origin checks, CSP, event allow-list (own RFC 6455) |
| `src/host.ts` | `ShellPopupHost` (wry) + `BrowserPopupHost` fallback + `createPopupHost` decision |
| `src/open.ts` | `createPopupManager` — the `openPopup` facade (server + window lifecycle) |
| `src/config.ts` | `~/.dexterm/popup.json` loader (hotkey + rain cadence) |
| `src/selftest.ts` | `dexterm popup --self-test` |
| `src/dock.ts` | task-1325: terminal detection, osascript (JXA) probe/follow, placement math |
| `src/pages/` | `common.{js,css}` harness + `chart` / `token` / `feeds` pages (inlined under a CSP nonce); chart v2 adds `chart-lib.js` (pure math, unit-tested via node:vm) and `chart.css` |
| `vendor/lightweight-charts/` | the vendored LWC 5.2.1 build + LICENSE + NOTICE + VERSION + provenance |
| `shell/wry/` | Rust `tao`+`wry`+`global-hotkey` shell; chords from `DEXTERM_POPUP_HOTKEY` / `DEXTERM_POPUP_HOTKEY_CLOSE` |

## License / attribution (Lightweight Charts™)

TradingView Lightweight Charts™ is Apache-2.0 (`vendor/lightweight-charts/LICENSE`). Its license requires
TradingView to be credited as the product creator: the chart page shows the NOTICE text ("TradingView
Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc.") with a link to https://www.tradingview.com/ in its
footer, AND the library's own `layout.attributionLogo` link on the chart. Keep both. No paid or embedded
TradingView widgets are used; the chart only ever draws dexterm's own data.
