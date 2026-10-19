# Verify your download

Three independent checks, weakest to strongest. Each takes under a minute. Replace `<version>` with the release you downloaded (for example `0.1.0`). Releases are published by the GitHub organisation `dexterm-xyz` (it is in the release URL).

## 1. Checksum: the file is byte-identical to what was published

Every release ships `SHA256SUMS`. Download it next to the artifact and compare.

```sh
# macOS
shasum -a 256 -c SHA256SUMS --ignore-missing
# Linux
sha256sum -c SHA256SUMS --ignore-missing
```

You should see `dexterm-<version>-src.tar.gz: OK`. Anything else means the file was altered or truncated: delete it and download again from the releases page.

What this proves: the bytes you hold match the bytes the pipeline hashed. What it does not prove: that the pipeline itself was honest. That is check 2.

## 2. Attestation: a public GitHub workflow built this exact file from a public commit

Each artifact listed in `SHA256SUMS` has a [build-provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) signed through Sigstore and stored by GitHub. The GitHub CLI verifies it:

```sh
gh attestation verify dexterm-<version>-src.tar.gz --owner dexterm-xyz
```

A good result names the repository, the workflow file (`.github/workflows/release.yml`), and the commit. Add `--format json` to read the full SLSA statement. To verify offline, first fetch the bundle once:

```sh
gh attestation download dexterm-<version>-src.tar.gz --owner dexterm-xyz     # writes <digest>.jsonl
gh attestation verify dexterm-<version>-src.tar.gz --owner dexterm-xyz --bundle <digest>.jsonl
```

The SBOM (`dexterm-<version>.cdx.json`) carries its own attestation, and the tarball additionally has an SBOM attestation linking the two:

```sh
gh attestation verify dexterm-<version>.cdx.json --owner dexterm-xyz
gh attestation verify dexterm-<version>-src.tar.gz --owner dexterm-xyz --predicate-type https://cyclonedx.org/bom
```

What this proves: the file with this hash was produced by that workflow, on GitHub's runners, from that commit, and nobody could have signed it without that workflow's identity. What it does not prove: that the source at that commit is safe. Read it; it is small.

## 3. npm provenance (once dexterm is on npm)

When the package is published it will carry an npm provenance statement pointing at the same workflow and commit:

```sh
npm view dexterm@<version> --json | grep -A3 '"provenance"'
npm audit signatures            # inside a project that depends on dexterm
```

## 4. Reproduce the build

The source tarball is `git archive` of the tagged commit, gzip'd without a timestamp (`gzip -n -9`), so the same commit always yields the same tar bytes. The release is built on Linux with GNU gzip; on Linux the rebuilt `.tar.gz` matches the `SHA256SUMS` line exactly. macOS ships a different gzip whose compressed bytes differ, so on a Mac compare the uncompressed tar of both files instead:

```sh
git clone https://github.com/dexterm-xyz/dexterm.git && cd dexterm && git checkout v<version>
node scripts/release/build.mjs --out /tmp/rebuild --version <version> --ref v<version>
shasum -a 256 /tmp/rebuild/dexterm-<version>-src.tar.gz       # Linux: must equal the SHA256SUMS line
gunzip -c /tmp/rebuild/dexterm-<version>-src.tar.gz | shasum -a 256   # macOS: must equal ...
gunzip -c dexterm-<version>-src.tar.gz | shasum -a 256                # ... the downloaded tarball's tar
node scripts/release/sbom.mjs --out /tmp/rebuild --version <version> --repo https://github.com/dexterm-xyz/dexterm
shasum -a 256 /tmp/rebuild/dexterm-<version>.cdx.json          # must equal the SHA256SUMS line (any OS)
```

## 5. The scan results

`scan-results.json` on every release (and on the trust page) lists, per artifact: the sha256, the VirusTotal report link with the per-engine summary, the attestation link and the verify command, and the SBOM link. It also lists the supply-chain checks (OpenSSF Scorecard, osv-scanner, npm audit, gitleaks, Socket). A `flagged` status is never removed; the note next to it says what we found. See [false-positives.md](false-positives.md).

What a clean scan proves: at that time, those engines did not recognise that exact file as known malware. What it does not prove: that the code is correct, that the data it shows is right, or that any token it displays is a good idea.
