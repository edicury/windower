---
name: windower
description: |
  Record a screen demo (window, display, or region) using the Windower MCP
  tools (list_targets, check_permissions, request_permission, resize_window,
  start_recording, get_session, stop_recording, cancel_recording,
  list_sessions) — and, when you have no tool that can drive the UI in
  question, hand the whole task to Windower's own operator (run_operator,
  get_operator_run, abort_operator_run). Use whenever the user asks to record,
  capture, screen-record, or make a video/demo/screencast of an app, browser,
  terminal, or workflow — including narrated demos. Triggers: "record a demo",
  "screen record", "capture this", "make a video of", "record yourself doing
  X", "narrate a recording", "log in and record it", "do this in the app and
  record it".
---

# Windower — record-a-demo skill

Windower records real on-screen activity (a window, a display, or a region)
to a video file, with an optional cursor/click event timeline and optional
narration audio. You drive it entirely through the MCP tools listed above —
never shell out to a `windower` CLI binary from inside this skill.

## The workflow

1. **Enumerate targets** — `list_targets` to find the window/display/app to record.
2. **Optionally resize** — `resize_window` if you want deterministic framing (e.g. exactly 1280x720) before recording.
3. **Start recording** — `start_recording`. Returns `{ sessionId }` immediately.
4. **Perform the actions being demoed** — click, type, run commands, navigate — whatever the demo is about.
5. **Stop recording** — `stop_recording` with the `sessionId` (and `narration` if applicable).
6. **Report to the user** — the output video path, and that a manifest/event timeline were also written.

## The single most important thing: start/stop is a two-call, non-blocking pattern

**`start_recording` returns in well under a second with only `{ sessionId }`. It does NOT wait for the recording to finish.** This was verified live during dogfood testing — the call returns near-instantly, before any actual screen activity has happened.

This is the opposite of most "do X" tools, which block until X is done. Here, calling `start_recording` is just "arm the recorder." The recording only contains something useful once you go on to *do* the on-screen actions and *then* call `stop_recording`.

**Wrong:**
```
start_recording({ target })
# treat the call as "the demo is now recorded" — WRONG.
# Nothing has been captured yet except a blank/idle screen.
stop_recording({ sessionId })
```

**Right:**
```
start_recording({ target })                 # → { sessionId: "abc123" }
# now actually perform the demo — click through the UI, type
# commands, navigate a browser, etc. This is the part that matters.
...perform the on-screen actions being demoed...
stop_recording({ sessionId: "abc123" })      # → { outputPath, manifestPath, ... }
```

If you find yourself calling `stop_recording` in the same turn as `start_recording` with no real work in between, stop — you have not actually recorded anything worth keeping.

## Driving the UI yourself vs. delegating to the operator

**The two-call flow above, where *you* perform the on-screen actions with your
own tools, is the default. Reach for it first.** You are the agent that
understands the user's intent, so you drive; Windower records. Don't hand a
task to the operator just because it sounds autonomous.

`run_operator` exists for the cases where "step 4 — perform the actions being
demoed" is something you genuinely cannot do:

- **Native / desktop UI you have no tool for.** Your browser tool is
  browser-only. A macOS app, a preferences pane, a native installer, an
  Electron app's OS-level chrome, a menu bar item, a system dialog — you have
  no way to click those. The operator does: it perceives the screen with
  `captureFrame` and drives real mouse/keyboard input through the sidecar.
- **The user handed you one instruction to be executed and recorded
  end-to-end.** "Open the app, log in with these creds, create an incident to
  showcase, record it in 1080p" is a single natural-language task with a video
  as the deliverable. Passing it through verbatim is both simpler and closer
  to what was asked than decomposing it into a dozen tool calls of your own.

Keep driving it yourself when:

- The whole demo happens in a browser and your browser tool can reach it —
  you'll be faster, more reliable, and more precise than pixel-level input.
- You need to interleave non-UI work (run a command, edit a file, call an API)
  with the on-screen steps. The operator's tool surface is deliberately closed:
  screenshot, mouse, keyboard, wait, list targets, resize, done/fail. It has
  no shell, no filesystem, no network tool.
- The user wants to review or steer each step. The operator runs to completion
  on its own; there is no per-step approval surface.

### Using it

```
run_operator({
  task: "Open the app, log in as {{user}} / {{password}}, create an incident called 'Checkout latency'",
  model: { provider: "anthropic", model: "claude-sonnet-5" },
  secrets: [
    { name: "user", source: "env", ref: "DEMO_USER" },
    { name: "password", source: "keychain", ref: "waroom-demo" }
  ],
  recording: {
    video: { resolution: { width: 1920, height: 1080 }, fps: 30 },
    outputDir: "~/Desktop"
  },
  guardrails: { maxSteps: 40, timeoutSeconds: 300 }
})
# → { runId: "op_9c31" } — returns immediately, same non-blocking shape as start_recording
```

Then poll `get_operator_run({ runId })` for `state`
(`running|succeeded|failed|aborted`) and the step transcript, and
`abort_operator_run({ runId })` to stop a run that's gone wrong — an active
recording is finalized rather than discarded.

**Credentials.** Never put a password, token, or API key in the `task` string.
Pass it as a secret ref (`env`, `keychain`, or — discouraged — `literal`) and
refer to it in the task as `{{name}}`. The operator's model only ever sees the
`{{name}}` placeholder; the real value is substituted immediately before the
input is typed, and a redaction filter scrubs the transcript, the logs, and
the event timeline before anything is written to disk. If a user pastes a
credential to you directly, tell them to store it in the keychain or an env
var and pass the ref instead.

**Guardrails are real, not advisory.** The step cap (default 40), the
wall-clock timeout (default 5 min), the clamp of every coordinate to the
recorded target's bounds, and abort are all enforced by the Windower runtime,
not requested in the model's prompt. A run that hits one ends as `failed` with
a structured error — you don't need to police the operator yourself, but you
should report those failures to the user plainly rather than retrying blindly.

**Reporting.** An operator run writes the usual video + `manifest.json` +
event timeline, plus `<recording>.operator.json` — the step-by-step transcript
of what it saw and did. Mention it alongside the other paths. Synthetic input
is tagged `source: "operator"` in the event timeline, so a later editing pass
can tell operator clicks from a human's.

## Recipes

### Record a browser demo

```
list_targets({ kinds: ["window"] })
# → find the browser window, e.g. { kind: "window", id: "42", title: "Windower — GitHub", appName: "Google Chrome", ... }

resize_window({ targetId: "42", bounds: { x: 0, y: 0, width: 1280, height: 800 } })
# optional but recommended: deterministic framing for a clean recording

start_recording({
  target: { targetId: "42" },
  video: { fps: 30, quality: "high" }
})
# → { sessionId: "sess_01" }

# ...drive the browser: navigate, click, fill forms...

stop_recording({ sessionId: "sess_01" })
# → { outputPath: "/Users/.../windower/2026-08-09-browser-demo.mp4", manifestPath: "...", eventTimelinePath: "..." }
```

### Record a terminal session

```
list_targets({ kinds: ["window"] })
# → find the terminal window, e.g. { kind: "window", id: "17", appName: "Terminal", title: "zsh — windower", ... }

start_recording({
  target: { targetId: "17" },
  video: { fps: 30, quality: "medium", showCursor: true }
})
# → { sessionId: "sess_02" }

# ...run the commands being demoed in that terminal...

stop_recording({ sessionId: "sess_02" })
```

### Record with narration

Narration is **not** a `start_recording` parameter — it's attached at
**stop time**, as `narration: { filePath, offsetMs }` on `stop_recording`.
Record first, produce/locate the narration audio file, then pass it when
stopping:

```
start_recording({ target: { targetId: "42" } })
# → { sessionId: "sess_03" }

# ...perform the demoed actions...

stop_recording({
  sessionId: "sess_03",
  narration: { filePath: "/Users/edicury/Downloads/narration.wav", offsetMs: 0 }
})
# → { outputPath, manifestPath, eventTimelinePath, manifest }
# manifest.narration will contain { filePath, offsetMs, trackIndex }
```

`offsetMs` is where the narration track starts relative to the start of the
recording — use `0` to start it immediately, or a positive value to delay it.

### Record a full display or a region

`list_targets({ kinds: ["display"] })` returns displays with `bounds` and
`isPrimary`. Pass the display's target directly to `start_recording` the same
way as a window. For a region, construct
`{ kind: "region", displayId: "<id>", bounds: { x, y, width, height } }` from
`list_targets`'s display output and pass that as `target`.

## Permissions — first run / missing grants

Before recording (or if a recording fails unexpectedly), call
`check_permissions`. It is read-only and never prompts the user.

- If `screenRecording`, `accessibility`, or `microphone` (only if you need
  mic audio) is not `"granted"`:
  - **Tell the user directly what's missing** and how to fix it — e.g.
    "Windower needs Screen Recording permission. Open System Settings >
    Privacy & Security > Screen Recording, enable it for [the granting app],
    then try again." Accessibility and Microphone follow the same System
    Settings > Privacy & Security path, different subsection.
  - You may call `request_permission({ kind })` **once**, when it makes sense
    to actually prompt the user right now (e.g. this is the first time in
    the conversation and the user has just asked you to record something).
    This call is user-interactive and blocking — it pops a real system
    dialog.
  - **Do not loop.** Do not repeatedly call `check_permissions` or
    `request_permission` hoping the status changes — it won't change until
    the human acts in System Settings. Ask once, explain clearly, then stop
    and wait for the user to confirm they've granted it before retrying the
    actual recording.
  - `daemonRunning: false` or `sidecarAvailable: false` in the report means
    the local Windower daemon/sidecar isn't up — surface that to the user
    too; it's not a permissions problem and retrying `request_permission`
    won't fix it.

## Mid-session status and recovery

- `get_session({ sessionId })` — check a specific session's state
  (`pending|recording|stopping|finalized|canceled|failed`) if you're unsure
  whether a recording is still running, or to recover details after losing
  track of a `sessionId` mid-conversation.
- `list_sessions({ state? })` — list all sessions, optionally filtered by
  state; use this if you've lost the `sessionId` entirely (e.g. context was
  compacted) and need to find the one you just started.
- `cancel_recording({ sessionId })` — use this instead of `stop_recording`
  when a take is botched (wrong window, action went wrong, etc.) and you
  want to discard it rather than finalize a broken video. It returns
  `{ canceled: true }` and does not produce an output file.

## Reporting results to the user

After `stop_recording`, never just say "done." Always report:

- The **output video path** (`outputPath`) — this is the deliverable.
- That a **manifest** was written (`manifestPath`) — the durable record of
  target/video/audio settings and file metadata.
- If present, that an **event timeline** was written (`eventTimelinePath`) —
  cursor/click events alongside the video, useful for later post-processing.

Example: "Recording saved to `~/Movies/Windower/2026-08-09-demo.mp4`. A
manifest (`manifest.json`) and click/cursor event timeline
(`....events.json`) were written alongside it."
