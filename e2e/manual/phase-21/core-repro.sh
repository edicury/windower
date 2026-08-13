#!/bin/bash
# Phase 21 live verification — core repro (recording integrity under real
# on-screen activity).
#
# Originally driven by `windower operate`; the Operator has been removed
# (see CLAUDE.md — Windower never drives UI itself). This drives the screen
# via plain synthetic input (osascript/System Events against TextEdit,
# matching e2e/src/lib/demo-app.ts's synthesizeClick approach) for the
# duration of the recording instead.
# Usage: core-repro.sh <run-label> [duration-seconds]
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-run}"
DURATION="${2:-200}"
OUT="$SCRATCH/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"

cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

start_synthetic_load() {
  (
    osascript -e 'tell application "TextEdit" to activate' >/dev/null 2>&1
    osascript -e 'tell application "TextEdit" to make new document' >/dev/null 2>&1
    sleep 1
    n=0
    while :; do
      n=$((n+1))
      osascript -e "tell application \"System Events\" to keystroke \"line $n \"" >/dev/null 2>&1
      # A `windower targets` call every so often, standing in for the
      # occasional capture-surface calls a real caller makes between
      # actions — this is what previously reproduced the replayd conflict.
      if [ $((n % 10)) -eq 0 ]; then $W targets --json >/dev/null 2>&1; fi
      sleep 1
    done
  ) &
  echo $!
}
stop_synthetic_load() {
  [ -n "$1" ] && kill "$1" 2>/dev/null
  osascript -e 'tell application "TextEdit" to quit saving no' >/dev/null 2>&1
}

echo "=== [$LABEL] start_recording ==="
START_JSON=$($W start --target 5 --kind display --json 2>"$OUT/start.err")
echo "$START_JSON" > "$OUT/start.json"
SESSION=$(echo "$START_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessionId))')
echo "sessionId=$SESSION"
[ -z "$SESSION" ] && { echo "FAILED to start recording"; cat "$OUT/start.err"; exit 1; }

echo "=== [$LABEL] synthetic-input load, driving the screen for ${DURATION}s ==="
LOAD_PID=$(start_synthetic_load)
echo "loadPid=$LOAD_PID"
for i in $(seq 1 "$DURATION"); do
  sleep 1
  if [ $((i % 30)) -eq 0 ]; then echo "  t=${i}s"; fi
done
stop_synthetic_load "$LOAD_PID"

echo "=== [$LABEL] stop_recording ==="
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
cat "$OUT/stop.json"

cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json" 2>/dev/null
echo "SESSION=$SESSION" > "$OUT/ids.txt"
echo "=== [$LABEL] done ==="
