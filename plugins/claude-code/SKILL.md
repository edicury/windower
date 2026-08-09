---
name: windower
description: |
  Record a screen demo (window, display, or region) using the Windower MCP
  tools (list_targets, check_permissions, request_permission, resize_window,
  start_recording, get_session, stop_recording, cancel_recording,
  list_sessions). Use whenever the user asks to record, capture, screen-record,
  or make a video/demo/screencast of an app, browser, terminal, or workflow —
  including narrated demos. Triggers: "record a demo", "screen record",
  "capture this", "make a video of", "record yourself doing X", "narrate a
  recording".
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
