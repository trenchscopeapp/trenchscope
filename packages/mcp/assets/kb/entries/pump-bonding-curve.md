---
id: pump-bonding-curve
title: pump.fun bonding curve mechanics
tags:
  - pump.fun
  - bonding-curve
  - graduation
  - fees
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://github.com/pump-fun/pump-public-docs (README, retrieved 2026-10-01 into solana-launchpad/docs/pump-fun/docs-overview.md)
  - https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md (solana-launchpad/docs/pump-fun/fees.md)
---
**What it is.** The Pump program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) creates an SPL coin that is instantly tradeable on a constant-product curve with *synthetic* (virtual) reserves, Uniswap-v2 style. When the real token reserve is sold out the curve is `complete` and liquidity migrates to PumpSwap.

**Numbers from the on-chain `Global` config (PDA `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`), as documented when retrieved 2026-10-01 (the config can change; a tool reads the live values):**
- `initial_virtual_token_reserves` 1,073,000,000,000,000; `initial_virtual_sol_reserves` 30,000,000,000 lamports (30 SOL); `initial_real_token_reserves` 793,100,000,000,000; `token_total_supply` 1,000,000,000,000,000 (1 B tokens at 6 decimals).
- `fee_basis_points` 100 = **1 %** on every buy and sell, paid to one of 8 fee-recipient accounts. A creator fee, when the coin has one, comes on top (the protocol sets its rate for SOL- and USDC-paired coins).
- `pool_migration_fee` 15,000,001 lamports (~0.015 SOL) charged by `migrate`.

**Per-coin `BondingCurve` account** (PDA seeds `["bonding-curve", mint]`): `virtual_token_reserves`, `virtual_sol_reserves` (pricing), `real_token_reserves`, `real_sol_reserves`, `complete` (true when `real_token_reserves == 0`), `creator` (accrues creator fees), `quote_mint` (default pubkey for SOL-paired coins), `is_holder_reward`.

**Instructions:** `create`, `buy(amount, max_sol_cost)`, `sell(amount, min_sol_output)`, the v2 variants (`buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, all accounts mandatory), and `migrate(user, mint)` which is **permissionless**: anyone can trigger the migration once the curve is complete.

**How to read "bonding progress":** progress = 1 − `real_token_reserves` / `initial_real_token_reserves`. The curve's price at any moment is `virtual_sol_reserves / virtual_token_reserves`. "Graduation" = `complete` flipped to true, followed by a `migrate` instruction that creates the PumpSwap pool (see `pumpswap-migration`).

**What a trader can and cannot infer:** a pump.fun coin is created with its mint and freeze authority revoked (the program creates it that way; verify it on the mint account with a tool), and pre-graduation there is no LP token to lock or burn because liquidity lives in the curve PDA. The risks on the curve are **holder concentration, bundled first buys and the creator's behaviour**, not authorities or LP.

**Tool mapping in dexterm:** `get_token` (launchpad, age, mcap), `get_dev_history` (creator, bundle share), `get_holders`. The `pumpfun` frontend API (S8) is undocumented and feature-flagged; the compliant source for curve state is the on-chain account via Helius.
