#!/bin/bash
# Phase 21 live verification — crash isolation: kill -9 the CAPTURE sidecar
# (windower-capture-macos) mid-run.
# Expected: session state -> failed (Phase 13 crash recovery), operator run
# still reaches a terminal state, nothing orphaned.
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

TASK='Open Safari and navigate to waroom.co. Use Finder to open the Applications folder and launch Safari from there if it is not already running. Once the page has loaded, you are done.'

SESSION=""
RUNID=""
STOPPED=0

check() { echo "CHECK $1: $2 $3"; }
jget() {
  node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log("");process.exit(0)}
let v;try{v=eval(process.argv[2])}catch(e){v=""}
console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2"
}
cleanup() {
  if [ -n "$SESSION" ] && [ "$STOPPED" -eq 0 ]; then
    echo "=== [$LABEL] TRAP cleanup: attempting stop of recording $SESSION ==="
    $W stop "$SESSION" --json > "$OUT/stop-trap.json" 2>&1
    echo "-- trap stop output:"; head -c 800 "$OUT/stop-trap.json"; echo
  fi
}
trap cleanup EXIT INT TERM

echo "############ [$LABEL] PRECONDITION ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "(no sidecars / loop children)"

echo "############ [$LABEL] START RECORDING ############"
$W start --target 5 --kind display --json > "$OUT/start.json" 2>"$OUT/start.err"
SESSION=$(jget "$OUT/start.json" 'd.sessionId')
echo "sessionId=$SESSION"
[ -z "$SESSION" ] && { check start_recording "FAIL" "no sessionId; see $OUT/start.err"; exit 1; }
check start_recording "PASS" "sessionId=$SESSION"

echo "############ [$LABEL] START DETACHED OPERATOR RUN ############"
$W operate "$TASK" --target 5 --kind display --model anthropic:claude-sonnet-5 --max-steps 30 --detach --json > "$OUT/operate.json" 2>"$OUT/operate.err"
RUNID=$(jget "$OUT/operate.json" 'd.runId')
echo "runId=$RUNID"
[ -z "$RUNID" ] && { check operator_started "FAIL" "no runId; see $OUT/operate.err"; exit 1; }
check operator_started "PASS" "runId=$RUNID"

echo "############ [$LABEL] WAIT FOR >=3 STEPS AND A CAPTURE SIDECAR ############"
CAP_PID=""
STEPS=0
STATE=pending
for i in $(seq 1 120); do
  sleep 3
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  CAP_PID=$(ps -eo pid,ppid,command | grep "[w]indower-capture-macos" | awk '{print $1}' | head -1)
  echo "  t=$((i*3))s state=${STATE:-?} steps=${STEPS:-0} capturePid=${CAP_PID:-none}"
  case "$STATE" in succeeded|failed|aborted|timed_out) break;; esac
  if [ "${STEPS:-0}" -ge 3 ] 2>/dev/null && [ -n "$CAP_PID" ]; then break; fi
done

STEPS_AT_KILL="$STEPS"
if [ -z "$CAP_PID" ]; then
  check capture_sidecar_present "FAIL" "no windower-capture-macos observed (steps=$STEPS state=$STATE); nothing to kill"
else
  check capture_sidecar_present "PASS" "pid=$CAP_PID at steps=$STEPS"
  echo "############ [$LABEL] KILL -9 CAPTURE SIDECAR pid=$CAP_PID ############"
  date +"killAt=%H:%M:%S" | tee "$OUT/kill.txt"
  echo "STEPS_AT_KILL=$STEPS_AT_KILL" >> "$OUT/kill.txt"
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

echo "############ [$LABEL] POLL OPERATOR RUN TO TERMINAL STATE ############"
for i in $(seq 1 120); do
  sleep 5
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
  echo "  t=$((i*5))s state=${STATE:-?} steps=${STEPS:-?} capProcs=$CAP"
  case "$STATE" in succeeded|failed|aborted|timed_out) cp "$OUT/run-poll.json" "$OUT/run-final.json"; break;; esac
done
[ -f "$OUT/run-final.json" ] || cp "$OUT/run-poll.json" "$OUT/run-final.json"

echo "############ [$LABEL] STOP RECORDING (may error — that is data) ############"
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
STOP_RC=$?
STOPPED=1
echo "stop exit=$STOP_RC"
echo "-- stop stdout:"; head -c 1200 "$OUT/stop.json"; echo
echo "-- stop stderr:"; head -c 800 "$OUT/stop.err"; echo
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session-final.json" 2>/dev/null

echo "############ [$LABEL] RESULTS ############"
FSTATE=$(jget "$OUT/run-final.json" 'd.state')
FERR=$(jget "$OUT/run-final.json" 'd.error && (d.error.code||d.error)')
FERRMSG=$(jget "$OUT/run-final.json" 'd.error && d.error.message')
FSTEPS=$(jget "$OUT/run-final.json" '(d.steps||[]).length')
STEPERRS=$(jget "$OUT/run-final.json" '(d.steps||[]).filter(s=>s&&s.error).map(s=>(s.error.code||s.error)).join(",")')
FINSTATE=$(jget "$OUT/session-final.json" 'd.state')
FINERR=$(jget "$OUT/session-final.json" 'd.error && (d.error.code||d.error)')

echo "operator: state=$FSTATE errorCode=${FERR:-none} steps=$FSTEPS (at kill: $STEPS_AT_KILL)"
echo "operator errorMessage: ${FERRMSG:-none}"
echo "operator per-step error codes: ${STEPERRS:-none}"
echo "session record: postKillState=${POSTSTATE:-?} finalState=${FINSTATE:-?} error=${FINERR:-${POSTERR:-none}}"

echo
echo "############ [$LABEL] CHECKS ############"
if [ "$POSTSTATE" = "failed" ] || [ "$FINSTATE" = "failed" ]; then
  check session_failed_on_capture_crash "PASS" "postKill=${POSTSTATE:-?} final=${FINSTATE:-?} error=${FINERR:-${POSTERR:-none}}"
else
  check session_failed_on_capture_crash "FAIL" "postKill=${POSTSTATE:-?} final=${FINSTATE:-?} (expected failed)"
fi
case "$FSTATE" in
  succeeded|failed|aborted|timed_out) check operator_terminal "PASS" "state=$FSTATE errorCode=${FERR:-none} (not wedged)";;
  *) check operator_terminal "FAIL" "state=${FSTATE:-?} (wedged, never reached terminal state)";;
esac
[ "${FSTEPS:-0}" -ge 3 ] 2>/dev/null && check partial_transcript_preserved "PASS" "$FSTEPS steps retained" \
  || check partial_transcript_preserved "FAIL" "steps=${FSTEPS:-?}"

echo "############ [$LABEL] FINAL HYGIENE ############"
echo "-- ps (expect nothing):"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "   (nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos|[l]oop-entry.js")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control/loop processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"
echo "-- capture.lock:"; ls -la ~/.windower/capture.lock 2>&1 | head -1

echo "SESSION=$SESSION RUNID=$RUNID OPSTATE=$FSTATE SESSIONSTATE=${FINSTATE:-$POSTSTATE} KILLEDCAP=${CAP_PID:-none}" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
