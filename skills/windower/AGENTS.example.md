# AGENTS.md (example for the windower skill)

Copy this into your project's `AGENTS.md` and replace the paths.

- To make an explainer video, use the windower skill. Read `/absolute/path/to/windower/skills/windower/SKILL.md` first and follow it.
- The windower scripts live in `/absolute/path/to/windower`. Set `WINDOWER_HOME=/absolute/path/to/windower` (this file's path is the fallback when `${CLAUDE_PLUGIN_ROOT}` is not set).
- Run scripts as `pnpm --silent --dir "$WINDOWER_HOME" ve:<name> <args>` with absolute path arguments. If that fails with EPERM or an IPC error in a sandbox, run `sh "$WINDOWER_HOME/scripts/ve.sh" <name> <args>` instead.
- Always write the product name lowercase: `windower`.
- Stop at the approval gate and relay the full `ve:gate` output verbatim; never render without an explicit approval.
- `ve:render` and `ve:snapshots` need Chrome and a local port. In a sandbox such as Codex `workspace-write` on macOS (seatbelt: Chromium bootstrap permission denied, listen on 127.0.0.1 EPERM), run render outside the sandbox or via the harness's escalation request. `ve:synth` needs network access.
- `ve:prepare` writes narration audio into `$WINDOWER_HOME/template/public/audio`. If that directory is read-only, use a writable copy of the plugin and point `WINDOWER_HOME` at it.
- The logo and brand colors come from `.windower.json` at the root of the repo being explained; without one the video is unbranded.
