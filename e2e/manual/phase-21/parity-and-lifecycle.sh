#!/bin/bash
# Phase 21 live verification — recording-shape parity and capture/control
# lifecycle independence.
#
# Originally structured around the (now-removed) Operator: "operator with no
# recording" / "recording with no operator" / "recording outlives a terminal
# operator run". The Operator is gone (CLAUDE.md: Windower never drives UI
# itself), so this now tests the durable invariants that survive it:
#   (a) a recording driven by synthetic input produces a normal session +
#       manifest — nothing about "who/what drove the screen" leaks in
#   (b) a recording with no driver at all (idle) is likewise unremarkable
#   (c) capture and control have independent lifecycles: a burst of
#       control-surface activity (`windower resize`) can start and finish
#       entirely within a recording's lifetime, and the recording keeps
#       going, unaffected, well past it
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

SESSION_A=""
SESSION_B=""
SESSION_C=""

check() { echo "CHECK $1: $2 $3"; }
jget() {
  node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log("");process.exit(0)}
let v;try{v=eval(process.argv[2])}catch(e){v=""}
console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2"
}

start_synthetic_load() {
  (
    osascript -e 'tell application "TextEdit" to activate' >/dev/null 2>&1
    osascript -e 'tell application "TextEdit" to make new document' >/dev/null 2>&1
    sleep 1
    n=0
    while :; do
      n=$((n+1))
      osascript -e "tell application \"System Events\" to keystroke \"line $n \"" >/dev/null 2>&1
      sleep 1
    done
  ) &
  echo $!
}
stop_synthetic_load() {
  [ -n "$1" ] && kill "$1" 2>/dev/null
  osascript -e 'tell application "TextEdit" to quit saving no' >/dev/null 2>&1
}
pick_window_target() {
  $W targets --kind window --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const d=JSON.parse(s);
    const list=d.targets||[];
    const t=list.find(t=>JSON.stringify(t).match(/textedit/i))||list[0];
    console.log(t?t.id:"");
  }catch(e){console.log("")}
});'
}

cleanup() {
  for s in "$SESSION_A" "$SESSION_B" "$SESSION_C"; do
    if [ -n "$s" ]; then
      echo "=== [$LABEL] TRAP cleanup: stopping recording $s (no-op if already stopped) ==="
      $W stop "$s" --json > "$OUT/stop-trap-$s.json" 2>&1
    fi
  done
}
trap cleanup EXIT INT TERM

echo "############ [$LABEL] PRECONDITION ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(no sidecars)"
echo "-- active sessions before we start:"
$W list --json 2>/dev/null | head -c 800; echo

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (a) RECORDING, SYNTHETIC-INPUT LOAD"
echo "########################################################"
$W start --target 5 --kind display --json > "$OUT/a/start.json" 2>"$OUT/a/start.err"
SESSION_A=$(jget "$OUT/a/start.json" 'd.sessionId')
echo "sessionId=$SESSION_A"
if [ -z "$SESSION_A" ]; then
  check a_start_recording "FAIL" "no sessionId; see $OUT/a/start.err"
else
  check a_start_recording "PASS" "sessionId=$SESSION_A"
  LOAD_PID=$(start_synthetic_load)
  echo "-- driving synthetic input for 45s"
  sleep 45
  stop_synthetic_load "$LOAD_PID"

  $W stop "$SESSION_A" --json > "$OUT/a/stop.json" 2>"$OUT/a/stop.err"
  cat "$OUT/a/stop.json"
  cp "$HOME/.windower/sessions/$SESSION_A.json" "$OUT/a/session.json" 2>/dev/null
  A_SSTATE=$(jget "$OUT/a/session.json" 'd.state')
  A_OUTPATH=$(jget "$OUT/a/stop.json" 'd.outputPath')
  A_SKEYS=$(jget "$OUT/a/session.json" 'Object.keys(d).sort().join(",")')
  echo "session record keys: $A_SKEYS"

  [ "$A_SSTATE" = "stopped" ] && check a_session_stopped "PASS" "state=stopped" || check a_session_stopped "FAIL" "state=${A_SSTATE:-?}"
  [ -n "$A_OUTPATH" ] && [ -f "$A_OUTPATH" ] && check a_video_exists "PASS" "$A_OUTPATH ($(wc -c < "$A_OUTPATH" | tr -d ' ') bytes)" \
    || check a_video_exists "FAIL" "outputPath=${A_OUTPATH:-none}"
  SESSION_A=""
fi

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (b) RECORDING, IDLE (NO DRIVER) ##"
echo "########################################################"
$W start --target 5 --kind display --json > "$OUT/b/start.json" 2>"$OUT/b/start.err"
SESSION_B=$(jget "$OUT/b/start.json" 'd.sessionId')
echo "sessionId=$SESSION_B"
if [ -z "$SESSION_B" ]; then
  check b_start_recording "FAIL" "no sessionId; see $OUT/b/start.err"
else
  check b_start_recording "PASS" "sessionId=$SESSION_B"
  echo "-- idling 45s with no driver at all"
  for i in 1 2 3; do
    sleep 15
    CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
    echo "  t=$((i*15))s capProcs=$CAP"
  done

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

  [ "$B_SSTATE" = "stopped" ] && check b_session_stopped "PASS" "state=stopped" || check b_session_stopped "FAIL" "state=${B_SSTATE:-?}"
  [ -n "$B_OUTPATH" ] && [ -f "$B_OUTPATH" ] && check b_video_exists "PASS" "$B_OUTPATH ($(wc -c < "$B_OUTPATH" | tr -d ' ') bytes)" \
    || check b_video_exists "FAIL" "outputPath=${B_OUTPATH:-none}"
  B_DRIVER=$(grep -ioE '"(driver|agent|operator)"' "$OUT/b/session.json" "$OUT/b/manifest.json" 2>/dev/null | sort -u | tr '\n' ' ')
  [ -z "$B_DRIVER" ] && check b_no_driver_identity "PASS" "session/manifest carry no driver identity" \
    || check b_no_driver_identity "FAIL" "found: $B_DRIVER"
  SESSION_B=""
fi

##########################################################################
echo
echo "########################################################"
echo "############ [$LABEL] (c) INDEPENDENT LIFECYCLE: CONTROL vs CAPTURE"
echo "########################################################"
$W start --target 5 --kind display --json > "$OUT/c/start.json" 2>"$OUT/c/start.err"
SESSION_C=$(jget "$OUT/c/start.json" 'd.sessionId')
echo "sessionId=$SESSION_C"
if [ -z "$SESSION_C" ]; then
  check c_start_recording "FAIL" "no sessionId; see $OUT/c/start.err"
else
  check c_start_recording "PASS" "sessionId=$SESSION_C"

  WIN_ID=$(pick_window_target)
  echo "resizeTargetWindowId=${WIN_ID:-none}"
  if [ -z "$WIN_ID" ]; then
    check c_resize_target_found "FAIL" "could not resolve a window target"
  else
    check c_resize_target_found "PASS" "windowId=$WIN_ID"
    echo "-- a short burst of control-surface activity (windower resize), then it ends"
    for i in 1 2 3 4 5; do
      w=$((900 + i*10)); h=$((600 + i*10))
      $W resize --window "$WIN_ID" --width "$w" --height "$h" --json > "$OUT/c/resize-$i.json" 2>"$OUT/c/resize-$i.err"
      RC=$?
      echo "  resize #$i -> exit=$RC"
      sleep 3
    done
    check c_control_burst_finished "PASS" "5 resize calls completed"
  fi

  echo "-- control activity is over; deliberately keep recording another 60s"
  OVERRUN_OK=1
  for i in 1 2 3 4 5 6; do
    sleep 10
    $W status "$SESSION_C" --json > "$OUT/c/status-after-$i.json" 2>/dev/null
    SS=$(jget "$OUT/c/status-after-$i.json" 'd.state || (d.session && d.session.state)')
    CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
    CTRL=$(ps -eo pid,ppid,command | grep -c "[w]indower-control-macos")
    echo "  +$((i*10))s sessionState=${SS:-?} capProcs=$CAP ctrlProcs=$CTRL"
    [ "$SS" = "recording" ] || OVERRUN_OK=0
  done
  [ "$OVERRUN_OK" = "1" ] && check c_recording_outlives_control_burst "PASS" "session stayed recording for 60s after the resize burst ended" \
    || check c_recording_outlives_control_burst "FAIL" "see the +10s..+60s lines above"

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

  echo "-- grep session record for any control-window/resize identifier (expected: none):"
  if [ ! -s "$OUT/c/session.json" ]; then
    check c_session_has_no_control_identity "FAIL" "session record missing/empty — grep never ran, not a clean result"
  else
    HITS=$(grep -inE "\"(resizeTarget|windowId|controlPid)\"" "$OUT/c/session.json")
    if [ -z "$HITS" ]; then
      check c_session_has_no_control_identity "PASS" "no control-surface identifier in ~/.windower/sessions/$SESSION_C.json"
    else
      echo "$HITS"
      check c_session_has_no_control_identity "FAIL" "session record references control-surface state"
    fi
  fi
  SESSION_C=""
fi

echo
echo "############ [$LABEL] SHAPE-DIFF HINTS ############"
echo "recording (synthetic-input driven): $OUT/a/session.json"
echo "recording (idle, no driver):        $OUT/b/session.json"
echo "-- session-record key-set diff a vs b (recording shape must not depend on who/what drove the screen):"
diff <(jget "$OUT/a/session.json" 'Object.keys(d).sort().join("\n")') \
     <(jget "$OUT/b/session.json" 'Object.keys(d).sort().join("\n")')
SKEYDIFF=$?
[ "$SKEYDIFF" = "0" ] && echo "   (identical top-level key sets)"
[ "$SKEYDIFF" = "0" ] && check session_shape_parity "PASS" "session record key sets identical regardless of driver" \
  || check session_shape_parity "FAIL" "session record key sets differ (see diff above)"

echo "############ [$LABEL] FINAL HYGIENE ############"
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"
echo "=== [$LABEL] done — artifacts in $OUT ==="
