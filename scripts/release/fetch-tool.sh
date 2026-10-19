#!/usr/bin/env bash
# Fetch a pinned, checksum-verified scanner binary (scripts/release/fetch-tool.sh). No third-party GitHub
# Action is needed for gitleaks, osv-scanner or actionlint: the workflows download the exact release below
# and refuse anything whose SHA-256 differs. Bump a version by changing the table (checksums come from each
# project's release checksums file; the ones below were verified on 2026-10-09).
#
#   scripts/release/fetch-tool.sh <gitleaks|osv-scanner|actionlint> <dest-dir>     → prints the binary path
set -euo pipefail
tool="${1:?tool}"; dest="${2:?dest dir}"
mkdir -p "$dest"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
case "$arch" in x86_64|amd64) a64=amd64; ax=x64;; arm64|aarch64) a64=arm64; ax=arm64;; *) echo "unsupported arch $arch" >&2; exit 1;; esac

GITLEAKS_V=8.30.1; OSV_V=2.6.0; ACTIONLINT_V=1.7.12
case "$tool" in
  gitleaks)
    file="gitleaks_${GITLEAKS_V}_${os}_${ax}.tar.gz"; url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_V}/${file}"
    case "${os}_${ax}" in
      linux_x64)     sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb;;
      linux_arm64)   sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080;;
      darwin_x64)    sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709;;
      darwin_arm64)  sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5;;
      *) echo "no pinned gitleaks for ${os}_${ax}" >&2; exit 1;;
    esac; bin=gitleaks; archive=tar;;
  osv-scanner)
    file="osv-scanner_${os}_${a64}"; url="https://github.com/google/osv-scanner/releases/download/v${OSV_V}/${file}"
    case "${os}_${a64}" in
      linux_amd64)   sum=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108;;
      linux_arm64)   sum=2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4;;
      darwin_amd64)  sum=60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca;;
      darwin_arm64)  sum=98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4;;
      *) echo "no pinned osv-scanner for ${os}_${a64}" >&2; exit 1;;
    esac; bin=osv-scanner; archive=none;;
  actionlint)
    file="actionlint_${ACTIONLINT_V}_${os}_${a64}.tar.gz"; url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_V}/${file}"
    case "${os}_${a64}" in
      linux_amd64)   sum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8;;
      linux_arm64)   sum=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6;;
      darwin_amd64)  sum=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644;;
      darwin_arm64)  sum=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f;;
      *) echo "no pinned actionlint for ${os}_${a64}" >&2; exit 1;;
    esac; bin=actionlint; archive=tar;;
  *) echo "unknown tool $tool" >&2; exit 1;;
esac

if [ -x "$dest/$bin" ]; then echo "$dest/$bin"; exit 0; fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 180 -o "$tmp/$file" "$url"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | awk '{print $1}')"; else got="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"; fi
[ "$got" = "$sum" ] || { echo "checksum mismatch for $file: expected $sum got $got" >&2; exit 1; }
if [ "$archive" = tar ]; then tar -xzf "$tmp/$file" -C "$tmp" "$bin"; mv "$tmp/$bin" "$dest/$bin"; else mv "$tmp/$file" "$dest/$bin"; fi
chmod +x "$dest/$bin"
echo "$dest/$bin"
