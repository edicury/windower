#!/bin/bash
# Phase 21 live verification — crash isolation: kill -9 the CAPTURE sidecar
# (windower-capture-macos) mid-recording, while a synthetic-input load
# generator drives sustained on-screen activity (osascript/System Events —
# there is no Windower "operator" anymore; the calling agent, or here this
# script, is the one driving the screen — see CLAUDE.md).
# Expected: session state -> failed (Phase 13 crash recovery), no orphaned
# processes.
# Usage: crash-capture.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-crash-capture}"
OUT="$SCRATCH/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"

cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

SESSION=""
STOPPED=0
LOAD_PID=""

check() { echo "CHECK $1: $2 $3"; }
jget() {
  node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log("");process.exit(0)}
let v;try{v=eval(process.argv[2])}catch(e){v=""}
console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2"
}

# Synthetic-input load generator, replacing `windower operate` as the thing
# that keeps the screen busy during the crash window. Windower ships no code
# that synthesizes input (CLAUDE.md) — this drives TextEdit directly via
# osascript/System Events, the same mechanism e2e/src/lib/demo-app.ts uses
# for synthetic clicks. It never touches windower-control-macos.
start_synthetic_load() {
  (
    osascript -e 'tell application "TextEdit" to activate' >/dev/null 2>&1
    osascript -e 'tell application "TextEdit" to make new document' >/dev/null 2>&1
    sleep 1
    n=0
    while :; do
      n=$((n+1))
      osascript -e "tell application \"System Events\" to keystroke \"load line $n \"" >/dev/null 2>&1
      sleep 1
    done
  ) &
  echo $!
}
stop_synthetic_load() {
  [ -n "$1" ] && kill "$1" 2>/dev/null
  osascript -e 'tell application "TextEdit" to quit saving no' >/dev/null 2>&1
}

cleanup() {
  stop_synthetic_load "$LOAD_PID"
  if [ -n "$SESSION" ] && [ "$STOPPED" -eq 0 ]; then
    echo "=== [$LABEL] TRAP cleanup: attempting stop of recording $SESSION ==="
    $W stop "$SESSION" --json > "$OUT/stop-trap.json" 2>&1
    echo "-- trap stop output:"; head -c 800 "$OUT/stop-trap.json"; echo
  fi
}
trap cleanup EXIT INT TERM

echo "############ [$LABEL] PRECONDITION ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(no sidecars)"

echo "############ [$LABEL] START RECORDING ############"
$W start --target 5 --kind display --json > "$OUT/start.json" 2>"$OUT/start.err"
SESSION=$(jget "$OUT/start.json" 'd.sessionId')
echo "sessionId=$SESSION"
[ -z "$SESSION" ] && { check start_recording "FAIL" "no sessionId; see $OUT/start.err"; exit 1; }
check start_recording "PASS" "sessionId=$SESSION"

echo "############ [$LABEL] START SYNTHETIC LOAD ############"
LOAD_PID=$(start_synthetic_load)
echo "loadPid=$LOAD_PID"

echo "############ [$LABEL] WAIT FOR A LIVE CAPTURE SIDECAR ############"
CAP_PID=""
for i in $(seq 1 40); do
  sleep 3
  CAP_PID=$(ps -eo pid,ppid,command | grep "[w]indower-capture-macos" | awk '{print $1}' | head -1)
  echo "  t=$((i*3))s capturePid=${CAP_PID:-none}"
  [ -n "$CAP_PID" ] && [ $i -ge 5 ] && break
done

if [ -z "$CAP_PID" ]; then
  check capture_sidecar_present "FAIL" "no windower-capture-macos observed; nothing to kill"
else
  check capture_sidecar_present "PASS" "pid=$CAP_PID"
  echo "############ [$LABEL] KILL -9 CAPTURE SIDECAR pid=$CAP_PID ############"
  date +"killAt=%H:%M:%S" | tee "$OUT/kill.txt"
  kill -9 "$CAP_PID" 2>/dev/null
  sleep 3
  echo "-- ps right after kill:"
  ps -eo pid,ppid,command | grep "[w]indower-capture-macos" || echo "   (capture sidecar gone)"
fi

echo "############ [$LABEL] SESSION STATE AFTER CAPTURE CRASH ############"
sleep 3
$W status "$SESSION" --json > "$OUT/status-postkill.json" 2>&1
cat "$OUT/status-postkill.json"
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session-postkill.json" 2>/dev/null
POSTSTATE=$(jget "$OUT/session-postkill.json" 'd.state')
POSTERR=$(jget "$OUT/session-postkill.json" 'd.error && (d.error.code||d.error)')
echo "session-record state after crash: ${POSTSTATE:-?} error=${POSTERR:-none}"

echo "############ [$LABEL] STOP SYNTHETIC LOAD ############"
stop_synthetic_load "$LOAD_PID"; LOAD_PID=""

echo "############ [$LABEL] STOP RECORDING (may error — that is data) ############"
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
STOP_RC=$?
STOPPED=1
echo "stop exit=$STOP_RC"
echo "-- stop stdout:"; head -c 1200 "$OUT/stop.json"; echo
echo "-- stop stderr:"; head -c 800 "$OUT/stop.err"; echo
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session-final.json" 2>/dev/null

echo "############ [$LABEL] RESULTS ############"
FINSTATE=$(jget "$OUT/session-final.json" 'd.state')
FINERR=$(jget "$OUT/session-final.json" 'd.error && (d.error.code||d.error)')
echo "session record: postKillState=${POSTSTATE:-?} finalState=${FINSTATE:-?} error=${FINERR:-${POSTERR:-none}}"

echo
echo "############ [$LABEL] CHECKS ############"
if [ "$POSTSTATE" = "failed" ] || [ "$FINSTATE" = "failed" ]; then
  check session_failed_on_capture_crash "PASS" "postKill=${POSTSTATE:-?} final=${FINSTATE:-?} error=${FINERR:-${POSTERR:-none}}"
else
  check session_failed_on_capture_crash "FAIL" "postKill=${POSTSTATE:-?} final=${FINSTATE:-?} (expected failed)"
fi

echo "############ [$LABEL] FINAL HYGIENE ############"
echo "-- ps (expect nothing):"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "   (nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"
echo "-- capture.lock:"; ls -la ~/.windower/capture.lock 2>&1 | head -1

echo "SESSION=$SESSION SESSIONSTATE=${FINSTATE:-$POSTSTATE} KILLEDCAP=${CAP_PID:-none}" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
