#!/bin/zsh
# task-1329 measurement + full-suite driver (detached; poll the log). Phases:
#   A  seed: 150 s live run with the recorder on (fresh DB) → then shift every mint's live rows 65 min into the past
#      so the 1 h horizon is due at the next maintenance tick (a REAL outcome sweep against DexScreener, low priority)
#   B  measure: 360 s live run, recorder ON, calm, --verbose (request log) → CPU, DB growth, stats, sweep lines
#   C  baseline: 360 s live run, recorder OFF (--no-recorder), calm → CPU
#   D  full suite per file, no --test-force-exit, 300 s alarm each, loop/guard excluded (known hangers)
set -u
cd "$(dirname "$0")/../../.." || exit 2
OUT=/tmp/r01-measure; mkdir -p "$OUT"
DB="$OUT/dexterm.db"; rm -f "$DB" "$DB-wal" "$DB-shm"
LOG="$OUT/measure.log"; : > "$LOG"
PY=/usr/bin/python3
echo "=== phase A seed $(date -u +%FT%TZ)" >> "$LOG"
perl -e 'alarm 240; exec @ARGV' $PY -I packages/recorder/tools/measure-live.py --seconds 150 --db "$DB" -- --calm --verbose >> "$LOG" 2>&1
echo "--- shifting live rows 65 min into the past" >> "$LOG"
sqlite3 "$DB" "UPDATE token_snapshots SET t = t - 3900000, next_due_t = CASE WHEN next_due_t > 0 THEN next_due_t - 3900000 ELSE 0 END; UPDATE mints SET first_t = first_t - 3900000, last_live_t = last_live_t - 3900000, last_any_t = last_any_t - 3900000, last_t0_t = last_t0_t - 3900000; UPDATE feed_members SET t = t - 3900000; SELECT COUNT(*) || ' mints shifted' FROM mints;" >> "$LOG" 2>&1
echo "=== phase B recorder ON $(date -u +%FT%TZ)" >> "$LOG"
perl -e 'alarm 480; exec @ARGV' $PY -I packages/recorder/tools/measure-live.py --seconds 360 --db "$DB" -- --calm --verbose >> "$LOG" 2>&1
cp "$OUT/dexterm.db" "$OUT/dexterm-after-B.db" 2>/dev/null
echo "=== phase C recorder OFF $(date -u +%FT%TZ)" >> "$LOG"
DB2="$OUT/dexterm-off.db"; rm -f "$DB2" "$DB2-wal" "$DB2-shm"
perl -e 'alarm 480; exec @ARGV' $PY -I packages/recorder/tools/measure-live.py --seconds 360 --db "$DB2" -- --calm --no-recorder >> "$LOG" 2>&1
pkill -f 'packages/cli/bin/dexterm.mjs --no-boot' 2>/dev/null
echo "=== phase D full suite $(date -u +%FT%TZ)" >> "$LOG"
SLOG="$OUT/suite.log"; : > "$SLOG"
tp=0; tf=0; files=0; hung=(); failed=(); noSummary=()
for f in packages/*/test/*.test.ts; do
  case "$f" in *loop.test.ts|*guard.test.ts) echo "SKIP   $f (known hanger, excluded per brief)" >> "$SLOG"; continue;; esac
  files=$((files+1))
  out=$(perl -e 'alarm 300; exec @ARGV' node --test --test-concurrency=1 --test-timeout=60000 "$f" 2>&1); rc=$?
  p=$(printf '%s\n' "$out" | grep -E '^ℹ pass ' | tail -1 | awk '{print $3}')
  fl=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | tail -1 | awk '{print $3}')
  [ -z "$p" ] && p=0; [ -z "$fl" ] && fl=0
  tp=$((tp+p)); tf=$((tf+fl))
  tag=OK
  if [ "$rc" -eq 142 ] || [ "$rc" -eq 14 ]; then tag=ALARM; hung+=("$f"); fi
  if [ "$fl" -gt 0 ]; then tag=FAIL; failed+=("$f"); fi
  if ! printf '%s\n' "$out" | grep -qE '^ℹ pass '; then tag="$tag/NO-SUMMARY"; noSummary+=("$f"); fi
  echo "$tag $f pass=$p fail=$fl rc=$rc" >> "$SLOG"
  if [ "$tag" != OK ]; then printf '%s\n' "$out" | grep -v '^    at \|^      at ' | tail -40 >> "$SLOG"; fi
done
{
  echo "=============== SUMMARY"
  echo "files run: $files   pass: $tp   fail: $tf"
  echo "failed files: ${#failed[@]} ${failed[*]}"
  echo "alarm-killed files: ${#hung[@]} ${hung[*]}"
  echo "no-summary files: ${#noSummary[@]} ${noSummary[*]}"
} >> "$SLOG"
pkill -f 'node --test --test-concurrency=1 --test-timeout=60000 packages/' 2>/dev/null
echo "=== typecheck $(date -u +%FT%TZ)" >> "$LOG"
npx tsc -p tsconfig.json >> "$LOG" 2>&1 && echo "tsc clean" >> "$LOG"
echo "DONE $(date -u +%FT%TZ)" >> "$LOG"
