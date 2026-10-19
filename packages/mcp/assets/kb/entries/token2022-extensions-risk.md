---
id: token2022-extensions-risk
title: Token-2022 extensions a trader must check
tags:
  - token-2022
  - transfer-fee
  - transfer-hook
  - permanent-delegate
  - honeypot
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://spl.solana.com/token-2022/extensions (retrieved 2026-09-30 into solana-launchpad/docs/spl-token/token2022-extensions.md)
  - Token-2022 program id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (solana-launchpad/docs/INDEX.md gap note)
---
Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) adds extensions to mints and token accounts. A token's program id tells you which rules apply (`rugcheck.tokenProgram`, GoPlus fields). Extensions that change what a holder can do:

| Extension | What the docs say | Trader reading |
|---|---|---|
| **Transfer fee** | "On every transfer, some amount is withheld on the recipient account, untouchable by the recipient"; fee in basis points plus a maximum fee; a *withdraw withheld authority* can collect it. | A tax on every trade. Check the bps and who holds the withheld-withdraw authority. A fee authority can raise the fee later. |
| **Default account state** | "can force all new token accounts to be frozen. Users must interact with some service to unfreeze." | Buyers start frozen: a honeypot by construction unless the project unfreezes everyone. |
| **Permanent delegate** | "unlimited delegate privileges over any account for that mint, meaning that it can burn or transfer any amount of tokens." | The issuer can take tokens out of your wallet. Disqualifying for a memecoin. |
| **Transfer hook** | Token-2022 "calls into the program" the creator deployed on every transfer. | Arbitrary code on every transfer: can block sells, whitelist wallets, or tax. Treat it as unknown until you have read what the hook program does; an upgradeable hook can change later. |
| **Non-transferable** | "soul-bound" tokens; the owner can still burn and close. | Cannot be sold at all. |
| **Mint close authority** | the mint can be closed; "closing and reinitializing a mint with different extensions can lead to problems if any token accounts exist". | Rare on memecoins. A mint can only be closed while its supply is zero, so it cannot be closed under holders who still hold tokens; the risk is to empty token accounts left behind if it is closed and re-created. |
| **Interest-bearing** | "entirely cosmetic"; no new tokens are created. | UI balance grows, value does not. |
| **CPI guard, immutable owner, required memo** | protections for the account owner. | Neutral. |

**Mapping:** GoPlus Solana token-security returns `transfer_fee`, `transfer_hook`, `default_account_state`, `non_transferable`, `balance_mutable_authority`, `closable`; dexterm surfaces the dangerous ones through `rugcheck.risks` and the Audit record. A legacy SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) has none of these: only mint and freeze authority matter (see `mint-freeze-authority`).
