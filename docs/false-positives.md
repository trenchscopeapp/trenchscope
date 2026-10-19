# Scan results, false positives, and what we do about them

Every release artifact is uploaded to VirusTotal by the release workflow and re-scanned weekly; the results are published, unedited, in `scan-results.json` and on the trust page. This page explains what you may see there and how we respond.

## Why a clean CLI can get flagged

VirusTotal runs about 70 engines. A few of them score files by heuristics rather than signatures, and some patterns in dexterm are exactly what those heuristics watch for:

- it opens WebSockets to several hosts and polls HTTP APIs in a loop;
- it reads a key file from your home directory (`~/.dexterm/helius.key`) if you create one;
- it starts a local HTTP server (loopback only) and launches a browser or a native window;
- the installer downloads a Node.js runtime and verifies it against Node's published checksums;
- it is a source tarball: some engines do not scan archives of text at all and report `type-unsupported`, which the summary counts as `undetected` (the note says how many).

None of this is malware behaviour, but "unknown file, network, reads a credential, spawns processes" is a generic-trojan heuristic in several products. An unsigned, freshly built file with zero prevalence scores worse than a popular one; the first release is the most likely to collect a flag or two.

## What we do when an engine flags a release

1. The result stays visible. `status: flagged`, the engine names and their labels, and the report link are published as returned. We do not re-upload, re-build or re-roll to get a cleaner number.
2. We reproduce: download the exact artifact, verify the sha256 and the attestation, and confirm the flagged file is the one the workflow built.
3. We look for a cause on our side: a changed dependency, a new network host, a new spawned process, an unexpected binary in the archive. The SBOM and the reproducible tarball make this a diff, not a guess.
4. We write the outcome into the `note` next to the result and link the issue. If it is a genuine problem we fix it and release again (the new version gets its own scans). If it is a false positive we say so, say why, and, where the engine has a process for it, submit the file for review.
5. The weekly re-scan shows whether the engine updated its verdict.

## How you can check instead of trusting us

- `gh attestation verify <file> --owner dexterm-xyz` proves which workflow and commit built the file.
- The source tarball is `git archive` of that commit; you can rebuild it and compare hashes ([verify-your-download.md](verify-your-download.md)).
- The SBOM lists every third-party component; dexterm has none at runtime except the vendored TradingView Lightweight Charts, whose file hash is in the SBOM and matches the npm release.
- `dexterm doctor` lists every host the app talks to; the trust page explains each.

A clean scan is not a certificate. Readable source, reproducible builds and your own review are what make software trustworthy; the scans are one more check.
