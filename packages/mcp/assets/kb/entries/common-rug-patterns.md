---
id: common-rug-patterns
title: Common rug patterns mapped to checkable chain facts
tags:
  - rug
  - rug-pull
  - honeypot
  - patterns
  - checklist
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://spl.solana.com/token (authorities)
  - https://spl.solana.com/token-2022/extensions (default account state, permanent delegate, transfer hook)
  - https://github.com/pump-fun/pump-public-docs (creator fields, PumpSwap lp_supply)
  - https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md (unlocked vs locked liquidity)
  - https://www.metaplex.com/docs/smart-contracts/token-metadata (Is Mutable)
  - dexterm SPEC.md §3.6 (forensics definitions)
---
Each pattern names the **mechanism**, the **chain fact that proves the capability exists**, and the dexterm field. A pattern is a capability, not an event: a token can have the capability and never use it.

| Pattern | Mechanism | Checkable fact | dexterm field |
|---|---|---|---|
| **LP pull** | LP-token holder withdraws both vaults; price → 0 | LP tokens not burned/locked; locker expiry | `rugcheck.lpLockedPct`, `audit.lpLockedPct` |
| **Freeze honeypot** | `FreezeAccount` on buyers' token accounts; only the deployer cluster can sell | `freezeAuthority` not null on the mint | `audit.freezeAuthority == true`, `rugcheck.risks` |
| **Token-2022 honeypot** | default-frozen accounts, transfer hook that blocks sells, permanent delegate pulls tokens | extension present on the mint | `rugcheck.tokenProgram == Token-2022`, GoPlus flags |
| **Mint-and-dump** | `MintTo` inflates supply into the pool | `mintAuthority` not null | `audit.mintAuthority == true` |
| **Bundled launch dump** | deployer's wallets bought a large float atomically at create and sell into the first bid | same-slot buys funded from one source | `get_dev_history.bundledPct`, `get_holders.labelled.sniper` |
| **Dev dump / slow rug** | creator or linked cluster distributes into strength | creator balance falling, transfers to fresh wallets | `audit.devPct`, `get_trades.devSells` |
| **Serial launcher** | same creator, many dead mints | creator's prior mints and their outcomes | `get_dev_history.devHistory.{launches,rugged}` |
| **Copycat ticker** | same symbol as a trending token; buyers hit the wrong mint | metadata symbol is not unique; mint is | `get_token` ambiguity → candidates (see `metadata-and-copycats`) |
| **Metadata swap** | mutable metadata renamed/re-imaged after listing | `Is Mutable` on the Metaplex metadata account | GoPlus `metadata_mutable` (read by the data layer as `metadataMutable`) |
| **Fake volume to trend** | wash trading to reach trending lists | few wallets dominate the tape | `get_trades.top2WalletVolumeSharePct`, organic score |

**Reading order used by the `rug-check` skill:** authorities → token program/extensions → LP → concentration and clusters → creator history → tape. Stop early with AVOID on a freeze/mint authority or a Token-2022 honeypot extension; otherwise weigh the rest.

**What this entry cannot say:** anything about a specific live token. The skill reads each field from a tool and cites the tool and data age.
