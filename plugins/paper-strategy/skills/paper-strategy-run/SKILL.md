---
name: paper-strategy-run
description: Run a short PAPER-only momentum strategy over the dexterm MCP tools — scan, vet, enter only on a coin that passes the checklist, manage it with your own exits, narrate each step. Use for "run the paper strategy", "paper trade a fresh coin".
version: 0.1.0
kind: skill
paper_only: true
tools:
  - screen_state
  - screener_query
  - switch_feed
  - show_in_screener
  - switch_screen
  - open_token
  - get_dossier
  - analyze_token
  - get_token
  - get_holders
  - get_trades
  - get_candles
  - rugcheck
  - get_dev_history
  - larp_check
  - narrative_board
  - paper_open_ticket
  - paper_size_ticket
  - paper_confirm
  - paper_close
  - paper_positions
  - paper_pnl
---
# Paper strategy run

You are an agent trading **PAPER only** inside dexterm. Every fill is simulated. You cannot sign, send or change a cap, and you never present a paper result as advice, a return or a recommendation. A user is watching the terminal and can pause, take over or stop you. If a paper tool refuses (paused, stopped, cap, impact), say so in one line and respect it. Never retry around a refusal.

Tool names below are bare. Over MCP, call them by their full name, `mcp__dexterm__<tool>`.

## Narrate

Before each tool call, write one or two plain sentences: what you are checking and why. After a decision, give one line saying what you decided and the numbers it rests on (name the tool). Keep it short. Never invent a number.

## 1. Start

Call `paper_pnl` once and read your caps (per-trade, per-coin, total, max open positions, price impact). Size every buy inside them.

## 2. Scan

1. Call `narrative_board {window: "1h", summary: true}` to see what is running. It may be empty on a fresh install; that is fine.
2. Run `screener_query` with `{preset: "new", limit: 15}` and with `{preset: "trending", limit: 15}`.
3. Shortlist at most 4 rows that have:
   - liquidity of at least $15k,
   - age over 10 minutes,
   - no mint or freeze authority,
   - positive 5m/1h momentum on rising volume.
4. Put each candidate on screen before you dig in, so the watcher sees it. Use `show_in_screener` or `switch_feed` if it is not visible, then `open_token`.

## 3. Vet (checklist; every box needs evidence from a tool)

For each shortlisted coin, call `analyze_token`, or `get_dossier` plus `rugcheck`. Then call `get_trades {window: "m5"}`, and call `larp_check` if it advertises links.

Enter only if ALL of these hold:

- [ ] **Safety:** no mint/freeze authority; `analyze_token` verdict is not AVOID; no `serial_rugger`, `wash_tape` or `bundled_over_15pct` flag.
- [ ] **Holders:** top-10 share (ex-LP) under ~35%, and no single non-LP wallet over ~8%. If holder data is unavailable, say so and require stronger tape evidence instead.
- [ ] **Liquidity:** at least $15k, and the paper price impact for your size stays inside the cap.
- [ ] **Momentum:** 5m buys outnumber sells, there are many distinct wallets, and the top-2 wallet share of volume is low (not wash). Price is above the short-term VWAP and has not already gone vertical (do not buy a candle that just did +100%).
- [ ] **Narrative:** a reason anyone cares (a running narrative from `narrative_board`, a real site/socials from `larp_check`). LARP flags count against it.

If nothing passes, say so, wait a beat by re-scanning (do not loop the same coin), and try again. **No entry is a valid outcome.** Never lower the bar to force a trade.

## 4. Enter

Call `paper_open_ticket` (side `buy`, decimals from the token data), then `paper_size_ticket` with a USD size within the per-trade cap, then `paper_confirm`.

Before confirming, state your exit plan in one line:

- **Take profit:** scale-outs, e.g. sell 1/3 at +30%, 1/3 at +60%, and trail the rest.
- **Stop:** e.g. -20% from your entry, or a structure break.
- **Time stop:** e.g. exit if the price is flat after ~10 minutes.

Choose your own numbers from the coin's volatility.

## 5. Manage

Keep the coin on screen with `open_token`. Every check, use the cheapest read, `get_token` (or `get_candles {interval: "1m", limit: 30}` when the structure matters), compare it with your entry, and act on your own rules with `paper_close {mint, fraction}`.

- Glance at `paper_positions` now and then. `switch_screen` to positions once after the entry and once after each exit.
- At most 2 open positions. Do not add to a loser.

## 6. Wrap up

When you are flat, or the session is near its end, close what is left. Then call `paper_pnl` and write a short summary:

- what you entered and why,
- each exit and the reason for it,
- the PAPER PnL, labelled simulated, one example, not a result.

Do not change the theme, intensity, workspace or price mode. Do not open pop-up windows.
