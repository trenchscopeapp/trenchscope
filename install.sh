#!/usr/bin/env bash
# trenchscope installer. One line, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/trenchscopeapp/trenchscope/main/install.sh | bash
# Piped like that (or run outside a checkout), it first downloads the source into ~/.dexterm/app and
# re-runs itself from there. From a checkout it installs that checkout. TRENCHSCOPE_REPO / TRENCHSCOPE_REF pick
# another fork or branch; TRENCHSCOPE_TARBALL_URL (any curl URL, file:// too) replaces the download.
#
# dexterm installer (task-1305). User-level, no sudo, no shell-rc edits. It does four things:
#   1. make sure a Node >= 22.18 is available (dexterm runs its TypeScript sources via Node's built-in
#      type stripping, which needs 22.18+). If none is found, it downloads an official Node into
#      ~/.dexterm/node and verifies it against Node's published SHASUMS256.txt before using it.
#   2. link the workspace packages into node_modules (dexterm has NO third-party runtime deps, so this
#      needs no npm registry and works offline).
#   3. write a `dexterm` launcher into ~/.local/bin that runs the app with that Node.
#   4. (task-1325) build the native chart window (a ~1 MB Rust/wry binary) when `cargo` is installed; without
#      cargo, charts open in your browser and the installer prints the one command that enables the window.
#      DEXTERM_SKIP_SHELL=1 skips the build.
#
# It never edits your shell rc. If ~/.local/bin is not on PATH it tells you the one line to add.
# Re-running is safe (idempotent). Override locations with DEXTERM_PREFIX / DEXTERM_BIN, and pin a
# Node with DEXTERM_NODE_VERSION (e.g. v22.18.0); by default it uses the latest 22.x.
set -euo pipefail

PREFIX="${DEXTERM_PREFIX:-$HOME/.dexterm}"

# --- 0. no checkout here (curl | bash): fetch the source, then run its installer --------------------
SELF="${BASH_SOURCE[0]:-}"
if [ -z "$SELF" ] || [ ! -f "$(dirname "$SELF")/packages/cli/bin/trenchscope.mjs" ]; then
  REPO="${TRENCHSCOPE_REPO:-trenchscopeapp/trenchscope}"
  REF="${TRENCHSCOPE_REF:-main}"
  URL="${TRENCHSCOPE_TARBALL_URL:-https://codeload.github.com/$REPO/tar.gz/$REF}"
  printf '\033[1mDownloading trenchscope\033[0m (%s@%s)\n' "$REPO" "$REF"
  SRC_TMP="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$SRC_TMP/src.tar.gz"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$SRC_TMP/src.tar.gz" "$URL"
  else printf '\033[31m✗ need curl or wget to download trenchscope\033[0m\n' >&2; exit 1; fi
  mkdir -p "$SRC_TMP/src"
  tar -xzf "$SRC_TMP/src.tar.gz" -C "$SRC_TMP/src" --strip-components=1
  rm -rf "$PREFIX/app"; mkdir -p "$PREFIX"
  mv "$SRC_TMP/src" "$PREFIX/app"
  rm -rf "$SRC_TMP"
  exec bash "$PREFIX/app/install.sh"
fi

APP_DIR="$(cd "$(dirname "$SELF")" && pwd)"
BIN_DIR="${DEXTERM_BIN:-$HOME/.local/bin}"
NODE_CHANNEL="${DEXTERM_NODE_VERSION:-latest-v22.x}"
MIN_MAJOR=22
MIN_MINOR=18

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

printf '\033[1mInstalling trenchscope\033[0m\n'
say "source:  $APP_DIR"
say "node:    $PREFIX/node (only if one is downloaded)"
say "command: $BIN_DIR/trenchscope"
echo

# --- tools we rely on -------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
if have curl; then DL='curl -fsSL -o'; DLC='curl -fsSL'; elif have wget; then DL='wget -qO'; DLC='wget -qO-'; else DL=''; DLC=''; fi
if have shasum; then SHA='shasum -a 256'; elif have sha256sum; then SHA='sha256sum'; else SHA=''; fi

# node x.y.z >= MIN ?
node_ok() {
  local v; v="$("$1" -v 2>/dev/null | sed 's/^v//')" || return 1
  local maj min; maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  [ -n "$maj" ] || return 1
  [ "$maj" -gt "$MIN_MAJOR" ] || { [ "$maj" -eq "$MIN_MAJOR" ] && [ "$min" -ge "$MIN_MINOR" ]; }
}

# --- 1. Node ----------------------------------------------------------------
NODE_BIN=""
if node_ok "$PREFIX/node/bin/node"; then
  NODE_BIN="$PREFIX/node/bin/node"; ok "using the Node dexterm installed earlier ($("$NODE_BIN" -v))"
elif have node && node_ok node; then
  NODE_BIN="$(command -v node)"; ok "using the Node already on your PATH ($(node -v))"
else
  warn "no Node >= ${MIN_MAJOR}.${MIN_MINOR} found — downloading an official one (user-level, nothing system-wide)"
  [ -n "$DLC" ] || die "need curl or wget to download Node; install one, or install Node ${MIN_MAJOR}.${MIN_MINOR}+ yourself and re-run."
  [ -n "$SHA" ]  || die "need shasum or sha256sum to verify the download; install coreutils and re-run."

  case "$(uname -s)" in Darwin) OS=darwin;; Linux) OS=linux;; *) die "unsupported OS $(uname -s); install Node ${MIN_MAJOR}.${MIN_MINOR}+ yourself and re-run.";; esac
  case "$(uname -m)" in x86_64|amd64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) die "unsupported CPU $(uname -m); install Node ${MIN_MAJOR}.${MIN_MINOR}+ yourself and re-run.";; esac

  BASE="https://nodejs.org/dist/${NODE_CHANNEL}"
  say "fetching checksums from $BASE/SHASUMS256.txt"
  SUMS="$($DLC "$BASE/SHASUMS256.txt")" || die "could not reach nodejs.org — check your connection, or set DEXTERM_NODE_VERSION to a dist dir you can reach."
  FILE="$(printf '%s\n' "$SUMS" | grep -oE "node-v[0-9.]+-${OS}-${ARCH}\.tar\.gz" | head -n1)"
  [ -n "$FILE" ] || die "no Node build for ${OS}-${ARCH} in ${NODE_CHANNEL}."
  WANT="$(printf '%s\n' "$SUMS" | grep " $FILE\$" | awk '{print $1}')"
  [ -n "$WANT" ] || die "no checksum for $FILE."

  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  say "downloading $FILE"
  $DL "$TMP/$FILE" "$BASE/$FILE" || die "download failed."
  GOT="$($SHA "$TMP/$FILE" | awk '{print $1}')"
  [ "$GOT" = "$WANT" ] || die "checksum mismatch for $FILE (expected $WANT, got $GOT) — refusing to use it."
  ok "checksum verified against Node's SHASUMS256.txt"

  rm -rf "$PREFIX/node"; mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/$FILE" -C "$PREFIX/node" --strip-components=1
  NODE_BIN="$PREFIX/node/bin/node"
  node_ok "$NODE_BIN" || die "the downloaded Node did not run."
  ok "installed Node $("$NODE_BIN" -v) into $PREFIX/node"
fi

# --- 2. link the workspace packages (no third-party runtime deps) -----------
MODDIR="$APP_DIR/node_modules/@dexterm"
mkdir -p "$MODDIR"
# Link EVERY package under packages/ except cli (derived, not a hand list: a stale list broke a clean install
# with ERR_MODULE_NOT_FOUND for @dexterm/packs the moment that package was added).
LINKED=""
for dir in "$APP_DIR"/packages/*/; do
  pkg="$(basename "$dir")"
  [ "$pkg" = "cli" ] && continue
  [ -f "$dir/package.json" ] || continue
  ln -sfn "../../packages/$pkg" "$MODDIR/$pkg"
  LINKED="${LINKED:+$LINKED,}$pkg"
done
ok "linked @dexterm/{$LINKED} (no npm registry needed — dexterm has no third-party runtime deps)"

# --- 2b. the native chart window (task-1325) ---------------------------------
SHELL_DIR="$APP_DIR/packages/popup/shell/wry"
SHELL_BIN="$SHELL_DIR/target/release/dexterm-shell-wry"
if [ -x "$SHELL_BIN" ]; then
  ok "native chart window already built ($SHELL_BIN)"
elif [ "${DEXTERM_SKIP_SHELL:-}" = "1" ]; then
  warn "skipped the native chart window (DEXTERM_SKIP_SHELL=1) — charts open in your browser"
elif have cargo; then
  say "building the native chart window (Rust/wry, ~1 min the first time; fetches crates from crates.io)"
  if (cd "$SHELL_DIR" && cargo build --release --quiet); then
    ok "built $SHELL_BIN"
  else
    warn "the chart window did not build — charts open in your browser until you run: cd $APP_DIR/packages/popup && npm run build:shell"
  fi
else
  warn "no Rust toolchain (cargo) — charts open in your browser. For the docked chart window, install Rust (https://rustup.rs) and run:"
  printf '\n      cd %s/packages/popup && npm run build:shell\n\n' "$APP_DIR"
fi

# --- 3. the launcher --------------------------------------------------------
mkdir -p "$BIN_DIR"
# `trenchscope` is the command; `dexterm` stays as an alias so older notes and scripts keep working.
for name in trenchscope dexterm; do
  cat > "$BIN_DIR/$name" <<EOF
#!/bin/sh
# trenchscope launcher (generated by install.sh). Re-run the installer to update it.
exec "$NODE_BIN" "$APP_DIR/packages/cli/bin/$name.mjs" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
done
LAUNCHER="$BIN_DIR/trenchscope"
ok "wrote launchers $BIN_DIR/trenchscope and $BIN_DIR/dexterm"

# --- done -------------------------------------------------------------------
echo
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on your PATH";;
  *) warn "$BIN_DIR is not on your PATH. Add this line to your shell profile (this installer will not edit it):"
     printf '\n      export PATH="%s:$PATH"\n\n' "$BIN_DIR"
     say "or run trenchscope by full path: $LAUNCHER";;
esac
printf '\033[1mNext:\033[0m run \033[1mtrenchscope doctor\033[0m to check your machine, then \033[1mtrenchscope\033[0m to start.\n'
