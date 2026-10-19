#!/usr/bin/env bash
# Install smoke (task-1423): pack the CLI the way npm would publish it, install the tarball globally into a
# throwaway prefix with a throwaway HOME, and run the installed `dexterm` command. Runs on Linux, macOS and
# Windows (Git Bash on GitHub's windows runners). Offline: no live data source is contacted.
#
#   scripts/release/install-smoke.sh [work-dir]      (default: a fresh mktemp dir; run from the repo root)
#
# Exit 0 only if `npm pack`, `npm i -g`, `trenchscope --version` (prints the package version) and `trenchscope doctor`
# (no `fail` check; a missing `claude` is only a warning) all succeed.
set -euo pipefail
work="${1:-$(mktemp -d)}"
# Windows runners hand over $RUNNER_TEMP as D:\a\_temp; Git Bash wants /d/a/_temp
if command -v cygpath >/dev/null 2>&1; then work="$(cygpath -u "$work")"; fi
mkdir -p "$work/pack" "$work/prefix" "$work/home"
work="$(cd "$work" && pwd)"

echo "== npm pack (packages/cli; prepack compiles dist/)"
npm pack --workspace packages/cli --pack-destination "$work/pack" >/dev/null
tgz="$(ls "$work/pack"/*.tgz)"
echo "packed: $(basename "$tgz")"
want="$(node -p "require('./packages/cli/package.json').version")"

echo "== npm i -g into a temp prefix"
npm install --global --no-audit --no-fund --prefix "$work/prefix" "$tgz"

# npm's global layout: <prefix>/bin/<cmd> on POSIX, <prefix>/<cmd>(.cmd|.ps1) on Windows.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) bindir="$work/prefix"; is_windows=1;;
  *) bindir="$work/prefix/bin"; is_windows=0;;
esac
[ -e "$bindir/dexterm" ] || { echo "FAIL: no trenchscope shim in $bindir" >&2; ls -la "$bindir" >&2; exit 1; }

# a fresh user: nothing from the runner's home leaks in, nothing is written outside the work dir
export HOME="$work/home" USERPROFILE="$work/home" DEXTERM_HOME="$work/home/.dexterm"
export DEXTERM_OFFLINE=1 NO_COLOR=1
export PATH="$bindir:$PATH"
cd "$work"  # away from the checkout, so nothing resolves from the workspace node_modules

echo "== trenchscope --version"
got="$(trenchscope --version | tr -d '\r')"
echo "$got"
[ "$got" = "$want" ] || { echo "FAIL: trenchscope --version printed '$got', package.json says '$want'" >&2; exit 1; }

if [ "$is_windows" = 1 ]; then
  echo "== dexterm.cmd --version (the shim cmd.exe and PowerShell users run)"
  got="$(cmd.exe //d //c "dexterm.cmd --version" | tr -d '\r')"
  echo "$got"
  [ "$got" = "$want" ] || { echo "FAIL: dexterm.cmd --version printed '$got'" >&2; exit 1; }
fi

echo "== trenchscope doctor"
trenchscope doctor

echo "== trenchscope --help"
trenchscope --help >/dev/null

echo "install smoke: PASS ($(uname -s), node $(node --version), $(basename "$tgz"))"
