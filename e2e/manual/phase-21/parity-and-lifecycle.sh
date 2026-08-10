#!/bin/bash
# Phase 21 live verification — recording/operator independence.
#   (a) operator with NO recording
#   (b) recording with NO operator
#   (c) independent lifecycles: recording outlives a terminal operator run
# Usage: parity-and-lifecycle.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-parity}"
OUT="$SCRATCH/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT/a" "$OUT/b" "$OUT/c"

cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

TASK='Open Safari and navigate to waroom.co. Use Finder to open the Applications folder and launch Safari from there if it is not already running. Once the page has loaded, you are done.'

SESSION_B=""
SESSION_C=""

check() { echo "CHECK $1: $2 $3"; }
jget() {
  node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log("");process.exit(0)}
let v;try{v=eval(process.argv[2])}catch(e){v=""}
console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2"
}
cleanup() {
  for s in "$SESSION_B" "$SESSION_C"; do
    if [ -n "$s" ]; then
      echo "=== [$LABEL] TRAP cleanup: stopping recording $s (no-op if already stopped) ==="
      $W stop "$s" --json > "$OUT/stop-trap-$s.json" 2>&1
    fi
  done
}
trap cleanup EXIT INT TERM

echo "############ [$LABEL] PRECONDITION ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "(no sidecars / loop children)"
echo "-- active sessions before we start:"
$W list --json 2>/dev/null | head -c 800; echo

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (a) OPERATOR, NO RECORDING #######"
echo "########################################################"
echo "-- confirming no recording is active:"
$W list --json > "$OUT/a/sessions-before.json" 2>/dev/null
ACTIVE_BEFORE=$(jget "$OUT/a/sessions-before.json" '((d.sessions)||d||[]).filter(s=>s&&s.state==="recording").length')
echo "activeRecordings=${ACTIVE_BEFORE:-?}"
[ "${ACTIVE_BEFORE:-0}" = "0" ] && check a_no_recording_active "PASS" "0 recording sessions before operator run" \
  || check a_no_recording_active "FAIL" "${ACTIVE_BEFORE} recording session(s) active — precondition violated"

$W operate "$TASK" --target 5 --kind display --model anthropic:claude-sonnet-5 --max-steps 30 --detach --json > "$OUT/a/operate.json" 2>"$OUT/a/operate.err"
RUNID_A=$(jget "$OUT/a/operate.json" 'd.runId')
echo "runId=$RUNID_A"
if [ -z "$RUNID_A" ]; then
  check a_operator_started "FAIL" "no runId; see $OUT/a/operate.err"
else
  check a_operator_started "PASS" "runId=$RUNID_A"
  STATE_A=pending
  for i in $(seq 1 180); do
    sleep 5
    $W operate status "$RUNID_A" --json > "$OUT/a/run-poll.json" 2>/dev/null
    STATE_A=$(jget "$OUT/a/run-poll.json" 'd.state')
    STEPS_A=$(jget "$OUT/a/run-poll.json" '(d.steps||[]).length')
    CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
    echo "  t=$((i*5))s state=${STATE_A:-?} steps=${STEPS_A:-?} capProcs=$CAP"
    case "$STATE_A" in succeeded|failed|aborted|timed_out) cp "$OUT/a/run-poll.json" "$OUT/a/run-final.json"; break;; esac
  done
  [ -f "$OUT/a/run-final.json" ] || cp "$OUT/a/run-poll.json" "$OUT/a/run-final.json"

  A_STATE=$(jget "$OUT/a/run-final.json" 'd.state')
  A_STEPS=$(jget "$OUT/a/run-final.json" '(d.steps||[]).length')
  A_PLAN=$(jget "$OUT/a/run-final.json" 'd.plan?"present":"absent"')
  A_PLANLEN=$(jget "$OUT/a/run-final.json" 'd.plan?(Array.isArray(d.plan)?d.plan.length:String(d.plan).length):0')
  A_GUARD=$(jget "$OUT/a/run-final.json" 'JSON.stringify({maxSteps:d.maxSteps,stepsUsed:(d.steps||[]).length,guardrails:d.guardrails,limits:d.limits,budget:d.budget,stopReason:d.stopReason})')
  A_KEYS=$(jget "$OUT/a/run-final.json" 'Object.keys(d).sort().join(",")')
  A_ERR=$(jget "$OUT/a/run-final.json" 'd.error && (d.error.code||d.error)')
  A_SESSREF=$(grep -ioE '"(sessionId|recordingId|recording|session)"' "$OUT/a/run-final.json" | sort -u | tr '\n' ' ')

  echo "-- run JSON dumped to $OUT/a/run-final.json (diff its SHAPE against a recorded run)"
  echo "run top-level keys: $A_KEYS"
  echo "guardrail accounting: $A_GUARD"
  echo "plan: $A_PLAN (len=$A_PLANLEN)"

  case "$A_STATE" in
    succeeded|failed|aborted|timed_out) check a_terminal_state "PASS" "state=$A_STATE error=${A_ERR:-none}";;
    *) check a_terminal_state "FAIL" "state=${A_STATE:-?}";;
  esac
  [ "${A_STEPS:-0}" -ge 1 ] 2>/dev/null && check a_steps_recorded "PASS" "$A_STEPS steps" || check a_steps_recorded "FAIL" "steps=${A_STEPS:-?}"
  [ "$A_PLAN" = "present" ] && check a_plan_present "PASS" "plan present (len=$A_PLANLEN)" || check a_plan_present "FAIL" "no plan field on the run"
  [ -z "$A_SESSREF" ] && check a_run_has_no_session_ref "PASS" "no session/recording keys in run JSON" \
    || check a_run_has_no_session_ref "FAIL" "run JSON mentions: $A_SESSREF"
fi

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (b) RECORDING, NO OPERATOR #######"
echo "########################################################"
$W start --target 5 --kind display --json > "$OUT/b/start.json" 2>"$OUT/b/start.err"
SESSION_B=$(jget "$OUT/b/start.json" 'd.sessionId')
echo "sessionId=$SESSION_B"
if [ -z "$SESSION_B" ]; then
  check b_start_recording "FAIL" "no sessionId; see $OUT/b/start.err"
else
  check b_start_recording "PASS" "sessionId=$SESSION_B"
  echo "-- idling 45s with NO operator at all"
  for i in 1 2 3; do
    sleep 15
    CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
    LOOP=$(ps -eo pid,command | grep "[l]oop-entry.js" | grep -vc "daemon/dist/bin.js")
    echo "  t=$((i*15))s capProcs=$CAP loopChildren=$LOOP"
  done
  LOOP_SEEN=$(ps -eo pid,command | grep "[l]oop-entry.js" | grep -vc "daemon/dist/bin.js")
  [ "$LOOP_SEEN" = "0" ] && check b_no_operator_running "PASS" "no loop-entry.js during the recording" \
    || check b_no_operator_running "FAIL" "$LOOP_SEEN loop child(ren) present — precondition violated"

  $W stop "$SESSION_B" --json > "$OUT/b/stop.json" 2>"$OUT/b/stop.err"
  cat "$OUT/b/stop.json"
  cp "$HOME/.windower/sessions/$SESSION_B.json" "$OUT/b/session.json" 2>/dev/null
  B_MANPATH=$(jget "$OUT/b/stop.json" 'd.manifestPath')
  [ -n "$B_MANPATH" ] && [ -f "$B_MANPATH" ] && cp "$B_MANPATH" "$OUT/b/manifest.json"
  B_OUTPATH=$(jget "$OUT/b/stop.json" 'd.outputPath')
  B_SSTATE=$(jget "$OUT/b/session.json" 'd.state')
  B_SKEYS=$(jget "$OUT/b/session.json" 'Object.keys(d).sort().join(",")')
  B_MKEYS=$(jget "$OUT/b/manifest.json" 'Object.keys(d).sort().join(",")')
  echo "session record keys: $B_SKEYS"
  echo "manifest keys:       $B_MKEYS"
  echo "(dumped: $OUT/b/session.json, $OUT/b/manifest.json — SHAPE-compare against the caller-driven run)"

  [ "$B_SSTATE" = "stopped" ] && check b_session_stopped "PASS" "state=stopped" || check b_session_stopped "FAIL" "state=${B_SSTATE:-?}"
  [ -n "$B_OUTPATH" ] && [ -f "$B_OUTPATH" ] && check b_video_exists "PASS" "$B_OUTPATH ($(wc -c < "$B_OUTPATH" | tr -d ' ') bytes)" \
    || check b_video_exists "FAIL" "outputPath=${B_OUTPATH:-none}"
  B_DRIVER=$(grep -ioE '"(operator|operatorRunId|runId|driver|agent)"' "$OUT/b/session.json" "$OUT/b/manifest.json" 2>/dev/null | sort -u | tr '\n' ' ')
  [ -z "$B_DRIVER" ] && check b_no_driver_identity "PASS" "session/manifest carry no operator/driver identity" \
    || check b_no_driver_identity "FAIL" "found: $B_DRIVER"
  SESSION_B=""
fi

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (c) INDEPENDENT LIFECYCLE ########"
echo "########################################################"
$W start --target 5 --kind display --json > "$OUT/c/start.json" 2>"$OUT/c/start.err"
SESSION_C=$(jget "$OUT/c/start.json" 'd.sessionId')
echo "sessionId=$SESSION_C"
if [ -z "$SESSION_C" ]; then
  check c_start_recording "FAIL" "no sessionId; see $OUT/c/start.err"
else
  check c_start_recording "PASS" "sessionId=$SESSION_C"
  $W operate "$TASK" --target 5 --kind display --model anthropic:claude-sonnet-5 --max-steps 30 --detach --json > "$OUT/c/operate.json" 2>"$OUT/c/operate.err"
  RUNID_C=$(jget "$OUT/c/operate.json" 'd.runId')
  echo "runId=$RUNID_C"
  if [ -z "$RUNID_C" ]; then
    check c_operator_started "FAIL" "no runId; see $OUT/c/operate.err"
  else
    check c_operator_started "PASS" "runId=$RUNID_C"
    STATE_C=pending
    for i in $(seq 1 180); do
      sleep 5
      $W operate status "$RUNID_C" --json > "$OUT/c/run-poll.json" 2>/dev/null
      STATE_C=$(jget "$OUT/c/run-poll.json" 'd.state')
      STEPS_C=$(jget "$OUT/c/run-poll.json" '(d.steps||[]).length')
      echo "  t=$((i*5))s state=${STATE_C:-?} steps=${STEPS_C:-?}"
      case "$STATE_C" in succeeded|failed|aborted|timed_out) cp "$OUT/c/run-poll.json" "$OUT/c/run-final.json"; break;; esac
    done
    [ -f "$OUT/c/run-final.json" ] || cp "$OUT/c/run-poll.json" "$OUT/c/run-final.json"
    C_RUNSTATE=$(jget "$OUT/c/run-final.json" 'd.state')
    case "$C_RUNSTATE" in
      succeeded|failed|aborted|timed_out) check c_operator_terminal "PASS" "state=$C_RUNSTATE";;
      *) check c_operator_terminal "FAIL" "state=${C_RUNSTATE:-?}";;
    esac

    echo "-- operator is terminal; deliberately keep recording another 60s"
    OVERRUN_OK=1
    for i in 1 2 3 4 5 6; do
      sleep 10
      $W operate status "$RUNID_C" --json > "$OUT/c/run-after-$i.json" 2>/dev/null
      RS=$(jget "$OUT/c/run-after-$i.json" 'd.state')
      $W status "$SESSION_C" --json > "$OUT/c/status-after-$i.json" 2>/dev/null
      SS=$(jget "$OUT/c/status-after-$i.json" 'd.state || (d.session && d.session.state)')
      CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
      echo "  +$((i*10))s runState=${RS:-?} sessionState=${SS:-?} capProcs=$CAP"
      case "$RS" in succeeded|failed|aborted|timed_out) ;; *) OVERRUN_OK=0;; esac
      [ "$SS" = "recording" ] || OVERRUN_OK=0
    done
    [ "$OVERRUN_OK" = "1" ] && check c_recording_outlives_run "PASS" "run stayed terminal AND session stayed recording for 60s after the run ended" \
      || check c_recording_outlives_run "FAIL" "see the +10s..+60s lines above"
  fi

  $W stop "$SESSION_C" --json > "$OUT/c/stop.json" 2>"$OUT/c/stop.err"
  cat "$OUT/c/stop.json"
  cp "$HOME/.windower/sessions/$SESSION_C.json" "$OUT/c/session.json" 2>/dev/null
  echo "-- session record after stop:"
  cat "$OUT/c/session.json" 2>/dev/null; echo
  C_SSTATE=$(jget "$OUT/c/session.json" 'd.state')
  C_OUTPATH=$(jget "$OUT/c/stop.json" 'd.outputPath')
  C_DUR=$(jget "$OUT/c/stop.json" 'd.manifest.video.durationMs')
  [ "$C_SSTATE" = "stopped" ] && check c_session_stopped "PASS" "state=stopped durationMs=${C_DUR:-?}" || check c_session_stopped "FAIL" "state=${C_SSTATE:-?}"
  [ -n "$C_OUTPATH" ] && [ -f "$C_OUTPATH" ] && check c_video_exists "PASS" "$C_OUTPATH ($(wc -c < "$C_OUTPATH" | tr -d ' ') bytes)" \
    || check c_video_exists "FAIL" "outputPath=${C_OUTPATH:-none}"

  echo "-- grep session record for any operator/run identifier (expected: none):"
  if [ ! -s "$OUT/c/session.json" ]; then
    check c_session_has_no_operator_identity "FAIL" "session record missing/empty — grep never ran, not a clean result"
  else
  HITS=$(grep -inE "operator|runId|${RUNID_C:-__nomatch__}|loop-entry" "$OUT/c/session.json")
  if [ -z "$HITS" ]; then
    check c_session_has_no_operator_identity "PASS" "no operator/run identifier in ~/.windower/sessions/$SESSION_C.json"
  else
    echo "$HITS"
    check c_session_has_no_operator_identity "FAIL" "session record references the operator run"
  fi
  fi
  SESSION_C=""
fi

echo
echo "############ [$LABEL] SHAPE-DIFF HINTS ############"
echo "operator run (no recording):  $OUT/a/run-final.json"
echo "operator run (with recording): $OUT/c/run-final.json"
echo "-- key-set diff a vs c:"
diff <(jget "$OUT/a/run-final.json" 'Object.keys(d).sort().join("\n")') \
     <(jget "$OUT/c/run-final.json" 'Object.keys(d).sort().join("\n")')
KEYDIFF=$?
[ "$KEYDIFF" = "0" ] && echo "   (identical top-level key sets)"
[ "$KEYDIFF" = "0" ] && check operator_shape_parity "PASS" "run JSON top-level key sets identical with and without a recording" \
  || check operator_shape_parity "FAIL" "run JSON key sets differ (see diff above)"
echo "recording (no operator):      $OUT/b/session.json + $OUT/b/manifest.json"
echo "recording (operator-driven):  $OUT/c/session.json"
echo "-- session-record key-set diff b vs c:"
diff <(jget "$OUT/b/session.json" 'Object.keys(d).sort().join("\n")') \
     <(jget "$OUT/c/session.json" 'Object.keys(d).sort().join("\n")')
SKEYDIFF=$?
[ "$SKEYDIFF" = "0" ] && echo "   (identical top-level key sets)"
[ "$SKEYDIFF" = "0" ] && check session_shape_parity "PASS" "session record key sets identical with and without an operator" \
  || check session_shape_parity "FAIL" "session record key sets differ (see diff above)"

echo "############ [$LABEL] FINAL HYGIENE ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "(nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos|[l]oop-entry.js")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control/loop processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"
echo "=== [$LABEL] done — artifacts in $OUT ==="
