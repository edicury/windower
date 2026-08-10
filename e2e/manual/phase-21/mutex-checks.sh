#!/bin/bash
# Phase 21 live verification — ScreenCaptureKit exclusivity mutex behavior.
# Run with NO daemon and NO recording active.
set -uo pipefail
REPO=/Users/edicury/Documents/Development/windower
cd "$REPO"
set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

echo "############ PRECONDITION ############"
ps -eo pid,command | grep -E "[w]indower-(capture|control)-macos|[d]aemon/dist/bin.js" || echo "(no windower processes)"
ls -la ~/.windower/capture.lock 2>&1 | head -1

echo
echo "############ TEST A — busy-mutex behavior ############"
# Daemon-free recording holds the lock for its whole lifetime.
$W record --duration 30 --target 5 --kind display --json > /tmp/holder.json 2>/tmp/holder.err &
HOLDER=$!
sleep 6
echo "-- lock file while holder live:"; cat ~/.windower/capture.lock 2>&1
echo "-- capture processes (expect exactly 1):"; ps -eo pid,ppid,command | grep "[w]indower-capture-macos"
echo "-- second daemon-free capture call (windower targets):"
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
$W targets --json --no-daemon > /tmp/second.json 2>/tmp/second.err; RC=$?
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
echo "   exit=$RC elapsed=$((T1-T0))ms"
echo "   stdout head:"; head -c 400 /tmp/second.json
echo "   stderr head:"; head -c 600 /tmp/second.err
echo "-- capture processes during/after second call (expect still exactly 1):"
ps -eo pid,ppid,command | grep "[w]indower-capture-macos"
wait $HOLDER
echo "-- holder finished; lock after release:"; ls -la ~/.windower/capture.lock 2>&1 | head -1

echo
echo "############ TEST B — stale-holder recovery ############"
$W record --duration 60 --target 5 --kind display --json > /tmp/holder2.json 2>/tmp/holder2.err &
HOLDER2=$!
sleep 6
echo "-- lock holder pid recorded in lock file:"; cat ~/.windower/capture.lock 2>&1
echo "-- kill -9 the lock OWNER process (pid $HOLDER2)"
kill -9 $HOLDER2 2>/dev/null
sleep 2
echo "-- capture child survived? (expect none — stdin EOF ownership):"
ps -eo pid,ppid,command | grep "[w]indower-capture-macos" || echo "   (none — good)"
echo "-- stale lock file still present?"; cat ~/.windower/capture.lock 2>&1 | head -2
echo "-- immediate daemon-free list_targets (expect clean stale-steal, not a wedge):"
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
$W targets --json --no-daemon > /tmp/steal.json 2>/tmp/steal.err; RC=$?
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
echo "   exit=$RC elapsed=$((T1-T0))ms targets=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("/tmp/steal.json","utf8")).targets.length)}catch(e){console.log("PARSE FAIL")}')"
head -c 400 /tmp/steal.err
echo
echo "-- second call, to prove the surface is not wedged:"
$W targets --json --no-daemon > /tmp/steal2.json 2>&1; echo "   exit=$? targets=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("/tmp/steal2.json","utf8")).targets.length)}catch(e){console.log("PARSE FAIL")}')"

echo
echo "############ FINAL HYGIENE ############"
ps -eo pid,command | grep -E "[w]indower-(capture|control)-macos" || echo "(no native sidecars — good)"
ls -la ~/.windower/capture.lock 2>&1 | head -1
