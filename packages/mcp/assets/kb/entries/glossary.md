---
id: glossary
title: Trench glossary (terms as dexterm uses them)
tags:
  - glossary
  - terminology
  - trenches
  - slang
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - dexterm SPEC.md §3.3 (model), §3.6 (forensics definitions), §5.4 (verdict words)
  - https://github.com/pump-fun/pump-public-docs (bonding curve, migrate, king of the hill fields)
  - https://docs.meteora.ag/core-products/dbc/what-is-dbc.md (migration states)
---
Terms with the precise meaning dexterm attaches to them. Where a term is slang with no on-chain definition, that is said.

- **Trenches**: the stream of brand-new launches (minutes old, tiny market cap). "Trench scan" = screening that stream.
- **Bonding / on the curve**: a pump.fun, LaunchLab or DBC token still trading on its launch curve, before migration. **Bonding progress**: share of the curve's real token reserve sold.
- **Graduation / migration / "bonded"**: the curve completed and a real AMM pool was created (PumpSwap, Raydium CPMM, DAMM v2). On pump.fun `migrate` is permissionless.
- **KOTH (king of the hill)**: pump.fun's label for the curve token with the highest market cap at the moment; a UI concept, not a program state.
- **Mcap vs FDV**: market cap uses circulating supply, FDV uses total supply. For a 1 B-supply memecoin with no locked supply they are equal; `pair.mcap` and `pair.fdv` are both carried.
- **Dev**: the creator address (`BondingCurve.creator` / `coin_creator` / LaunchLab creator); **dev %** = its balance share plus linked wallets (SPEC §3.6).
- **Sniper**: a wallet that bought in the first 3 blocks or first 2 s on a curve (SPEC §3.6). **Bundle / bundled %**: supply bought in the launch transaction or by wallets funded from one source within 60 s of launch.
- **Rug / rug pull**: liquidity or supply mechanics used against holders (see `common-rug-patterns`); **soft rug / slow rug**: the creator cluster sells over time instead of pulling LP; **honeypot**: holders cannot sell (freeze authority, Token-2022 extension or hook).
- **LP burned / locked**: see `lp-burn-vs-lock`. **Unlocked LP**: withdrawable by its holder now.
- **Jeet** (slang): a holder who sells early into any strength; no on-chain definition. **Paper hands / diamond hands**: same, slang.
- **CTO (community takeover)** (slang): the original creator is gone and holders promote the token; DexScreener has a `community-takeovers` endpoint that lists claimed CTOs.
- **Moon bag** (slang): the remainder left after taking profit; in an order plan, the share excluded from the sell legs.
- **Cabal** (slang): coordinated group early on many launches; see `cabal-and-coordinated-launches`.
- **Organic score**: Jupiter's 0–100 genuineness score; see `wash-trading-fake-volume`.
- **Verdict words (SPEC §5.4)**: **WATCH** (worth tracking, no disqualifier), **SPECULATIVE** (no disqualifier found, but material risks that the answer must state), **AVOID** (a disqualifier is present), plus **INSUFFICIENT_DATA** and **AMBIGUOUS** from the skill schema. None is a recommendation to buy or sell.
