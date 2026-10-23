#!/bin/sh
# Sandbox fallback for `pnpm --silent --dir "$WINDOWER" ve:<name> <args>`.
# Use only when pnpm ve:* fails with EPERM / IPC errors (tsx creates a pipe in the system temp dir).
# Usage: sh "$WINDOWER/scripts/ve.sh" <name> <args>   (e.g. ve.sh gate "$RUN" --no-voice)
# The name -> script mapping is read from package.json ("ve:<name>": "tsx scripts/<file>.ts"),
# so it cannot drift. Like pnpm --dir, it runs from the windower directory: pass absolute paths.
set -eu

WINDOWER=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
name=${1:-}
if [ -z "$name" ]; then
  echo "usage: ve.sh <name> [args...]   (name without the ve: prefix)" >&2
  exit 64
fi
shift

TMPDIR=${WINDOWER_TMPDIR:-$WINDOWER/.tmp}
mkdir -p "$TMPDIR"
export TMPDIR

cd "$WINDOWER"
script=$(node -e '
  const s = require("./package.json").scripts["ve:" + process.argv[1]];
  const m = typeof s === "string" && /^tsx (scripts\/[A-Za-z0-9._-]+\.ts)$/.exec(s);
  if (!m) { process.stderr.write("unknown script ve:" + process.argv[1] + "\n"); process.exit(64); }
  process.stdout.write(m[1]);
' "$name")

exec node --import "$WINDOWER/node_modules/tsx/dist/esm/index.mjs" "$script" "$@"
