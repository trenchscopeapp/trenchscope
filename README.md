# trenchscope

**A terminal for the trenches.** A Solana memecoin screener that runs in your terminal, with your own `claude` or `codex` login as the analyst. Keyless market data, no account, no server, no telemetry. Trading is non-custodial and simulated (paper) by default: a real trade is signed by your own wallet, and your wallet's keys never enter trenchscope.

> **Status: early.** trenchscope is pre-1.0 and a fork of [dexterm](https://github.com/dexterm-xyz/dexterm) (see [NOTICE](NOTICE)). Screens, keys and output change between versions. **Paper and live trading are the roughest parts** and have known bugs, so treat all trading as experimental. It shows you data and a model's reading of that data; it is not financial advice and it will be wrong sometimes. Read [what it can and cannot do](#the-safety-model) before you trust it with anything.

## Install

One line. You need a terminal; everything else is handled.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/trenchscopeapp/trenchscope/main/install.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/trenchscopeapp/trenchscope/main/install.ps1 | iex
```

**Already have Node 22.18+**

```sh
npm i -g trenchscope
```

Then:

```sh
trenchscope doctor    # checks Node, the terminal, the optional claude/codex CLI and every data source; prints the fix for anything missing
trenchscope           # start
```

Try it on sample data without installing anything: `npx trenchscope --fixtures`.

The installers are user-level: no `sudo`, no edits to your shell profile. The macOS/Linux one downloads a checksum-verified Node into `~/.dexterm/node` if yours is missing or too old; the Windows one offers to install Node LTS with `winget`.

### Let Claude or Codex install it

Paste this into Claude Code, Codex or any coding agent:

```text
Install trenchscope (https://github.com/trenchscopeapp/trenchscope): run `npm i -g trenchscope` (if Node 22.18+ is missing, use the one-line installer from its README instead), then run `trenchscope doctor` and fix anything it reports, then connect its read-only MCP server to yourself with `trenchscope mcp install claude-code` (or `codex`). Tell me to run `trenchscope` in my terminal when you are done.
```

### Use it from Claude or Codex

trenchscope ships a read-only MCP server: your agent gets the same token dossiers, holder, rug and LARP checks, candles and trades the screener shows. It has no tool that can build, sign or send a transaction.

| Client | One line |
|---|---|
| Claude Code | `claude mcp add trenchscope -- npx -y trenchscope mcp` |
| Claude Code plugin | `/plugin marketplace add trenchscopeapp/trenchscope` then `/plugin install trenchscope@trenchscope` |
| Codex | `codex mcp add trenchscope -- npx -y trenchscope mcp` |
| Claude Desktop, Cursor and others | `trenchscope mcp install claude-desktop` (or `cursor`, `generic`) |

`trenchscope mcp doctor` checks the connection.

### Claude.ai connector and interactive views

In Claude.ai, open **Settings > Connectors > Add custom connector** and enter:

- **Name:** `Trenchscope`
- **MCP server URL:** `https://trenchscope-mcp-production.up.railway.app/mcp`

Then enable Trenchscope in a conversation and ask: **Show trending Solana tokens**, or
**Open a dossier for this mint: <address>**. Compatible MCP Apps clients display a styled
screener with token logos, clickable Solscan contract links, search and gainers/losers filters. Token dossiers include clickable creator/holder wallets, an animated price chart with pointer and keyboard inspection,
security indicators, source ages and missing-data notices. Refresh and token selection
call the same read-only tools through the host. Other clients receive ordinary tool data.

The hosted service exposes 17 public analysis and knowledge tools. Terminal navigation,
local screen state, recorded account history and paper-trading tools stay local. Public
data requires no login or API key. The service has a shared request budget; a busy server
returns HTTP 429 with `Retry-After`.

Railway builds `Dockerfile.mcp` using `railway.json`, serves `/mcp`, and checks `/health`.
Its service follows this repository's `main` branch. Local preview: `node scripts/mcp-app-preview.mjs`,
then open `http://127.0.0.1:3422` (live data) or add `?sample=1` (labelled sample data).

### From a checkout

```sh
git clone https://github.com/trenchscopeapp/trenchscope.git && cd trenchscope
./install.sh          # or just: npm run trenchscope   (no build step; `npm install` only pulls the TypeScript dev tooling)
```

### Optional pieces

- **The analyst** needs [Claude Code](https://claude.com/claude-code) or Codex installed and logged in. Usage is billed to your own account. Everything else works without it.
- **A Helius RPC key** (free tier) unlocks holder data and a faster on-chain lane. Write it to `~/.dexterm/helius.key`; `trenchscope doctor` prints the command. Keyless, the public RPC is used and the missing fields say `needs key`.
- **The native chart window** builds in about a minute if you have a Rust toolchain (`cargo`); without it, charts open in your browser.

## What it does

- **Screener**: hundreds of Solana pairs from public, keyless APIs (DexScreener, Jupiter, GeckoTerminal), a simple split view to start and a full table (`f`) with a filter grammar (`vol24 > 250K liq > 50K`), sort menus, presets, and a spotlight on the hovered coin.
- **Token screen**: price, candles, trade tape or buy/sell flow, holders, mint/freeze authority, RugCheck and GoPlus safety reads, links, and a LARP check on the project's website and socials.
- **New pairs**: a live push feed of launches and migrations with launch forensics.
- **Watchlist and alerts**, persisted locally in SQLite.
- **The analyst**: press `a` and your own Claude Code or Codex login reads the same tool results (through the read-only MCP server) and answers in plain language. Every answer is labelled model output with the age of every number. Token names, descriptions and fetched pages reach the model wrapped as untrusted text.
- **Trading, paper by default**: a simulated (paper) wallet priced from live quotes, for tickets, positions, order plans and copy trading. A **live** path, still maturing, sends a capped transaction to your own Phantom wallet to sign: devnet by default, mainnet only when you start with `--mainnet`. Every run starts on paper.
- **A docked chart window** (TradingView Lightweight Charts, vendored, served from a loopback-only server) when you opt into building the small native shell.

## Keys you will use first

`?` shows every key for the screen you are on. `q` quits. `⏎` opens the hovered coin, `a` asks the analyst, `/` filters, `w` watches, `c` opens the chart, `Esc` goes back.

## The safety model

Trading in trenchscope is **non-custodial** and **paper by default**. Every run starts on the simulated wallet; nothing real is signed or sent until you switch a ticket to LIVE with a keypress and approve the transaction in your own wallet.

What trenchscope **never does**, on any published version:

- see, store or import your wallet's private key or seed phrase: a real trade is signed in your own wallet (Phantom, on a one-shot loopback page in your browser), and trenchscope stores only your public key;
- sign or send without you: models, voice, agents and pipes can only propose; arming a plan or sending a trade takes a physical keypress, and a Phantom trade also takes your approval in the wallet;
- trade outside the caps: a separate signer process enforces per-trade and daily USD caps, price-impact, slippage and SOL-out ceilings on every transaction, and refuses anything out of policy even if the UI, the model or a popup is compromised; devnet by default, mainnet only with `--mainnet` and a red banner;
- give the model a way to trade: the analyst and the MCP server have no build, sign or send tool; the most the analyst can do is navigate and open a PAPER ticket, and an agent you opt in with `--agent-paper` can only book simulated (paper) trades inside a mandate you armed (its tools never carry caps);
- open a server reachable from outside your machine (the chart server and the wallet bridge bind `127.0.0.1` with per-use tickets);
- phone home: no telemetry, no crash reports, no account. The only unprompted request is a once-a-day version check (two anonymous GETs to npm and GitHub with fixed headers); `trenchscope update --off` turns it off.

The one key trenchscope itself can hold is an optional **devnet-only fast wallet** that lets standing order plans fire on devnet without a wallet prompt per fill. It exists only if you run `trenchscope wallet fast create` (a keypress on a TTY), lives at `~/.dexterm/fast-wallet.json` (mode 600), is never used on mainnet, and has no export or import.

**The live trading path is still maturing.** trenchscope does not promise fills, prices or returns: a real fill pays real slippage and fees, a transaction can fail, and most memecoins go to zero. Use a wallet that holds only what you can afford to lose.

What it **does** send over the network: requests from your machine to the public data APIs (the addresses you look at, your IP), WebSocket subscriptions to the new-pairs feed and the RPC, a read-only fetch of a token's website only when you press the link keys, the prompt trenchscope builds to Anthropic through your own `claude` login if you use the analyst, and, when you trade LIVE, the signer's quote, price and RPC requests and the transaction your wallet signed. `trenchscope doctor` lists every host; and says what each one is for.

Everything it stores is local and yours to delete: a SQLite database (cache, watchlist, request counters, the paper wallet) under your home directory, a small state file, the optional RPC key file, and, if you use them, the order-plan and copy journals, the signer's cap and trade ledgers, your linked wallet's public key and the devnet fast-wallet key.

**Not financial advice.** Memecoins are adversarial. Data sources lag, lie or go down; the app says `unavailable` or `needs key` rather than inventing a number, and the analyst can be wrong or manipulated by text planted in a token's metadata. Verify before you act.

## Releases you can check

Every release is built by a public GitHub Actions workflow from a tagged commit and ships with `SHA256SUMS`, a Sigstore-signed build-provenance attestation, a CycloneDX SBOM, and `scan-results.json` with third-party scan results (VirusTotal, OpenSSF Scorecard, osv-scanner, gitleaks) that the trust page renders, including any false positive and what we did about it. How to check all of it: [docs/verify-your-download.md](docs/verify-your-download.md).

## Contributing, security, conduct

- Bugs and ideas: [issues](../../issues). Please include `trenchscope doctor` output; it contains no secrets.
- Security problems: **do not open an issue.** See [SECURITY.md](SECURITY.md).
- Pull requests: [CONTRIBUTING.md](CONTRIBUTING.md). Be decent: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Maintainer notes for running and testing from a checkout: [docs/development.md](docs/development.md).

## Data attribution

Market data comes from DexScreener, Jupiter and GeckoTerminal (CoinGecko) under their free tiers and terms; launches from PumpPortal; safety reads from RugCheck and GoPlus; chain data from Solana RPC (Helius when you configure a key). Charts by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0, vendored under `packages/popup/vendor/`). trenchscope is not affiliated with any of them.

## License

See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright (C) 2026 The dexterm authors and trenchscope contributors. Licensed under AGPL-3.0-only.
