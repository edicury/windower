#!/bin/bash
# Phase 21 live verification — recording-without-operator parity (model-free half).
set -uo pipefail
REPO=/Users/edicury/Documents/Development/windower
SCRATCH=/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad
OUT="$SCRATCH/parityb"; rm -rf "$OUT"; mkdir -p "$OUT"
cd "$REPO"; set -a; . ./.env; set +a
W="node $REPO/packages/cli/dist/index.js"

echo "=== start recording (no operator will run at all) ==="
$W start --target 5 --kind display --json > "$OUT/start.json" 2>"$OUT/start.err"
SESSION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sessionId)' "$OUT/start.json")
echo "sessionId=$SESSION"

echo "=== human/agent-driven activity window: 45s of ordinary desktop use ==="
# Deliberately drive the screen with something that is NOT the Windower operator.
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
sleep 15
osascript -e 'tell application "System Events" to key code 126' >/dev/null 2>&1
sleep 15
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
sleep 15

echo "=== stop ==="
$W stop "$SESSION" --json > "$OUT/stop.json" 2>"$OUT/stop.err"
cp "$HOME/.windower/sessions/$SESSION.json" "$OUT/session.json"
cat "$OUT/stop.json"

echo
echo "=== SHAPE COMPARISON vs the caller-driven runs ==="
node - "$OUT" "$SCRATCH/run1" "$SCRATCH/run2" "$SCRATCH/run3" <<'EOF'
const fs = require("node:fs");
const keys = (o, p = "") =>
  Object.entries(o ?? {}).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`],
  );
const load = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const [b, ...runs] = process.argv.slice(2);

const bSession = keys(load(`${b}/session.json`)).sort();
const bManifest = keys(load(`${b}/stop.json`).manifest).sort();
let fail = 0;
for (const r of runs) {
  const rSession = keys(load(`${r}/session.json`)).sort();
  const rManifest = keys(load(`${r}/stop.json`).manifest).sort();
  const dS = [
    ...bSession.filter((k) => !rSession.includes(k)).map((k) => `only-in-no-operator: ${k}`),
    ...rSession.filter((k) => !bSession.includes(k)).map((k) => `only-in-caller-driven: ${k}`),
  ];
  const dM = [
    ...bManifest.filter((k) => !rManifest.includes(k)).map((k) => `only-in-no-operator: ${k}`),
    ...rManifest.filter((k) => !bManifest.includes(k)).map((k) => `only-in-caller-driven: ${k}`),
  ];
  const tag = r.split("/").pop();
  console.log(`CHECK session_shape_vs_${tag}: ${dS.length === 0 ? "PASS identical key set" : `FAIL ${dS.join(", ")}`}`);
  console.log(`CHECK manifest_shape_vs_${tag}: ${dM.length === 0 ? "PASS identical key set" : `FAIL ${dM.join(", ")}`}`);
  if (dS.length || dM.length) fail = 1;
}
// Nothing anywhere may identify what drove the screen.
const raw = fs.readFileSync(`${b}/session.json`, "utf8") + fs.readFileSync(`${b}/stop.json`, "utf8");
const hits = raw.match(/operator|runId|loop-entry/gi) ?? [];
console.log(`CHECK no_driver_identity: ${hits.length === 0 ? "PASS nothing names what drove the screen" : `FAIL ${[...new Set(hits)].join(", ")}`}`);
process.exit(fail);
EOF

echo
echo "=== events timeline source tags (no operator ran — expect none tagged operator) ==="
node -e '
const fs=require("node:fs");
const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).eventTimelinePath;
const e=JSON.parse(fs.readFileSync(p,"utf8"));
const list=Array.isArray(e)?e:(e.events??[]);
const counts={};
for(const x of list) counts[x.source??"(none)"]=(counts[x.source??"(none)"]??0)+1;
console.log("event source counts:",JSON.stringify(counts));
console.log(`CHECK no_operator_tagged_events: ${(counts.operator??0)===0?"PASS":"FAIL "+counts.operator}`);
' "$OUT/stop.json"

echo
echo "=== FINAL RESOURCE HYGIENE ==="
ps -eo pid,command | grep -E "[w]indower-(capture|control)-macos|[l]oop-entry.js" || echo "CHECK no_orphan_processes: PASS (no capture/control/loop children)"
ls ~/.windower/capture.lock >/dev/null 2>&1 && echo "CHECK lock_released: FAIL (capture.lock still present)" || echo "CHECK lock_released: PASS (no capture.lock)"
