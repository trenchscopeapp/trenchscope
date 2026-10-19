---
id: dbc-mechanics
title: Meteora Dynamic Bonding Curve (DBC) lifecycle and migration
tags:
  - meteora
  - dbc
  - bonding-curve
  - migration
  - damm-v2
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://docs.meteora.ag/core-products/dbc/what-is-dbc.md (retrieved 2026-09-30 into solana-launchpad/docs/meteora/dbc-overview.md)
  - https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md (solana-launchpad/docs/meteora/dbc-migration.md)
  - https://docs.meteora.ag/core-products/dbc/fees/rate-limiter.md (solana-launchpad/docs/meteora/dbc-rate-limiter.md)
---
**Program:** `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (pool authority PDA `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`). A *partner* (launchpad front end) or creator publishes a `PoolConfig` (curve shape with 1–16 segments, fee scheduler, migration settings, liquidity distribution); creators deploy a `VirtualPool` from it.

**States:** `PreBondingCurve` (not yet tradeable) → `PostBondingCurve` (trading on the curve) → `MigrationOngoing` (quote threshold hit) → `CreatedPool` (DAMM v2 pool live). "Swaps are only possible in `PostBondingCurve`; migration is only possible after the quote threshold is reached."

**Graduation:** when the pool's quote balance reaches `migration_quote_threshold`, a keeper (Meteora runs two: `Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs`, `DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW`) or the manual migrator calls migrate. Standard-keeper thresholds are set per quote mint (10 SOL, 750 USDC as retrieved 2026-09-30; Meteora's migration docs list the other supported quote mints and their thresholds). New configs must migrate to **DAMM v2** (v1 deprecated); a **0.2 % protocol liquidity migration fee** is deducted; the DAMM v2 pool opens at the curve's final price.

**Liquidity after migration:** split into unlocked / permanently locked / vesting positions per config; at least 10 % must be permanently locked on day 1 for the standard keeper to migrate (see `lp-burn-vs-lock`).

**Anti-sniper design that existed and is now deprecated:** the *rate limiter* base-fee mode raised the fee with buy size during the first ≤ 12 h (`max_limiter_duration` ≤ 43,200 s) and "does not apply to sells". New configs use fee schedulers (linear/exponential decay) plus optional dynamic fees instead, so **early-buy fees on DBC launches are time-based, not size-based**, and a big first buy is not penalised unless the scheduler's starting fee is high.

**Reading a DBC token in dexterm:** `launchpad == "dbc"` (Jupiter `met-dbc`, Gecko `meteora-dbc`). The config is per partner, so the *same* program hosts launches with very different fee and lock rules; the config address decides, and there is no public REST for DBC state (inventory §1b), so curve state is read on-chain.
