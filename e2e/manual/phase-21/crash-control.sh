#!/bin/bash
# Phase 21 live verification — crash isolation: kill -9 the CONTROL sidecar
# (windower-control-macos) mid-recording and observe capture behavior.
#
# The control sidecar is exercised by `windower resize` — synthetic input via
# osascript/System Events (used elsewhere in this directory as a load
# generator) never touches windower-control-macos at all, it's macOS's own
# GUI scripting. So this script drives a repeating `windower resize` loop
# against a real window to keep a live control sidecar around to kill, plus
# a background osascript loop for general on-screen activity so the
# recording has something to capture. This replaces what `windower operate`
# used to generate as a side effect of its own click/keystroke actions —
# there is no Windower operator anymore (see CLAUDE.md: Windower never
# drives UI itself).
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

SESSION=""
STOPPED=0
LOAD_PID=""
RESIZE_PID=""

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

# Finds a resizable TextEdit window id via `windower targets`, for the resize
# loop below to hammer — this is what keeps windower-control-macos alive.
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

start_resize_loop() {
  local winId="$1"
  (
    w=900; h=600
    while :; do
      w=$((w==900?920:900)); h=$((h==600?620:600))
      $W resize --window "$winId" --width "$w" --height "$h" --json >/dev/null 2>&1
      sleep 2
    done
  ) &
  echo $!
}

cleanup() {
  [ -n "$RESIZE_PID" ] && kill "$RESIZE_PID" 2>/dev/null
  stop_synthetic_load "$LOAD_PID"
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

echo "############ [$LABEL] START SYNTHETIC LOAD + RESIZE LOOP ############"
LOAD_PID=$(start_synthetic_load)
echo "loadPid=$LOAD_PID"
sleep 2
WIN_ID=$(pick_window_target)
echo "resizeTargetWindowId=${WIN_ID:-none}"
if [ -z "$WIN_ID" ]; then
  check resize_target_found "FAIL" "could not resolve a window target for windower resize"
else
  check resize_target_found "PASS" "windowId=$WIN_ID"
  RESIZE_PID=$(start_resize_loop "$WIN_ID")
  echo "resizeLoopPid=$RESIZE_PID"
fi

echo "############ [$LABEL] WAIT FOR A LIVE CONTROL SIDECAR ############"
CTRL_PID=""
for i in $(seq 1 40); do
  sleep 3
  CTRL_PID=$(ps -eo pid,ppid,command | grep "[w]indower-control-macos" | awk '{print $1}' | head -1)
  echo "  t=$((i*3))s controlPid=${CTRL_PID:-none}"
  [ -n "$CTRL_PID" ] && [ $i -ge 3 ] && break
done

if [ -z "$CTRL_PID" ]; then
  check control_sidecar_present "FAIL" "no windower-control-macos observed; nothing to kill"
else
  check control_sidecar_present "PASS" "pid=$CTRL_PID"
  echo "############ [$LABEL] KILL -9 CONTROL SIDECAR pid=$CTRL_PID ############"
  date +"killAt=%H:%M:%S" | tee "$OUT/kill.txt"
  kill -9 "$CTRL_PID" 2>/dev/null
  sleep 2
  echo "-- ps right after kill:"
  ps -eo pid,ppid,command | grep "[w]indower-control-macos" || echo "   (no control process)"
fi

echo "############ [$LABEL] WAIT FOR RESIZE LOOP TO RESPAWN CONTROL SIDECAR ############"
RESPAWN_SEEN=0
RESPAWN_PID=""
for i in $(seq 1 20); do
  sleep 3
  NEW=$(ps -eo pid,ppid,command | grep "[w]indower-control-macos" | awk '{print $1}' | head -1)
  CAP=$(ps -eo pid,ppid,command | grep -c "[w]indower-capture-macos")
  echo "  t=$((i*3))s controlPid=${NEW:-none} capProcs=$CAP"
  if [ -n "$NEW" ] && [ "$NEW" != "$CTRL_PID" ]; then RESPAWN_SEEN=1; RESPAWN_PID="$NEW"; break; fi
done

echo "############ [$LABEL] STOP RESIZE LOOP + SYNTHETIC LOAD ############"
[ -n "$RESIZE_PID" ] && kill "$RESIZE_PID" 2>/dev/null; RESIZE_PID=""
stop_synthetic_load "$LOAD_PID"; LOAD_PID=""

echo "############ [$LABEL] STOP RECORDING ############"
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
STOPPED=1
cat "$OUT/stop.json"
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json" 2>/dev/null

echo "############ [$LABEL] RESULTS ############"
OUTPATH=$(jget "$OUT/stop.json" 'd.outputPath')
DUR=$(jget "$OUT/stop.json" 'd.manifest.video.durationMs')
SSTATE=$(jget "$OUT/session.json" 'd.state')
STARTED=$(jget "$OUT/session.json" 'd.startedAt')
ENDED=$(jget "$OUT/session.json" 'd.stoppedAt')
WALL=$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);console.log(isNaN(a)||isNaN(b)?"":b-a)' "$STARTED" "$ENDED")

echo "control respawn after kill: seen=$RESPAWN_SEEN pid=${RESPAWN_PID:-none}"
echo "recording: durationMs=${DUR:-?} wallMs=${WALL:-?} sessionState=${SSTATE:-?}"

echo
echo "############ [$LABEL] CHECKS ############"
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
ps -eo pid,ppid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(nothing orphaned — good)"
LEFT=$(ps -eo pid,command | grep -cE "[w]indower-(capture|control)-macos")
[ "$LEFT" = "0" ] && check no_orphans "PASS" "no capture/control processes left" || check no_orphans "FAIL" "$LEFT process(es) left behind"

echo "SESSION=$SESSION KILLEDCTRL=${CTRL_PID:-none}" > "$OUT/ids.txt"
echo "=== [$LABEL] done — artifacts in $OUT ==="
