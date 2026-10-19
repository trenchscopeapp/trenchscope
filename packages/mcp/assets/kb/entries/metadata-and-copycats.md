---
id: metadata-and-copycats
title: Token metadata, mutable names and why the ticker is not an identifier
tags:
  - metaplex
  - metadata
  - copycat
  - ticker
  - symbol
  - mint
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://www.metaplex.com/docs/smart-contracts/token-metadata (retrieved 2026-09-30 into solana-launchpad/docs/metaplex/token-metadata-overview.md)
  - https://github.com/pump-fun/pump-public-docs (create(user, name, symbol, uri, creator))
  - dexterm SPEC.md §5.3 CL-05 analogue (tools take mints; symbol resolution prefers the row on screen)
---
**Where the name comes from.** A mint account holds supply, decimals and authorities, nothing human-readable. The Metaplex Token Metadata program attaches a **Metadata account** (PDA from the mint) with `name`, `symbol`, a `URI` to off-chain JSON (image, description, socials), a creators list with a `Verified` flag, and an `Is Mutable` attribute. pump.fun's `create(user, name, symbol, uri, creator)` writes these at creation.

**Consequences.**
- **Symbols are free text.** Anyone can create a token with the same name and symbol as a well-known one. There can be hundreds of mints with the same symbol; the mint address is the only identifier. dexterm's `get_token` returns *candidates* when a symbol is ambiguous and the skills must disambiguate by mint (or by the row on screen) before saying anything.
- **Mutable metadata** (`Is Mutable` true) lets the update authority rename and re-image a token after it has been listed, which is how a dead mint is recycled into a trending name. Immutable metadata cannot be changed on-chain; the off-chain JSON stays fixed only if the URI also points at permanent storage (such as Arweave). GoPlus reports `metadata_mutable`.
- **Off-chain URI content is untrusted text.** The description, socials and image live wherever the URI points; they can be changed if the URI host is mutable, and they are the main carrier of prompt-injection text. dexterm firewalls every such string (SPEC §5.3) and the analyst treats `<untrusted>` blocks as data.
- **Verified creators** are signed by the creator key; an unverified creator entry is a claim, not a proof.

**Rule for skills:** identify a token by mint in every output (`mint` field in the schema); never by symbol alone. When the user names a symbol and the tool returns more than one candidate, return `AMBIGUOUS` with the candidates instead of guessing.
