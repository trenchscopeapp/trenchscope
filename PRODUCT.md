# Product

<!-- impeccable:product-schema 1 -->

trenchscope is a fork of dexterm (renamed 2026-10-18, commit 36043d6). The user-facing name, wordmark, boot logo and
`trenchscope` bin are new; internal package names (`@dexterm/*`), `~/.dexterm` and `DEXTERM_*` variables stay so keys
keep working and upstream fixes still merge.

## Platform

web (the marketing site). The product itself is a terminal UI; its look is governed by `packages/tui/src/theme.ts`.

## Stack

- Product: Node 22.18+ TypeScript run through Node's type stripping, npm workspaces (`packages/*`), no build step.
- Site: static HTML/CSS/JS on a Vercel static deploy (owner, 2026-10-18). No framework. The site's CLI imagery is
  rendered from the real app (`packages/cli/tools`), never redrawn by hand.

## Users

Solana memecoin traders who live in a terminal: fast, sceptical, reading dense numbers for hours, usually on a dark
screen at night. Also newcomers who have never used a terminal and want a read-only first win (start-here).

## Product Purpose

Screen Solana memecoins from public, keyless data in the terminal, and let the user's own `claude` or `codex` login
read the same screens as an analyst. Paper trading by default; a live trade is signed only in the user's own wallet.

## Positioning

The screener and the analyst share one set of tool results through a read-only MCP server, so the model reads exactly
what the trader sees, with the age of every number. Keyless, local, no account, no telemetry, non-custodial.

## Operating Context

Long sessions in iTerm2, Ghostty, WezTerm, Kitty, Alacritty or Windows Terminal. Keyboard only: `j`/`k`, `⏎` open,
`a` analyst, `/` filter, `w` watch, `c` chart, `?` every key, `q` quit. Screens: Screener, New pairs, Watchlist,
Analyst, token detail, trade ticket, positions, plans.

## Capabilities and Constraints

- Data: DexScreener, Jupiter, GeckoTerminal, PumpPortal, RugCheck, GoPlus, Solana RPC (Helius with a key), optional
  Solana Tracker key. A failed source prints `unavailable` or `needs key`, never a guess.
- Trading: paper by default; live sends a capped transaction to the user's Phantom to sign, devnet unless `--mainnet`.
  Paper and live trading are experimental with known bugs.
- The analyst and MCP server have no build, sign or send tool.
- Terminal rendering supports truecolor, 256-colour and NO_COLOR; every numeric cell must clear 4.5:1 contrast.
- Open decision: the npm and Homebrew names for trenchscope are not published yet (the package on npm is still
  `dexterm-cli`). The site must not present them as live until they are.

## Brand Commitments

- Name: trenchscope, lowercase. Tagline: "a terminal for the trenches".
- Black and white (owner, 2026-10-18): the CLI and the site share one monochrome look. Ink on black for everything;
  only price direction keeps a muted green/red and real warnings keep amber. Active tabs and key chips are reverse
  video; the selected row is a raised grey bar. No launchpad hues, no blue accent, no coral. The CLI theme is mono.
- Type is one mono face on the site (owner, 2026-10-18), with a 2x 1-bit pixel hand cursor like the API site.
- Colour pops (owner, 2026-10-18): the site may use the up/down/amber state colours at full strength for live and confirming moments; the ground stays black and white.
- Decorative blinking carets are removed site-wide (owner, 2026-10-19). Keep the actual terminal rendering and pointer cursors.
- No em dashes anywhere.
- Design reference for the site's CLI visual (owner, 2026-10-18): Trial's landing components
  (`Projects/tape/components/docs/home.tsx`, `demos/device-stage.tsx`): the real app screen in a lit, tilted bezel,
  animating through its sections.
- The previous man-page site (`.design/site/project`) was rejected by the owner as slop (2026-10-18).

## Evidence on Hand

- Real app frames: `packages/cli/tools/shot.mjs` and `demo.mjs` render cell-exact HTML from the app with `--fixtures`.
- Fixture data uses real-looking tickers; anything shown on the site is labelled sample data.
- No testimonials, user counts, benchmarks or press exist. Do not invent them.
- License AGPL-3.0-only; NOTICE records the fork.

## Product Principles

- Truth over flourish: stale, absent and failed data are distinct, labelled states.
- The model is a reader, not an actor: it can never sign or send.
- Local and yours: no account, no server, no telemetry.
- Density with order: every number aligned, tabular and labelled.

## Accessibility & Inclusion

WCAG AA contrast on every numeric cell in every theme, NO_COLOR support, keyboard-only operation, reduced motion
respected on the site.
