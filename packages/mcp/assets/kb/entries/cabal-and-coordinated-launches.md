---
id: cabal-and-coordinated-launches
title: Cabals: repeat co-buyers across launches and how dexterm would detect them
tags:
  - cabal
  - coordination
  - kol
  - labels
  - wallet-intelligence
date: 2026-10-06
confidence: low
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - dexterm research/data-firehose-inventory-2026-10-06.md §1f and §4 item 6 (no credible open label dataset; in-house labels from recorded history)
  - dexterm ROADMAP.md pillar 2 and legal flag on wallet labelling accuracy
  - dexterm SPEC.md §3.6 (Bundled %, Snipers definitions)
---
**Term.** In trench slang a *cabal* is a group (often KOLs, launch teams and their bots) that coordinates entries and exits across many tokens: they are early on each launch, promote it, and sell into the audience. It is a social claim about intent; on-chain it reduces to **the same wallets (or wallets funded from the same sources) appearing early on many launches that later dump**.

**What is observable, and what dexterm can build (inventory §1f):** there is no credible open dataset of KOL/cabal wallets (GitHub search tops out at 7 stars; Nansen/Arkham/GMGN/Cielo are keyed or paid). The in-house path is: record every watched launch's first-N-slot buyers and their funding sources (Helius `getTransactionsForAddress`), store them, and score wallets on *early-entry rate*, *co-occurrence* with the same other wallets, and *realised PnL* of their exits. A "cabal candidate" is a cluster of wallets that co-occur early on ≥ k launches where the launches' later outcome was a dump. Thresholds and k are to be set from recorded history, not guessed.

**Why confidence is low.** Until the local history recorder holds enough recorded launches to set the thresholds, this is a method, not a measurement. Co-occurrence also catches honest copy-traders and popular snipers. Mislabelling a real person's wallet as "cabal" is the labelling-accuracy legal flag in ROADMAP (counsel before anything public); inside dexterm labels are **private, evidence-linked and reversible** (`WalletLabel.evidence[]`).

**Judgement (maintainers, reviewed 2026-10-15):** the useful trader signal is not "cabal yes/no" but "who holds the early float and what did those wallets do last time". Case files with verified outcomes (see `case_lookup`) are where this becomes checkable.

**Rule:** never assert that a specific wallet is a cabal member from memory or from a KB entry; only from a label record with evidence returned by a tool.
