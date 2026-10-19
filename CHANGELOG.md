# Changelog

All notable changes to dexterm are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) with the pre-1.0 caveat that minor versions may break things.

## [0.1.5] - 2026-10-18

An agents-and-analyst release: let an agent you connected paper trade inside a mandate you armed, run the analyst on your own Codex login, and see a coin creator's recorded history. Trading remains experimental; agent trading is paper only, and this release does not enable mainnet trading.

### Added

- **Agent paper trading (experimental, off by default).** Arm a mandate yourself, start `dexterm --spectate-mcp --agent-paper <mandate-id>`, and an agent connected over `dexterm mcp` can open, size, confirm and close simulated (paper) trades inside your caps with six `paper_*` tools. It can never sign or send a real transaction, touch a wallet or key, or raise a cap. The agent's tools never carry caps: the server re-reads the armed mandate on every call, and a size over any cap is refused. Ctrl+P pauses, Ctrl+K stops, and any key takes over. The in-app analyst never gets these tools. Paper figures are simulated, not results.
- **Codex as the analyst engine.** `--analyst-engine codex`, `analyst.engine` in `config.json` or `/engine codex` runs the analyst on your own Codex CLI login (0.163.0 or newer) instead of Claude. The Codex run is locked read-only in the Codex CLI itself: no shell, no file edits, no web search, only the read-only dexterm tools and the UI actions the session allows. `dexterm doctor` gains a Codex line. No key ships and no credential is read.
- **Dev history.** The token screen shows a coin creator's recorded track record from your local history (labelled rugs out of prior launches with the sample size, launches seen, how fast the dev sold, linked wallets), the `devrugs` rule field can alert on a new coin from a wallet that rugged before, and the read-only `dev_history` MCP tool returns the same report. It says `unknown` when there is no record. The published measurement currently has too few repeat deployers to rate the signal.

### Fixed

- A live `--record` session is no longer discarded at quit when a third-party URL carries a `key=` parameter; the recording is scrubbed instead.
- Quitting by SIGTERM or SIGHUP runs the normal teardown.
- A terminal following an external MCP agent moves with its view-only navigation and shows its paper calls.

### Known issues

- Trading remains experimental and no mainnet trading is enabled. Models and voice only propose; signer-side gates remain unchanged.
- The Codex engine was verified against codex-cli 0.163.0 with a local mock model. On Windows only `codex.exe` is detected, so an npm-installed `codex.cmd` reads as not installed.
- Dev history only knows what your own recorder has seen.

## [0.1.4] - 2026-10-16

A visibility and usability release: follow an MCP agent in the terminal, learn the app from a beginner guide, and inspect the evidence behind the checks. Trading remains experimental; this release does not enable mainnet trading.

### Added

- **Follow an MCP agent.** `dexterm --spectate-mcp` shows the connected agent's tool activity and follows accepted screen, feed, filter and token navigation. Ctrl+P pauses or resumes, Ctrl+K stops following, and your input takes control. Refused actions never move the screen; agents still cannot arm, sign or raise caps.
- **A complete beginner guide.** Terminal basics, platform-specific setup, `doctor`, a read-only first coin review, optional analyst questions, local exports and safe quit are documented and available to the in-app analyst.
- **A public scorecard.** Published evaluation results include dataset boundaries, frozen canary checks and weak spots. These are measurements of heuristics, not predictions or certificates of safety.
- **Timestamped follow-up drafts.** `dexterm larp-detected` can turn local recorder evidence into reviewable cards and follow-up drafts. The data source, time, horizon and limitations stay attached; nothing posts or schedules itself.
- **Agent-directory metadata.** MCP package metadata and client configuration examples are included. Directory listings themselves are not claimed submitted or accepted.

### Changed

- PTY and real-binary tests run in an isolated serial lane, with an unconditional wall-clock performance regression gate.
- CI adds hosted macOS arm64 and experimental Windows lanes, install smoke tests, and a separate serial PTY test lane. Windows remains experimental.

### Known issues

- Trading remains experimental and no mainnet trading is enabled. Models and voice only propose; signer-side gates remain unchanged.
- The web LARP checker is a separate test-mode preview, not part of this production release. Real Turnstile/deep-scan deployment gates remain open.

## [0.1.3] - 2026-10-16

A voice, signals and sharing release: a natural neural voice by default, live holder and rug signals, richer wallet tracking, a one-key copy-trade mirror ticket, shareable PnL cards, a spectator view of an agent at work, and an analyst that knows its way around the app. Trading is still experimental.

### Added

- **Live holder and rug signals**: the token screen now raises holder-concentration and rug signals in real time as the data moves, each tagged with its source and age, and a signal can fire an alert.
- **Copy-trade mirror ticket**: `dexterm follow` turns a tracked wallet's swap into a one-key mirror ticket. It is a proposal only — nothing arms or fires on its own — and the whole flow is replay-testable.
- **Shareable PnL cards**: turn a result into a 16:9 or 1:1 card (PNG plus plain text), stamped `PAPER`, `LIVE` or `TRACKED` so the basis is never ambiguous, with a one-key share to X that opens the draft post in your own browser.
- **Spectator view**: watch an agent drive the terminal in real time ("watch the agent cook"). Every field in a spectator event is redacted and an unknown tool name is capped, so an untrusted agent cannot leak a wallet or key through the live stream or a saved recording.
- **The analyst knows the app**: a generated app-help knowledge base and a read-only `app_state` let the analyst answer questions about what is on screen and run tiered, read-only UI actions, with a drift test that keeps the help in step with the real commands and flags.
- **Wallet tracker — hold time, alerts and detail**: a tracked wallet now shows hold time, raises buy and sell alerts through the alerts engine, and has a per-wallet detail view.
- **Headless recorder and recurring backtests**: an opt-in headless recorder mode and recurring backtest tooling for saved skills. Nothing turns itself on; every run is one you start, and proposals stay gated.

### Changed

- **A natural voice by default.** The default text-to-speech voice is now the Piper `en_GB-alan-medium` neural British voice on both macOS and Linux, with Apple's `say` as the fallback; `dexterm voice setup` installs it on this machine (it asks first) and `dexterm voice uninstall` removes it. Spoken answers on the screener are faster and read numbers the way a trader says them (market-cap style), `<` and `>` adjust the speaking rate, and asking about "this one" now refers to the highlighted coin.

### Fixed

- **Identity hygiene in the source.** The published source and its tests no longer carry internal maintainer or tooling names, and a ratchet test keeps it that way.

### Known issues

- **Trading is still experimental.** Paper trading and the live (wallet-signed) path still have bugs; do not rely on either for anything that matters. There is no mainnet trading.

## [0.1.2] - 2026-10-16

A reliability and reach release: a sensible default voice, a fix for the "history failed" error on the token screen, a built-in update check, headless alerts, one-step agent setup, early Linux voice support, and a way to export and share what you see. Trading is still experimental.

### Added

- **`dexterm update`**: checks for a newer release and updates an npm or source install in place; `dexterm update --off` turns off the once-a-day startup notice (so does `DEXTERM_NO_UPDATE_CHECK=1`). The check is two anonymous GETs to `registry.npmjs.org` and `api.github.com` and sends no telemetry.
- **Push alerts and `dexterm watch`**: run your rules headless, with the terminal closed, and have alerts pushed to your desktop, your own Telegram bot or a Discord webhook. Delivery is opt-in and off by default; dexterm connects to Telegram or Discord only after you enable and configure it, and your tokens stay local and are never logged. `watch` has no signer and only ever raises proposals.
- **One-step agent setup**: `dexterm mcp install <client>` writes the MCP config for `claude-code`, `claude-desktop`, `cursor`, `codex` or a generic agent — it shows the exact change, asks first, is idempotent and backs the file up — and `dexterm mcp doctor` connects to the server and lists its tools. The read-only MCP server now exposes 25 tools, including a one-call `larp_check`, and agents have per-agent capability tiers and standing mandates.
- **Export and share a view**: press `E` (or run with `--export`) to save the current screen as a PNG and a plain-text report under `~/.dexterm/exports` (local only). Paste a contract address or a token link anywhere a prompt accepts one to jump straight to that coin.
- **Linux voice (beta)**: optional Piper (text-to-speech) and whisper.cpp (speech-to-text) engines, with `dexterm voice` to download the models from Hugging Face when you ask for them. Real speaker and microphone I/O on Linux is not yet verified on hardware; treat it as beta.
- **LARP and skill backtests**: the LARP detector's links/domain/activity check now has a measured accuracy from a held-out backtest, reported honestly — on its own it is a weak signal, not a verdict — and saved skills can be backtested against held-out history the same way.

### Changed

- **A sensible default voice.** Voice output now defaults to an explicit deep British voice (Eddy, with Daniel as the fallback) instead of the machine's system voice, which varied by machine and could be a novelty voice. A novelty voice can never be auto-selected. Speech is sanitised before it is spoken and queued so lines do not overlap, and `voice.name`, `voice.rate` and `voice.pitch` are configurable.

### Fixed

- **"History failed" on the token screen.** Holder and transaction history now loads: a Helius request could reject a whole page of results when a single older transaction did not fit a version limit; that is fixed, and the pump.fun replay used in tests is now deterministic.

### Known issues

- **Trading is still experimental.** Paper trading and the live (wallet-signed) path still have bugs; do not rely on either for anything that matters.

## [0.1.1] - 2026-10-15

The first release published to npm. `npm i -g dexterm-cli` now installs it (npm refuses the name `dexterm` as too similar to `xterm`; the command is still `dexterm`). This upload was published by hand, so it has no build provenance yet. The GitHub release tarball and the Homebrew tap are unchanged.

### Added

- **`npm i -g dexterm-cli`**: dexterm is now on npm as `dexterm-cli`, published by hand without provenance. The package ships compiled JavaScript so a global install needs no build step (the release tarball and a checkout still run the TypeScript sources directly).
- **Go to a coin by address**: press `g` on the screener, new pairs, watchlist or a token to open a prompt, paste a contract address, and jump straight to that token.

### Fixed

- **Paper trade quotes no longer time out.** Paper fills fetch their Jupiter quote at high priority, so a ticket no longer fails with "quote timed out" when the shared quote budget is busy with screener enrichment.

### Known issues

- **Trading is still experimental.** Paper trading and the live (wallet-signed) path still have bugs; the quote fix above removes one failure mode but does not make either path reliable. Do not rely on them for anything that matters.

## [0.1.0] - 2026-10-15

First public release. Items marked *in progress* ship in this release but are labelled experimental or partial in the app; they are not a promise.

### Added

- **Screener and feeds**: a live Solana screener from keyless public APIs (DexScreener, Jupiter, GeckoTerminal) with a filter grammar (`vol24 > 250K liq > 50K`), sort menus, feed presets, an instant first paint, a trending board, coin pictures in the terminal, a sub-second on-chain price lane for pump.fun coins, and a market-cap display mode.
- **New pairs**: a live push feed of launches and migrations, with snipers and bundled supply from the wallet-intel scan.
- **Token screen**: market stats, mint and freeze authority, holders with a bubble map that classes every top holder, RugCheck and GoPlus reads, candles from 1m to 1d, a buy/sell flow panel, a social panel with spam and prompt-injection filtering, and the token's advertised links.
- **LARP detector**: a check of a token's website, domain registration and GitHub activity, with a verdict badge. Its accuracy is not measured yet (*in progress*).
- **The analyst**: your own `claude` login reads the same data through dexterm's read-only MCP server and answers in a few decided lines. It knows what is on screen, turns plain language into filters, and can navigate for you. Every answer is labelled model output. An AI scan mode watches the screener using only data already on hand; it is observe-only and capped. Analysis packs, a narrative board and one-line digests are *in progress*.
- **Watchlist, alerts and a rules engine**: a local watchlist, alerts that stay proposals until you press a key, and `when … then …` rules with mandatory cooldowns.
- **Paper trading** (*in progress*, known issues): a simulated wallet priced from live Jupiter quotes, a confirm gate that is on by default, positions and history, and trade-moment effects and sound that fire only after a result.
- **Live trading, non-custodial** (*in progress*): `L` on a ticket hands a capped transaction to your own Phantom wallet to sign, on a one-shot loopback page. Your wallet's keys never enter dexterm; only your public key is stored. A separate signer process builds and simulates every transaction. It enforces per-trade and daily USD caps and price-impact, slippage and SOL-out ceilings, and has a panic switch. Devnet is the default; mainnet needs `--mainnet` and shows a red banner. The live path is still maturing and does not promise fills or returns.
- **Order plans and standing mandates** (*in progress*): "buy if it dips to 300k, sell half at 600k" becomes an inert proposal that only a held keypress can arm. The executor re-checks the caps on every fill, and a hash-chained journal records everything. Paper by default; a devnet fire path uses an optional, capped, devnet-only fast wallet.
- **Copy trading** (*in progress*): follow a wallet, see its decoded swaps and realised PnL, and preview a mirror ticket. A capped auto-mirror turns on only with a keypress and the "less safe" confirmation. Paper by default; mirror-sell is not built.
- **Popup windows**: a TradingView Lightweight Charts popup (vendored, loopback-only) with your position on the chart. It docks beside the terminal on macOS and opens in your browser elsewhere. Token, feeds and bubble-map popups too.
- **Voice** (macOS): Jarvis push-to-talk for screens, coins, filters and PAPER tickets. It asks when unsure instead of guessing, and it can never arm, sign or raise a cap.
- **Bring your own agent**: a read-only MCP server (`dexterm mcp`), a loopback agent bus with per-agent capability tiers (observe, annotate, propose), and agent packs served over MCP. An agent roster can pause or kick any agent and shows the audit log. Agents are untrusted by default.
- **Customization**: workspaces and a morning HUD, user themes and keymap overrides with a contrast guard, shareable packs with a hash lock and an optional ssh signature (*in progress*), and a sandboxed popup widget API (*beta, in progress*).
- **Social**: KOL lists and Login with X (OAuth 2.0 PKCE on a loopback callback with your own X app, read scopes only).
- **Local history recorder**: keeps what the app saw, plus code-only outcome labels, in your local database for backtests. Nothing is uploaded.
- **Install and health**: a user-level installer (no `sudo`), `dexterm doctor` with the exact fix for anything missing, and a keyless path for every feature. A health registry shows `unavailable` or `needs key` instead of a made-up number.
- **Release pipeline**: a reproducible source tarball, SHA256SUMS, a build-provenance attestation, a CycloneDX SBOM, and VirusTotal and supply-chain scan results on the trust page.

### Known issues

- **Trading is experimental.** Paper trading and the live (wallet-signed) path both have bugs in this release: the ticket flow, simulated fills and the wallet hand-off can misbehave. We are fixing them in the open; do not rely on either for anything that matters.
