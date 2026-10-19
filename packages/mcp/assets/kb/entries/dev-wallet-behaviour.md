---
id: dev-wallet-behaviour
title: Dev (creator) wallets: where the address comes from and what to watch
tags:
  - dev
  - creator
  - dev-wallet
  - forensics
  - creator-fees
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://github.com/pump-fun/pump-public-docs (BondingCurve.creator; PumpSwap Pool.coin_creator; holder rewards)
  - https://developers.jup.ag/docs/tokens (retrieved 2026-09-30; audit fields devBalancePercentage, devMints, isSus)
  - dexterm research/data-firehose-inventory-2026-10-06.md §1d (RugCheck new_tokens.creator)
  - dexterm SPEC.md §3.6 (Dev % definition)
---
**Where "the dev" is defined on-chain.** On pump.fun the `BondingCurve.creator` field "accrues creator fees" and carries over to `PumpSwap Pool.coin_creator` after migration; the `create` instruction's signer is the deploying wallet. On Raydium LaunchLab the creator share of fees accrues to `creator_fees_quote`. On Meteora DBC the creator is the VirtualPool deployer. These are facts a tool reads; dexterm exposes them as `get_dev_history.creator`.

**Derived signals.** Jupiter `audit.devBalancePercentage` (creator's share of supply) and `audit.devMints` (how many tokens this creator has launched) and `audit.isSus`; RugCheck `new_tokens.creator` for fresh mints. SPEC §3.6: **Dev % = creator wallet's current balance share plus linked wallets when clustering is available.**

**Why creator fees change behaviour.** Since pump.fun and LaunchLab pay creators a share of every swap, a creator earns from *volume*, not only from selling supply. A creator who keeps zero supply but earns fees has an incentive to keep the token trading; a creator holding 15–20 % has the opposite option. With `is_holder_reward` set, the fee goes to holders instead, which removes that incentive from the creator.

**Patterns worth a flag (maintainers, reviewed 2026-10-15):**
- Creator has many prior mints (`devMints` high) and most are dead: serial launcher.
- Creator balance falling while price rises: distribution into strength.
- Creator transfers supply to fresh wallets before launch: shows as "bundled" or as many same-funded holders (see `holder-concentration`).
- Creator sells to zero in the first hour: not always bad on pump.fun (fees still accrue), but the token is now "CTO or nothing".

**Rule:** the creator address and its history are per-token facts. Read them from `get_dev_history`; never from memory.
