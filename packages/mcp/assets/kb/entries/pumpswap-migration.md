---
id: pumpswap-migration
title: PumpSwap migration and post-graduation pools
tags:
  - pump.fun
  - pumpswap
  - migration
  - graduation
  - lp
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md (retrieved 2026-10-01 into solana-launchpad/docs/pump-fun/pumpswap-overview.md)
  - https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md (fees)
---
**What it is.** PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) is pump.fun's own constant-product AMM. A completed bonding curve migrates here automatically (the `migrate` instruction on the Pump program is permissionless). Pools created by `migrate` use `CANONICAL_POOL_INDEX == 0`.

**Fees (GlobalConfig PDA `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`):** `lp_fee_basis_points` 20 (0.20 %) + `protocol_fee_basis_points` 5 (0.05 %) = **0.25 % per swap**, plus the coin-creator fee where one applies (the protocol sets its rate); no fee on deposit/withdraw. Protocol fees go to one of 8 recipient pubkeys chosen at random per tx.

**Pool account** (PDA seeds `["pool", index, creator, baseMint, quoteMint]`): `base_mint`, `quote_mint`, `lp_mint` (PDA `["pool_lp_mint", pool]`), vault ATAs, `lp_supply` (**total LP supply excluding user burns**), `coin_creator` (accrues creator fees), `virtual_quote_reserves` (i128; the docs, retrieved 2026-10-01, say it can be negative "starting September 30"; quoting must use `pool_quote_token_account.amount + virtual_quote_reserves`).

**What "graduated" means for risk:** after migration the liquidity is a real AMM pool with an LP mint. Because `lp_supply` excludes burns, a pool whose LP has been burned shows a reduced `lp_supply`; RugCheck's `lpLockedPct` for pump.fun/PumpSwap pairs is treated as 100 % in dexterm (SPEC §3.6) because the migrated liquidity is not held by the creator. The creator still earns `coin_creator` fees on every swap, which is an incentive to keep the pool trading, and also an incentive to launch many coins.

**Holder rewards:** when `is_holder_reward == true`, the creator fee is distributed to holders instead; `BuyEvent`/`SellEvent` carry `holder_rewards_bps`.

**Tool mapping:** `get_token.pair.dex == "pumpswap"` identifies a graduated coin; `rugcheck.lpLockedPct`; the pool address is `pair.pairAddress`.
