---
id: launchlab-curve
title: Raydium LaunchLab curves, graduation and the CPMM handoff
tags:
  - raydium
  - launchlab
  - letsbonk
  - bonding-curve
  - graduation
  - fees
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://docs.raydium.io/products/launchlab/bonding-curve.md (retrieved 2026-09-30 into solana-launchpad/docs/raydium/launchlab-bonding-curve.md)
  - https://docs.raydium.io/products/launchlab/platform-config.md (solana-launchpad/docs/raydium/launchlab-platform-pda.md)
  - https://docs.raydium.io/products/cpmm/fees.md (creator fee only on InitializeWithPermission pools)
---
**Curve types** (selected at `Initialize`, stored in `LaunchState.curve_type`): `0` constant-product with virtual reserves (the pump-style default), `1` fixed-price, `2` linear-price (cost quadratic in tokens sold: "early buyers pay close to zero, late buyers pay substantially more").

**Supply split:** `base_supply_graduation` is "usually 0.8 × base_supply_max; the remaining 20 % becomes the post-graduation pool's initial LP". `quote_reserve_target = cost(0, base_supply_graduation) × (1 + buy_fee_rate)`; the launch graduates when `quote_vault.balance ≥ quote_reserve_target`.

**Fees on the curve:** per-buy `gross_fee = ceil(quote_in × buy_numerator / buy_denominator)` (e.g. 100/10,000 = 1 %), split into `lp_share` (stays in the quote vault), `protocol_share`, `creator_share` (accrues to `creator_fees_quote`).

**Handoff:** at `Graduate`, `cpmm_quote_reserve = quote_vault − swept protocol fees − swept creator fees`, `cpmm_base_reserve = base_vault`, and for the constant-product curve the CPMM opening price equals the curve's marginal price, "so an observer switching from the curve UI to the CPMM UI sees no jump". Only CPMM pools created via `InitializeWithPermission` (LaunchLab graduations) have `enable_creator_fee = true`.

**Platforms:** third-party front ends (LetsBonk is one) are *platform PDAs* with their own fee share and defaults; the launchpad label in dexterm (`bonk`, `raydium`) comes from Jupiter's `launchpad` field.

**Trader reading:** a LaunchLab token on a linear curve has a steep late-buyer price; "graduated" means a Raydium CPMM pool now exists, seeded with the supply left after the curve (usually 20 %) as its base side; the creator earns fees for as long as the pool trades. LaunchLab has no public REST for per-mint state that worked in the inventory probe (500 on a guessed `platformId`), so state is read on-chain.
