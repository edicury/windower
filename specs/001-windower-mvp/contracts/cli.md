# CLI Contract

Binary name: `windower`. Every command supports `--json` for machine-readable output (agent-preferred); without it, output is human-readable text. Exit code `0` on success, non-zero with a `{ error: { code, message } }` JSON body (or matching text) on failure — codes match the sidecar error taxonomy in `contracts/sidecar-protocol.md` plus daemon-level ones (`DAEMON_UNREACHABLE`, `INVALID_ARGS`).

## `windower targets [--kind display|window|app] [--json]`
Lists current `CaptureTarget`s. Agents use this first to discover what's on screen.

## `windower doctor [--json]`
Runs `PermissionReport` + daemon/sidecar health check. Never triggers a permission prompt — read-only.

## `windower permission request <screenRecording|accessibility|microphone>`
Explicitly triggers the OS permission prompt for one capability. Separate from `doctor` so agents don't accidentally spam prompts while just checking status.

## `windower resize --window <id> --width <px> --height <px> [--x <px>] [--y <px>] [--json]`
Resizes/repositions a window before recording. Returns `actualBounds` and `result: success|partial|unsupported`.

## `windower start --target <id> [--kind window|display|region] [--region x,y,w,h] [video/audio flags below] [--json]`
Starts a session in the background daemon, returns immediately with `{ sessionId }`. Does not block.

Shared video/audio flags (also used by `record`, below):
```
--fps 24|30|60                  (default 30)
--codec h264|hevc               (default h264)
--container mp4|mov             (default mp4)
--resolution WxH                (default: target's native resolution)
--quality low|medium|high|lossless_ish  (default high)
--no-cursor                     (default: cursor shown)
--audio-system                  (default: off)
--audio-mic [--mic-device <id>] (default: off)
--separate-tracks               (default: on when >1 audio source)
--out <dir>                     (default: configured output folder)
```

## `windower status <sessionId> [--json]`
Returns the current `RecordingSession` — state, elapsed time, target.

## `windower stop <sessionId> [--narration <file> --narration-offset <ms>] [--json]`
Finalizes the recording. Returns `outputPath`, `manifestPath`, `eventTimelinePath`.

## `windower cancel <sessionId> [--json]`
Discards an in-progress recording — no output file produced.

## `windower record [same flags as start] --duration <seconds> [--json]`
Convenience wrapper: `start` + sleep `duration` + `stop`, blocking. For unattended/scripted captures where no agent action needs to happen mid-recording (see `spec.md` US-05/06 — `start`/`stop` is the primary agent-facing flow; `record` is sugar).

## `windower config get|set <key> <value>`
Reads/writes `~/.windower/config.json` — output folder, filename template, daemon idle-timeout, default video/audio settings.

## `windower daemon status|stop`
Explicit daemon lifecycle control, mostly for debugging — the daemon auto-starts on first use of any other command.

## `windower list [--state recording|finalized|...] [--json]`
Lists known sessions (from `~/.windower/sessions/`), most recent first — lets an agent recover context after a restart ("what was I recording?").

## `windower operate "<task>" [recording flags] [--model p:m] [--base-url u] [--secret name=source:ref]... [--max-steps n] [--timeout s] [--unbounded] [--no-record] [--json]`
Starts a guided operator run: an LLM-driven loop that perceives the screen (`captureFrame`), synthesizes mouse/keyboard input (`performInput`), and drives `<task>` to completion. Returns immediately with `{ runId }` — same non-blocking two-call shape as `start`/`stop`. `[recording flags]` reuse the exact shared video/audio flag block documented under `windower start` above (`--fps`, `--codec`, `--resolution`, `--audio-mic`, `--out`, etc.) — not redefined here. Recording is auto-started alongside the run unless `--no-record` is passed. `--model p:m` selects a provider:model pair (e.g. `openai:gpt-4o`, `anthropic:claude-sonnet-5`, `openai-compatible:llama3` for a local server via `--base-url`); the operator's model is independent of and unrelated to whatever agent/model is calling the CLI. `--secret name=source:ref` (repeatable) resolves a named secret (e.g. `password=keychain:waroom`) at call time and substitutes it into typed input — the raw value is never written to the CLI's own argv logging or the operator's transcript. `--max-steps`/`--timeout` bound the run; `--unbounded` explicitly opts out of both (use with care).

Example:
```
windower operate "Open waroom.co, log in as {{user}}/{{password}}, create an incident" \
  --secret password=keychain:waroom --resolution 1920x1080 --out ~/Desktop
```

## `windower operate status <runId>`
Returns the current `OperatorRun` — state, steps so far, elapsed time.

## `windower operate abort <runId>`
Aborts an in-progress operator run mid-flight; any active recording is stopped/finalized rather than discarded.

## `windower operate list [--state <state>]`
Lists known operator runs, most recent first — same recovery-after-restart affordance as `windower list` for sessions.

No new exit codes are introduced for `operate` — it reuses the existing `0`/`1`/`2`/`3` scheme documented above.
