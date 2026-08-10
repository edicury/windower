#!/bin/bash
# Phase 21 live verification — concurrent-load stress variant.
# Caller-driven recipe (start -> detached operate -> poll -> stop) with a
# synthetic burst of daemon-routed `windower targets` calls layered on top,
# while sampling capture-sidecar process count every 2s.
# Usage: stress-run.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-stress}"
OUT="$SCRATCH/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"

cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

TASK='Open Safari and navigate to waroom.co. Use Finder to open the Applications folder and launch Safari from there if it is not already running. Once the page has loaded, you are done.'

SESSION=""
RUNID=""
STOPPED=0
BURST_PID=""
SAMPLE_PID=""

check() { echo "CHECK $1: $2 $3"; }

jget() {
  node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log("");process.exit(0)}
let v;try{v=eval(process.argv[2])}catch(e){v=""}
console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2"
}

cleanup() {
  [ -n "$BURST_PID" ] && kill "$BURST_PID" 2>/dev/null
  [ -n "$SAMPLE_PID" ] && kill "$SAMPLE_PID" 2>/dev/null
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
if [ -z "$SESSION" ]; then
  check start_recording "FAIL" "no sessionId; see $OUT/start.err"
  exit 1
fi
check start_recording "PASS" "sessionId=$SESSION"

echo "############ [$LABEL] LAUNCH BURST + SAMPLER ############"
# Synthetic burst: daemon-routed list_targets every ~2s for the whole run.
BURST_LOG="$OUT/burst.log"
: > "$BURST_LOG"
(
  n=0
  while :; do
    n=$((n+1))
    t=$(date +%H:%M:%S)
    if $W targets --json > "$OUT/burst-last.json" 2>"$OUT/burst-last.err"; then
      cnt=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targets||[]).length)}catch(e){console.log("?")}' "$OUT/burst-last.json")
      echo "$t call=$n OK targets=$cnt" >> "$BURST_LOG"
    else
      echo "$t call=$n FAIL $(head -c 200 "$OUT/burst-last.err" | tr '\n' ' ')" >> "$BURST_LOG"
    fi
    sleep 2
  done
) &
BURST_PID=$!

SAMPLE_LOG="$OUT/capture-samples.log"
ANOMALY_LOG="$OUT/capture-anomalies.log"
: > "$SAMPLE_LOG"; : > "$ANOMALY_LOG"
(
  while :; do
    t=$(date +%H:%M:%S)
    c=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
    echo "$t $c" >> "$SAMPLE_LOG"
    if [ "$c" != "1" ]; then
      { echo "=== $t count=$c"; ps -eo pid,ppid,command | grep "[w]indower-capture-macos"; } >> "$ANOMALY_LOG"
    fi
    sleep 2
  done
) &
SAMPLE_PID=$!

echo "burstPid=$BURST_PID samplerPid=$SAMPLE_PID"

echo "############ [$LABEL] START DETACHED OPERATOR RUN ############"
$W operate "$TASK" --target 5 --kind display --model anthropic:claude-sonnet-5 --max-steps 30 --detach --json > "$OUT/operate.json" 2>"$OUT/operate.err"
RUNID=$(jget "$OUT/operate.json" 'd.runId')
echo "runId=$RUNID"
if [ -z "$RUNID" ]; then
  check operator_started "FAIL" "no runId; see $OUT/operate.err"
  exit 1
fi
check operator_started "PASS" "runId=$RUNID"

echo "############ [$LABEL] POLL OPERATOR RUN ############"
STATE=pending
for i in $(seq 1 180); do
  sleep 5
  $W operate status "$RUNID" --json > "$OUT/run-poll.json" 2>/dev/null
  STATE=$(jget "$OUT/run-poll.json" 'd.state')
  STEPS=$(jget "$OUT/run-poll.json" '(d.steps||[]).length')
  MAXNOW=$(sort -k2 -n "$SAMPLE_LOG" 2>/dev/null | tail -1 | awk '{print $2}')
  echo "  t=$((i*5))s state=${STATE:-?} steps=${STEPS:-?} maxCaptureProcsSoFar=${MAXNOW:-?}"
  case "$STATE" in
    succeeded|failed|aborted|timed_out) cp "$OUT/run-poll.json" "$OUT/run-final.json"; break;;
  esac
done
[ -f "$OUT/run-final.json" ] || cp "$OUT/run-poll.json" "$OUT/run-final.json"

echo "############ [$LABEL] STOP BURST + SAMPLER ############"
kill "$BURST_PID" 2>/dev/null; BURST_PID=""
kill "$SAMPLE_PID" 2>/dev/null; SAMPLE_PID=""
sleep 1

echo "############ [$LABEL] STOP RECORDING ############"
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
STOPPED=1
cat "$OUT/stop.json"
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json" 2>/dev/null

echo "############ [$LABEL] RESULTS ############"
MAXPROC=$(awk '{if($2+0>m)m=$2+0}END{print m+0}' "$SAMPLE_LOG")
SAMPLES=$(wc -l < "$SAMPLE_LOG" | tr -d ' ')
ANOM=$(grep -c '^=== ' "$ANOMALY_LOG" 2>/dev/null || echo 0)
BURST_TOTAL=$(wc -l < "$BURST_LOG" | tr -d ' ')
BURST_FAIL=$(grep -c ' FAIL ' "$BURST_LOG" 2>/dev/null || echo 0)

echo "-- capture-process samples: $SAMPLES, max concurrent: $MAXPROC, off-by-one samples: $ANOM"
echo "-- anomaly log (count != 1):"
if [ -s "$ANOMALY_LOG" ]; then cat "$ANOMALY_LOG"; else echo "   (none)"; fi
echo "-- burst calls: total=$BURST_TOTAL failed=$BURST_FAIL"
echo "-- burst failures:"
grep ' FAIL ' "$BURST_LOG" || echo "   (none)"

OUTPATH=$(jget "$OUT/stop.json" 'd.outputPath')
MANPATH=$(jget "$OUT/stop.json" 'd.manifestPath')
EVTPATH=$(jget "$OUT/stop.json" 'd.eventTimelinePath')
DUR=$(jget "$OUT/stop.json" 'd.manifest.video.durationMs')
SSTATE=$(jget "$OUT/session.json" 'd.state')
STARTED=$(jget "$OUT/session.json" 'd.startedAt')
ENDED=$(jget "$OUT/session.json" 'd.stoppedAt')
WALL=$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);console.log(isNaN(a)||isNaN(b)?"":b-a)' "$STARTED" "$ENDED")
FSTEPS=$(jget "$OUT/run-final.json" '(d.steps||[]).length')
FSTATE=$(jget "$OUT/run-final.json" 'd.state')
FERR=$(jget "$OUT/run-final.json" 'd.error && (d.error.code||d.error)')

echo
echo "############ [$LABEL] CHECKS ############"
[ "$MAXPROC" = "1" ] && check single_capture_sidecar "PASS" "max concurrent windower-capture-macos = 1 over $SAMPLES samples" \
  || check single_capture_sidecar "FAIL" "max concurrent windower-capture-macos = $MAXPROC (see $ANOMALY_LOG)"
[ "$BURST_FAIL" = "0" ] && check burst_calls_all_ok "PASS" "$BURST_TOTAL burst targets calls, 0 failures" \
  || check burst_calls_all_ok "FAIL" "$BURST_FAIL/$BURST_TOTAL burst targets calls failed"
case "$FSTATE" in
  succeeded|failed|aborted|timed_out) check operator_terminal "PASS" "state=$FSTATE steps=$FSTEPS error=${FERR:-none}";;
  *) check operator_terminal "FAIL" "state=${FSTATE:-?} steps=${FSTEPS:-?} (did not reach terminal state)";;
esac
[ -n "$OUTPATH" ] && [ -f "$OUTPATH" ] && check video_exists "PASS" "$OUTPATH ($(wc -c < "$OUTPATH" | tr -d ' ') bytes)" \
  || check video_exists "FAIL" "outputPath=${OUTPATH:-none}"
[ -n "$MANPATH" ] && [ -f "$MANPATH" ] && check manifest_exists "PASS" "$MANPATH" || check manifest_exists "FAIL" "manifestPath=${MANPATH:-none}"
[ -n "$EVTPATH" ] && [ -f "$EVTPATH" ] && check timeline_exists "PASS" "$EVTPATH" || check timeline_exists "FAIL" "eventTimelinePath=${EVTPATH:-none}"
[ "$SSTATE" = "stopped" ] && check session_state "PASS" "state=stopped" || check session_state "FAIL" "state=${SSTATE:-?}"
if [ -n "$DUR" ] && [ -n "$WALL" ]; then
  RATIO=$(node -e 'const d=+process.argv[1],w=+process.argv[2];console.log(w>0?(d/w).toFixed(3):"NA")' "$DUR" "$WALL")
  OK=$(node -e 'const d=+process.argv[1],w=+process.argv[2];console.log(w>0&&d/w>=0.9?"1":"0")' "$DUR" "$WALL")
  [ "$OK" = "1" ] && check duration_vs_wallclock "PASS" "durationMs=$DUR wallMs=$WALL ratio=$RATIO" \
    || check duration_vs_wallclock "FAIL" "durationMs=$DUR wallMs=$WALL ratio=$RATIO (truncated?)"
else
  check duration_vs_wallclock "FAIL" "durationMs=${DUR:-?} wallMs=${WALL:-?}"
fi

echo "############ [$LABEL] FINAL HYGIENE ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "(no sidecars/loop children — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos|[l]oop-entry.js")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control/loop processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"

echo "SESSION=$SESSION RUNID=$RUNID STATE=$FSTATE MAXCAPTURE=$MAXPROC BURST=$BURST_TOTAL BURSTFAIL=$BURST_FAIL" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
