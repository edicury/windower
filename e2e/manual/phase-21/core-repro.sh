#!/bin/bash
# Phase 21 live verification — core repro (caller-driven orchestration).
# Usage: core-repro.sh <run-label>
set -uo pipefail

REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
LABEL="${1:-run}"
OUT="$SCRATCH/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"

cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

TASK='Open Safari and navigate to waroom.co. Use Finder to open the Applications folder and launch Safari from there if it is not already running. Once the page has loaded, you are done.'

echo "=== [$LABEL] start_recording ==="
START_JSON=$($W start --target 5 --kind display --json 2>"$OUT/start.err")
echo "$START_JSON" > "$OUT/start.json"
SESSION=$(echo "$START_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessionId))')
echo "sessionId=$SESSION"
[ -z "$SESSION" ] && { echo "FAILED to start recording"; cat "$OUT/start.err"; exit 1; }

echo "=== [$LABEL] run_operator (detached, daemon-backed) ==="
OP_JSON=$($W operate "$TASK" --target 5 --kind display --model anthropic:claude-sonnet-5 --max-steps 30 --timeout 420 --detach --json 2>"$OUT/operate.err")
echo "$OP_JSON" > "$OUT/operate.json"
RUNID=$(echo "$OP_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).runId)}catch(e){}})')
echo "runId=$RUNID"
if [ -z "$RUNID" ]; then
  echo "FAILED to start operator run"; cat "$OUT/operate.err"
  $W stop "$SESSION" --json > "$OUT/stop.json" 2>&1
  exit 1
fi

echo "=== [$LABEL] poll get_operator_run ==="
STATE=running
for i in $(seq 1 180); do
  sleep 5
  ST=$($W operate status "$RUNID" --json 2>/dev/null)
  STATE=$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.state)}catch(e){console.log("?")}})')
  STEPS=$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log((r.steps||[]).length)}catch(e){console.log("?")}})')
  echo "  t=$((i*5))s state=$STATE steps=$STEPS"
  case "$STATE" in
    succeeded|failed|aborted|timed_out) echo "$ST" > "$OUT/run-final.json"; break;;
  esac
done

echo "=== [$LABEL] stop_recording ==="
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
cat "$OUT/stop.json"

cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json" 2>/dev/null
echo "SESSION=$SESSION RUNID=$RUNID STATE=$STATE" > "$OUT/ids.txt"
echo "=== [$LABEL] done ==="
