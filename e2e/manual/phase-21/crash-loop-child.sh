#!/bin/bash
# Phase 21 live verification — crash isolation: kill -9 the OPERATOR LOOP CHILD
# (packages/operator/dist/loop-entry.js) mid-run.
# Expected: OperatorRun -> failed / OPERATOR_LOOP_CRASHED, recording untouched
# and finalizes normally on stop.
# Usage: crash-loop-child.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-crash-loop-child}"
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
    echo "=== [$LABEL] TRAP cleanup: stopping recording $SESSION ==="
    $W stop "$SESSION" --json > "$OUT/stop-trap.json" 2>&1
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

echo "############ [$LABEL] WAIT FOR >=3 STEPS AND A LOOP CHILD ############"
LOOP_PID=""
STEPS=0
STATE=pending
for i in $(seq 1 120); do
  sleep 3
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  # loop-entry.js only — NOT the daemon (apps/daemon/dist/bin.js)
  LOOP_PID=$(ps -eo pid,ppid,command | grep "[l]oop-entry.js" | grep -v "daemon/dist/bin.js" | awk '{print $1}' | head -1)
  echo "  t=$((i*3))s state=${STATE:-?} steps=${STEPS:-0} loopPid=${LOOP_PID:-none}"
  case "$STATE" in succeeded|failed|aborted|timed_out) break;; esac
  if [ "${STEPS:-0}" -ge 3 ] 2>/dev/null && [ -n "$LOOP_PID" ]; then break; fi
done

STEPS_AT_KILL="$STEPS"
if [ -z "$LOOP_PID" ]; then
  check loop_child_present "FAIL" "no loop-entry.js process observed (steps=$STEPS state=$STATE); nothing to kill"
else
  check loop_child_present "PASS" "pid=$LOOP_PID at steps=$STEPS"
  echo "-- full ps line for the victim:"
  ps -eo pid,ppid,command | grep "[l]oop-entry.js" | grep -v "daemon/dist/bin.js"
  echo "############ [$LABEL] KILL -9 LOOP CHILD pid=$LOOP_PID ############"
  date +"killAt=%H:%M:%S" | tee "$OUT/kill.txt"
  echo "STEPS_AT_KILL=$STEPS_AT_KILL" >> "$OUT/kill.txt"
  kill -9 "$LOOP_PID" 2>/dev/null
  sleep 2
  echo "-- ps right after kill:"
  ps -eo pid,ppid,command | grep "[l]oop-entry.js" | grep -v "daemon/dist/bin.js" || echo "   (loop child gone)"
  echo "-- capture sidecar right after kill (expect exactly 1, untouched):"
  ps -eo pid,ppid,command | grep "[w]indower-capture-macos" || echo "   (NONE — unexpected)"
fi

echo "############ [$LABEL] POLL TO TERMINAL STATE ############"
for i in $(seq 1 60); do
  sleep 5
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
  echo "  t=$((i*5))s state=${STATE:-?} steps=${STEPS:-?} capProcs=$CAP"
  case "$STATE" in succeeded|failed|aborted|timed_out) cp "$OUT/run-poll.json" "$OUT/run-final.json"; break;; esac
done
[ -f "$OUT/run-final.json" ] || cp "$OUT/run-poll.json" "$OUT/run-final.json"

echo "############ [$LABEL] RECORDING STILL HEALTHY? (pre-stop) ############"
$W status "$SESSION" --json > "$OUT/status-prestop.json" 2>&1
cat "$OUT/status-prestop.json"
PRESTATE=$(jget "$OUT/status-prestop.json" 'd.state || (d.session && d.session.state)')

echo "############ [$LABEL] STOP RECORDING ############"
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
STOPPED=1
cat "$OUT/stop.json"
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json" 2>/dev/null

echo "############ [$LABEL] RESULTS ############"
FSTATE=$(jget "$OUT/run-final.json" 'd.state')
FERR=$(jget "$OUT/run-final.json" 'd.error && (d.error.code||d.error)')
FERRMSG=$(jget "$OUT/run-final.json" 'd.error && d.error.message')
FSTEPS=$(jget "$OUT/run-final.json" '(d.steps||[]).length')
OUTPATH=$(jget "$OUT/stop.json" 'd.outputPath')
MANPATH=$(jget "$OUT/stop.json" 'd.manifestPath')
EVTPATH=$(jget "$OUT/stop.json" 'd.eventTimelinePath')
DUR=$(jget "$OUT/stop.json" 'd.manifest.video.durationMs')
SSTATE=$(jget "$OUT/session.json" 'd.state')
STARTED=$(jget "$OUT/session.json" 'd.startedAt')
ENDED=$(jget "$OUT/session.json" 'd.stoppedAt')
WALL=$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);console.log(isNaN(a)||isNaN(b)?"":b-a)' "$STARTED" "$ENDED")

echo "operator: state=$FSTATE errorCode=${FERR:-none} steps=$FSTEPS (at kill: $STEPS_AT_KILL)"
echo "operator errorMessage: ${FERRMSG:-none}"
echo "PARTIAL TRANSCRIPT STEP COUNT PRESERVED: $FSTEPS"
echo "recording: prestopState=${PRESTATE:-?} sessionState=${SSTATE:-?} durationMs=${DUR:-?} wallMs=${WALL:-?}"

echo
echo "############ [$LABEL] CHECKS ############"
[ "$FSTATE" = "failed" ] && check operator_failed "PASS" "state=failed" || check operator_failed "FAIL" "state=${FSTATE:-?} (expected failed)"
[ "$FERR" = "OPERATOR_LOOP_CRASHED" ] && check operator_error_code "PASS" "OPERATOR_LOOP_CRASHED" \
  || check operator_error_code "FAIL" "errorCode=${FERR:-none} (expected OPERATOR_LOOP_CRASHED)"
[ "${FSTEPS:-0}" -ge 3 ] 2>/dev/null && check partial_transcript_preserved "PASS" "$FSTEPS steps preserved after kill -9" \
  || check partial_transcript_preserved "FAIL" "steps=${FSTEPS:-?}"
[ "$SSTATE" = "stopped" ] && check recording_unaffected "PASS" "sessionState=stopped, finalized normally" \
  || check recording_unaffected "FAIL" "sessionState=${SSTATE:-?}"
[ -n "$OUTPATH" ] && [ -f "$OUTPATH" ] && check video_exists "PASS" "$OUTPATH ($(wc -c < "$OUTPATH" | tr -d ' ') bytes)" \
  || check video_exists "FAIL" "outputPath=${OUTPATH:-none}"
[ -n "$MANPATH" ] && [ -f "$MANPATH" ] && check manifest_exists "PASS" "$MANPATH" || check manifest_exists "FAIL" "manifestPath=${MANPATH:-none}"
[ -n "$EVTPATH" ] && [ -f "$EVTPATH" ] && check timeline_exists "PASS" "$EVTPATH" || check timeline_exists "FAIL" "eventTimelinePath=${EVTPATH:-none}"
if [ -n "$DUR" ] && [ -n "$WALL" ]; then
  RATIO=$(node -e 'const d=+process.argv[1],w=+process.argv[2];console.log(w>0?(d/w).toFixed(3):"NA")' "$DUR" "$WALL")
  OK=$(node -e 'const d=+process.argv[1],w=+process.argv[2];console.log(w>0&&d/w>=0.9?"1":"0")' "$DUR" "$WALL")
  [ "$OK" = "1" ] && check duration_vs_wallclock "PASS" "durationMs=$DUR wallMs=$WALL ratio=$RATIO" \
    || check duration_vs_wallclock "FAIL" "durationMs=$DUR wallMs=$WALL ratio=$RATIO (truncated)"
else
  check duration_vs_wallclock "FAIL" "durationMs=${DUR:-?} wallMs=${WALL:-?}"
fi

echo "############ [$LABEL] FINAL HYGIENE ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "(nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos|[l]oop-entry.js")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control/loop processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"

echo "SESSION=$SESSION RUNID=$RUNID STATE=$FSTATE ERR=${FERR:-none} KILLEDLOOP=${LOOP_PID:-none}" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
