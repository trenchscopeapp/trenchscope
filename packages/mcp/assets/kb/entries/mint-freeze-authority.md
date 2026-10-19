---
id: mint-freeze-authority
title: Mint authority and freeze authority (SPL Token)
tags:
  - spl-token
  - mint-authority
  - freeze-authority
  - honeypot
  - rug
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://spl.solana.com/token (retrieved 2026-09-30 into solana-launchpad/docs/spl-token/spl-token-overview.md)
  - https://github.com/solana-program/token (program source; InitializeMint, MintTo, FreezeAccount, SetAuthority)
  - dexterm SPEC.md §3.3 Audit model (mintAuthority/freezeAuthority booleans)
---
**Mechanics (from the SPL Token program).** A token type is a `Mint` account created with `InitializeMint`. Two optional authorities live on the mint:
- **mint authority**: can call `MintTo` and create new supply at will. It can be revoked by `SetAuthority` to `None`, after which supply is fixed forever. Tokens "when initially created by spl-token have no supply"; all supply is minted by this authority.
- **freeze authority**: "The Mint may also contain a `freeze_authority` which can be used to issue `FreezeAccount` instructions." A frozen token account cannot transfer or sell. It can also be revoked, and cannot be re-added once revoked.

Both are fields on the mint account, readable with `getAccountInfo(mint, jsonParsed)` (`mintAuthority`, `freezeAuthority`, `supply`, `decimals`). Jupiter's `audit` and GoPlus's `mintable`/`freezable` flags are derived from the same fields.

**Why a trader cares.**
- A live **mint authority** means the supply can be inflated at any time (mint-and-dump). Any market cap or "% of supply" number is provisional.
- A live **freeze authority** is the honeypot primitive on Solana: the authority can freeze buyers' token accounts selectively so they cannot sell while the deployer's cluster can. It is also used legitimately by some stablecoins and regulated assets, so it is a red flag on a memecoin, not proof of fraud.
- Launchpads differ: pump.fun creates coins with both authorities revoked by design (see `pump-bonding-curve`); tokens created by hand or through generic token creators on Raydium/Meteora can keep either authority.

**What this entry does NOT tell you:** whether *this* token's authorities are revoked. That is a per-mint fact; read it from `get_token.audit.mintAuthority` / `.freezeAuthority` (true = still enabled) or `rugcheck.risks`.
