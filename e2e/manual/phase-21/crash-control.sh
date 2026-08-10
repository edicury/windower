#!/bin/bash
# Phase 21 live verification — crash isolation: kill -9 the CONTROL sidecar
# mid-run and observe operator + recording behavior.
# Usage: crash-control.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-crash-control}"
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
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(no native sidecars)"

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

echo "############ [$LABEL] WAIT FOR >=3 STEPS AND A CONTROL SIDECAR ############"
CTRL_PID=""
STEPS=0
STATE=pending
for i in $(seq 1 120); do
  sleep 3
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  CTRL_PID=$(ps -eo pid,ppid,command | grep "[w]indower-control-macos" | awk '{print $1}' | head -1)
  echo "  t=$((i*3))s state=${STATE:-?} steps=${STEPS:-0} controlPid=${CTRL_PID:-none}"
  case "$STATE" in succeeded|failed|aborted|timed_out) break;; esac
  if [ "${STEPS:-0}" -ge 3 ] 2>/dev/null && [ -n "$CTRL_PID" ]; then break; fi
done

if [ -z "$CTRL_PID" ]; then
  check control_sidecar_present "FAIL" "no windower-control-macos observed (steps=$STEPS state=$STATE); nothing to kill"
  KILLED=0
else
  check control_sidecar_present "PASS" "pid=$CTRL_PID at steps=$STEPS"
  echo "############ [$LABEL] KILL -9 CONTROL SIDECAR pid=$CTRL_PID ############"
  date +"killAt=%H:%M:%S" | tee "$OUT/kill.txt"
  kill -9 "$CTRL_PID" 2>/dev/null && KILLED=1 || KILLED=0
  echo "STEPS_AT_KILL=$STEPS" >> "$OUT/kill.txt"
  sleep 2
  echo "-- ps right after kill:"
  ps -eo pid,ppid,command | grep "[w]indower-control-macos" || echo "   (no control process)"
fi

echo "############ [$LABEL] POLL TO TERMINAL STATE ############"
RESPAWN_SEEN=0
RESPAWN_PID=""
for i in $(seq 1 180); do
  sleep 5
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  NEW=$(ps -eo pid,ppid,command | grep "[w]indower-control-macos" | awk '{print $1}' | head -1)
  if [ -n "$NEW" ] && [ "$NEW" != "$CTRL_PID" ]; then RESPAWN_SEEN=1; RESPAWN_PID="$NEW"; fi
  CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
  echo "  t=$((i*5))s state=${STATE:-?} steps=${STEPS:-?} controlPid=${NEW:-none} capProcs=$CAP"
  case "$STATE" in succeeded|failed|aborted|timed_out) cp "$OUT/run-poll.json" "$OUT/run-final.json"; break;; esac
done
[ -f "$OUT/run-final.json" ] || cp "$OUT/run-poll.json" "$OUT/run-final.json"

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
DUR=$(jget "$OUT/stop.json" 'd.manifest.video.durationMs')
SSTATE=$(jget "$OUT/session.json" 'd.state')
STARTED=$(jget "$OUT/session.json" 'd.startedAt')
ENDED=$(jget "$OUT/session.json" 'd.stoppedAt')
WALL=$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);console.log(isNaN(a)||isNaN(b)?"":b-a)' "$STARTED" "$ENDED")

echo "operator: state=$FSTATE steps=$FSTEPS errorCode=${FERR:-none}"
echo "operator errorMessage: ${FERRMSG:-none}"
echo "control respawn after kill: seen=$RESPAWN_SEEN pid=${RESPAWN_PID:-none}"
echo "recording: durationMs=${DUR:-?} wallMs=${WALL:-?} sessionState=${SSTATE:-?}"

echo
echo "############ [$LABEL] CHECKS ############"
case "$FSTATE" in
  succeeded|failed|aborted|timed_out) check operator_terminal "PASS" "state=$FSTATE errorCode=${FERR:-none}";;
  *) check operator_terminal "FAIL" "state=${FSTATE:-?} (wedged, never reached terminal state)";;
esac
[ "${FSTEPS:-0}" -ge 3 ] 2>/dev/null && check partial_transcript_preserved "PASS" "$FSTEPS steps retained" \
  || check partial_transcript_preserved "FAIL" "steps=${FSTEPS:-?}"
[ "$RESPAWN_SEEN" = "1" ] && check control_respawned "PASS" "new control pid=$RESPAWN_PID (different from killed $CTRL_PID)" \
  || check control_respawned "FAIL" "no new windower-control-macos observed after the kill"
[ "$SSTATE" = "stopped" ] && check recording_unaffected "PASS" "sessionState=stopped despite control-sidecar crash" \
  || check recording_unaffected "FAIL" "sessionState=${SSTATE:-?}"
[ -n "$OUTPATH" ] && [ -f "$OUTPATH" ] && check video_exists "PASS" "$OUTPATH ($(wc -c < "$OUTPATH" | tr -d ' ') bytes)" \
  || check video_exists "FAIL" "outputPath=${OUTPATH:-none}"
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

echo "SESSION=$SESSION RUNID=$RUNID STATE=$FSTATE KILLEDCTRL=${CTRL_PID:-none}" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
