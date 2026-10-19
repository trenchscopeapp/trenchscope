---
id: wash-trading-fake-volume
title: Wash trading, fake volume and the organic score
tags:
  - wash-trading
  - fake-volume
  - organic-score
  - volume
  - jupiter
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://developers.jup.ag/docs/tokens (retrieved 2026-09-30 into solana-launchpad/docs/jupiter/tokens-api.md; Organic Score section)
  - https://developers.jup.ag/blog/what-is-organic-score (linked from the Tokens API doc)
  - dexterm SPEC.md §3.3 Stats (numTraders, numNetBuyers, buyVol/sellVol per window)
---
**What the aggregator measures.** Jupiter's Organic Score (0–100) "measures how genuine a token's trading activity is, filtering out bots, snipers, and copy-trading tools"; it combines organic volume, organic holders, organic traders and organic buyers after removing wallets that trade through known bot channels. The docs' own caveats: it is **relative, not absolute** (normalised against the ecosystem; SOL and USDC sit near 100), **early growth counts most** (10 → 100 organic buyers moves it far more than 10,000 → 10,100), and the raw score beats the `high/medium/low` label. dexterm shows the raw score (≥ 70 green, 40–69 amber, < 40 red; SPEC §3.6).

**How volume is faked.** Two or more wallets controlled by one party buy and sell to each other; each round trip pays the trading fee (1 % on a pump.fun curve and 0.25 % on PumpSwap, each plus any creator fee; 0.25 % on the common Raydium CPMM tier) plus network fees and little else, so "$1 M volume" costs roughly $2,500 on a 0.25 % pool and about $10,000 on a 1 % curve. The goal is to appear on volume-sorted screeners and trending lists. Volume-boost services sell exactly this.

**Signals that separate it (maintainers, reviewed 2026-10-15):**
- `get_trades.top2WalletVolumeSharePct` high (two wallets are most of the tape) and `distinctWallets` low relative to `count`.
- `stats.perWindow.h1.numTraders` small while `pair.volume.h1` is large: volume per trader is far above a retail ticket.
- `buyVol ≈ sellVol` to the dollar across windows with no price trend: ping-pong.
- Organic score low while raw volume ranks high.
- Candle volume evenly spaced in time (bot cadence) rather than bursty.

**What it is not:** high volume from a few big wallets that are *not* round-tripping (a whale accumulating) looks similar on share-of-volume alone; the buy/sell symmetry and price response distinguish them.

**Rule:** the KB describes the pattern; whether *this* token shows it comes from `get_trades`, `get_token.stats` and `get_candles` with their data ages.
