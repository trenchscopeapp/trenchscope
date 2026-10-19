---
id: docs-paper-trading-your-first-live-trade
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Your first live trade
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Your first live trade
anchor: your-first-live-trade
url: https://dexterm.xyz/docs/paper-trading#your-first-live-trade
tags:
  - docs
  - paper-trading
  - first
  - live
  - trade
  - trading
  - devnet
  - paper
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

A walkthrough for one small, real swap inside the default caps. It is the path the verifier follows with a devnet signer (every step up to the confirm behaves the same, and the devnet wall above is where it stops) and on fixtures; nobody has yet run it to a mainnet fill, and nothing here is advice to.

1. **Link your wallet.** `dexterm wallet link` opens Phantom on a loopback page; connect and sign the nonce. `dexterm wallet status` shows the public key. dexterm never sees a key.
2. **Fund a small mainnet wallet.** Use a wallet that holds only what you are willing to lose plus fees: for a $5 trade at SOL $108 that is about 0.06 SOL (0.046 for the swap, the rest for the token-account rent of 0.00204 SOL, network and priority fees and a reserve). The per-trade cap is $5 and the daily cap $20 by default; the hard ceilings are $500 and $2000 and only `--mainnet` can raise anything.
3. **Start on mainnet with the caps you mean.** `dexterm --mainnet --max-usd 5` (add `--daily-usd 20`, `--max-sol-out 1`, `--max-slippage-bps 500` to be explicit). The ticket header turns red: `⚠ LIVE · MAINNET — REAL FUNDS · caps $5/trade $20/day`. The signer process starts on the first LIVE action with exactly these flags, classifies the network from the RPC it talks to, and needs two independent SOL/USD sources within 3% before it will price anything.
4. **Open a ticket and size it under the cap.** `B` on a token, `L` to flip LIVE, type a size; watch the cap line and press `f` if it is red (it sets the largest size that fits, fees and rent included). Slippage stays at 50 bps unless you change it; impact over 3% is refused.
5. **Build the plan.** `⏎`. If Jupiter rate-limits, the ticket waits and retries by itself (`r` now, `esc` cancels). The PLAN lists what will be signed, what you pay and receive, the minimum received, the fee, the route, the simulation result (how much SOL leaves your wallet), the SOL/USD price and its sources, and the caps verdict; `within caps` means the signer will not refuse it at this moment.
6. **Confirm.** `Y`. The signer re-checks the caps, reserves the USD on the daily ledger, opens the sign page. The page **connects first** (a Connect prompt the first time on this origin, silent after that), shows the connected account and refuses one that is not the linked wallet (`Phantom is on account … but dexterm linked …`), then asks Phantom to sign; approve in Phantom. If Phantom answers 4100 ("not authorized") the page says so and what to do: press Approve again and accept the Connect prompt, or allow `127.0.0.1:41291` under Phantom's Trusted apps, then confirm the trade again in dexterm; nothing was signed. The signed bytes must be the same message with your signature (a Lighthouse tail appended by Phantom is the one tolerated change); they are decoded, policy-checked, bound and re-simulated with fresh balances, then submitted and confirmed.
7. **Expected outcome.** `✓ LIVE MAINNET BUY confirmed — 0.0144 AVGOx @ 2.778 SOL · sig …` with the signature; the position appears under the chart marked live and on the positions screen under LIVE POSITIONS; the daily ledger shows the spend (`Caps … spent $4.32`). A refusal (`✗ REFUSED by the signer — per-trade-cap: …`) means nothing was signed or sent. `send-unknown` with a signature means the transaction may have been broadcast: check the explorer, do not resend.
8. **Panic key.** `/wallet panic` in the app or `dexterm wallet panic` from any shell disables live signing everywhere at once (kill-switch file, locked ledger, plans forgotten). `dexterm wallet resume` on a real TTY is the only way back.
9. **Read the journal.** `dexterm wallet status` shows the linked key, the signer's network and caps, today's spend and the panic state. Confirmed real fills live in `~/.dexterm/live-trades.sqlite` (the signer's own ledger, read by the positions screen); the daily USD reservations in the shared cap ledger `~/.dexterm/caps.sqlite`; the signer's log lines (including the full text of any failed simulation) go to the app log. Order plans, if you use them, append to `~/.dexterm/plans.journal`, which `dexterm plan journal --verify` recomputes.
