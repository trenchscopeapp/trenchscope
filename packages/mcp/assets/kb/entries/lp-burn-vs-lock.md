---
id: lp-burn-vs-lock
title: LP tokens, burn vs lock, and what lpLockedPct means
tags:
  - lp
  - liquidity
  - burn
  - lock
  - rug
  - raydium
  - meteora
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md (lp_supply excludes burns)
  - https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md (retrieved 2026-09-30; locked/vesting liquidity, 10 % permanent lock rule, 0.2 % migration fee)
  - https://docs.raydium.io/products/cpmm/fees.md (retrieved 2026-09-30; LP fee stays in the vault, owned pro-rata by LP tokens)
  - dexterm SPEC.md §3.6 (LP locked definition; pump.fun/PumpSwap treated as 100 %)
---
**Mechanics.** On a constant-product AMM (Raydium CPMM, PumpSwap, Meteora DAMM) the liquidity provider receives LP tokens that represent a pro-rata claim on both vaults; "the LP fee is never explicitly tracked — it remains in the vault as a reserve that all LP tokens proportionally own" (Raydium CPMM docs). Whoever holds the LP tokens can withdraw the pool's SOL and tokens. A "rug pull" in the narrow sense is the LP holder withdrawing liquidity, which drives the price to ~0 for everyone else.

**Burn:** sending the LP tokens to an unrecoverable state (SPL `Burn`). PumpSwap's `Pool.lp_supply` is documented as "total LP supply excluding user burns", so a burned LP shows up as reduced supply. Burned liquidity can never be withdrawn, but it also cannot be migrated or upgraded.

**Lock:** LP tokens held by a locker program or a vesting position with a release date. Meteora DBC graduations distribute DAMM v2 liquidity into positions that are *unlocked*, *permanently locked* ("cannot be withdrawn; earns trading fees forever") or *vesting* ("cliff + linear or periodic releases"), and "the config must ensure at least 10 % of liquidity is permanently locked on day 1 for the standard keeper to migrate the pool". A lock has an expiry; a permanent lock does not.

**What the number means in dexterm:** `rugcheck.lpLockedPct` is RugCheck's estimate of the share of LP that is burned or locked. SPEC §3.6: pump.fun/PumpSwap pools are treated as 100 % because migrated liquidity is not held by the creator. Anything below 100 % on a Raydium/Meteora pair means someone can pull that share.

**Judgement (maintainers, reviewed 2026-10-15):** "LP locked" is necessary, not sufficient. A 100 % locked LP with a live freeze authority is still a honeypot; a locked LP with 60 % supply in the deployer's cluster can still be dumped into the pool. Read LP together with authorities (`mint-freeze-authority`) and concentration (`holder-concentration`). A lock with a short expiry is a timer, not safety.
