# Spectator — "watch the agent cook" (task-1406)

A live, read-only view of an agent driving dexterm: when a connected agent (MCP or the loopback bus)
calls a tool — open a token, run a LARP check, scan new pairs, read a bubble map — the terminal shows
the call, its result, timing and data ages in an **AGENT ACTIVITY** panel, and (for navigation tools)
visibly moves the screen. Three surfaces, one event model:

1. **Follow mode** (default, local, in the terminal). The owner watches full detail and can **pause**,
   **take over** or **kill** (panic key) the agent at any moment. Nothing is redacted — it is the
   owner's own machine.
2. **Spectator stream** (read-only, loopback, per-session token, optionally shareable). A separate
   outbound-only WebSocket a streamer can point a capture at. Wallet addresses and keys are **redacted**;
   the stream has **no inbound command path** — it is structurally impossible to drive the agent or the
   terminal through it.
3. **Save / replay** a session to a file (JSONL). Useful for demos, the agents film, and bug reports.
   The saved file is **redacted by default** so it is safe to share.

Agents stay **untrusted** (ROADMAP hard rules): the spectator surfaces observe the *same* read / propose
tool calls the gate already allows. No spectator path can arm, sign, confirm, send, raise a cap, change
the gate or touch a wallet / mandate / signer — there is no such event and no inbound control at all.

## Event schema (`SpectatorEvent`, `src/spectator.ts`)

One normalized record per observable action, emitted by the tool-call path (bus `onCall`, and the
MCP `tools/call` path via a file sink). Stored **raw** in the `SpectatorHub` ring buffer; redacted per
consumer.

| field | meaning |
|---|---|
| `v` | schema version (1) |
| `seq` | monotonic sequence per hub (ordering + replay cursor) |
| `t` | wall-clock ms |
| `phase` | `connect`\|`disconnect`\|`call`\|`result`\|`proposal`\|`refused`\|`nav`\|`note`\|`subscribe`\|`control` |
| `agent` | agent name (firewalled upstream) |
| `tier` | granted tier at the time (`observe`\|`annotate`\|`propose`) |
| `transport` | `bus`\|`mcp`\|`test` |
| `tool` | tool / method / proposal kind |
| `summary` | short human line (firewalled upstream) |
| `ok` | success / refusal |
| `ms` | execution time of the call (result phase) |
| `dataAgeSec` | freshness of the data the tool returned (max `ageSec` seen in the result) |
| `refusal` | gate refusal code for `phase: 'refused'` (`never`\|`tier`\|`mandate`\|`spoof`\|…) |
| `nav` | for `phase: 'nav'`: `{ screen, mint, feed, filter, highlight, side }` the agent asked the screen to show |
| `sensitive` | event was marked sensitive → body fully redacted in spectator/saved output |
| `redacted` | set by `redactSpectatorEvent` once a copy has been redacted |

The `'nav'` events are what make the terminal "visibly perform" the agent's actions — the
`FollowController` folds them into a `ScreenModel` (current screen, selected mint, feed, filter,
highlight) exactly as the running TUI would.

## Redaction rules (`redactSpectatorEvent`)

Applied to every event leaving the local machine (the spectator stream and, by default, the saved
file). Follow mode does **not** redact.

- **Wallet / token addresses** — any base58 run of 32–44 chars → `head4…tail4` (matches the product's
  own `shortAddr`; a full address never appears verbatim in a shared stream).
- **Private keys / signatures** — any base58 run ≥ 45 chars, or a hex run ≥ 64 chars → `[key]`
  (fully removed; no prefix). Belt-and-braces: the gate's never-list already blocks every key / signer
  tool, so key material should never reach an event — this guarantees it anyway.
- **Sensitive-named fields** — a field whose key matches `secret|private|privkey|mnemonic|seed|
  passphrase|password|signature|sig|token|apikey|keypair` → `[redacted]`.
- **`sensitive: true` events** — the whole `summary` becomes `[sensitive]`.

Redaction is deep (summary string + `nav.mint` / `nav.highlight`) and leaves everything else
(timings, ages, tool names, tiers, verdict labels) intact so the stream stays watchable.

## Security model

- **Follow mode** reads the in-process `SpectatorHub` directly; no socket, no exposure.
- **Spectator stream** (`SpectatorServer`) reuses the proven loopback WS server (`src/ws.ts`): binds
  **127.0.0.1 only** on a random port, the remote address must be loopback, LAN / `::` are refused. A
  **per-session token** (32 random bytes) is generated at start and compared with `timingSafeEqual`; a
  connection that does not present it in `hello` within the timeout is closed. The token is written to
  `~/.dexterm/spectator.json` (mode 0600), never argv.
- **Read-only, no command path.** The server is constructed with a `SpectatorHub` **only** — it holds
  no reference to the bus, registry, executor or any control. The one inbound method it honors is
  `hello` (auth) and `ping`; every other inbound message increments a `dropped` counter and is ignored.
  There is no code path from the socket to anything mutable. A test fires `tools/call`, `pause` and
  `roster.kick` at it and asserts the bus state is untouched and the socket only ever emits events.
- **Redaction** is applied on the way out, always.

## How it composes with the popup host

The spectator view is also a popup **kind** (`'spectator'`, `packages/popup`), so it rides the popup
host's existing security *verbatim* — single-use ticket → one-time WS token, strict Host / Origin,
loopback bind, nonce CSP, and the popup→TUI **event allow-list**. The popup renders the redacted
`SpectatorPopupVM` (screen model + activity rows with agent badge, timing and data ages). The only
messages the page may send are `spectator.pause` / `spectator.resume` / `spectator.takeover` /
`spectator.kill` by agent name — the TUI maps them to the bus's user-side controls and re-validates;
the page can never arm, sign or raise a cap, exactly like the roster popup. "Shareable" = the streamer
captures this loopback window (or the stream), never a public bind.

## Follow-mode controls (pause / take over / kill)

`FollowController` holds the screen model + activity and delegates control to an `AgentControls`
interface the bus implements (`pauseAgent` / `resumeAgent` / `kickAgent`):

- **pause** — `bus.pauseAgent(name)`: the gate refuses the agent's next call; it stays connected.
- **take over** — pause + mark control `user`: the human is driving; the agent is frozen but visible.
- **kill (panic key)** — `bus.kickAgent(name)`: every live session for the agent is closed now
  (rotate / remove the token to revoke it for good). Pairs with pause so a reconnect stays frozen.

All three already exist on the bus and in the roster popup; the spectator surfaces reuse them.

## Files

| path | what |
|---|---|
| `src/spectator.ts` | `SpectatorEvent`, `SpectatorHub`, redaction, recorder + replay |
| `src/follow.ts` | `FollowController` (screen model, activity, pause/takeover/kill) |
| `src/spectator-server.ts` | read-only loopback stream with a per-session token |
| `cli/src/spectate-cmd.ts` | `dexterm spectate` (replay a file; serve the stream) |
| `popup/src/pages/spectator.*` | the spectator popup page (composes with the popup host) |
