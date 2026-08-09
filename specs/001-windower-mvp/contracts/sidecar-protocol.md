# Sidecar Protocol Contract

Every native backend (`native/macos`, future `native/windows`, `native/linux`) implements this exact protocol. The daemon is written against this document, not against any specific OS's APIs.

## Transport

- Sidecar is spawned as a child process by the daemon.
- Requests/responses/notifications are **JSON-RPC 2.0**, one JSON object per line (newline-delimited), on the sidecar's stdin (daemon → sidecar) and stdout (sidecar → daemon).
- stderr is free-form human-readable logs only — never protocol data.
- The daemon owns the sidecar's lifecycle: one sidecar process per active `RecordingSession`, spawned on `startCapture`, terminated after `stopCapture`/`cancelCapture` completes.

## Handshake

On spawn, the daemon sends `describe` before anything else:

```jsonc
// → {"jsonrpc":"2.0","id":1,"method":"describe","params":{}}
// ← {"jsonrpc":"2.0","id":1,"result":{
//     "platform": "macos",
//     "version": "0.1.0",
//     "capabilities": [
//       "enumerate.displays", "enumerate.windows", "enumerate.apps",
//       "window-control", "capture.display", "capture.window", "capture.region",
//       "audio.system", "audio.system.perApp", "audio.microphone",
//       "cursor.visible", "eventTimeline.cursor", "eventTimeline.mouse", "eventTimeline.keyboard"
//     ]
//   }}
```

The daemon MUST check a capability is present before calling any method that depends on it, and MUST surface `UNSUPPORTED_CAPABILITY` up the stack (not crash) when a caller requests something the active backend can't do.

## Methods

| Method | Params | Result | Required capability |
|---|---|---|---|
| `describe` | `{}` | `{ platform, version, capabilities[] }` | always available |
| `enumerateTargets` | `{ kinds?: ("display"\|"window"\|"app")[] }` | `{ targets: CaptureTarget[] }` | `enumerate.*` |
| `getPermissions` | `{}` | `PermissionReport` (backend-relevant subset) | always available |
| `requestPermission` | `{ kind: "screenRecording"\|"accessibility"\|"microphone" }` | `{ status: PermissionStatus }` | always available |
| `resizeWindow` | `{ targetId: string, bounds: Rect }` | `{ actualBounds: Rect, result: "success"\|"partial"\|"unsupported" }` | `window-control` |
| `startCapture` | `{ sessionId, target: CaptureTarget, video: VideoSettings, audio: AudioSettings }` | `{ started: true }` (then streams `event` and `frameStats` notifications) | `capture.*` matching `target.kind` |
| `stopCapture` | `{ sessionId }` | `{ outputFilePath, actualDurationMs, actualResolution }` | — |
| `cancelCapture` | `{ sessionId }` | `{ canceled: true }` | — |

`CaptureTarget`, `VideoSettings`, `AudioSettings`, `Rect`, `PermissionStatus`/`PermissionReport` are exactly the shapes in `data-model.md` — this contract does not redefine them.

## Notifications (sidecar → daemon, no response expected)

- `event` — `{ sessionId, event: TimelineEvent }`, emitted during an active capture when `eventTimeline.*` capabilities are present. The daemon appends these to the session's `.events.json` as they arrive (streaming write, not buffered to end).
- `log` — `{ sessionId?, level: "debug"|"info"|"warn"|"error", message }` — structured alternative to raw stderr text, optional.
- `captureEnded` — `{ sessionId, reason: "target-closed"|"error" }` — sidecar-initiated stop (e.g., the target window was closed by the user mid-recording). The daemon transitions the session to `failed` with a descriptive error rather than leaving it hung in `recording`.

## Error taxonomy

All JSON-RPC errors use a `data.code` from this fixed set so callers can branch programmatically:

| Code | Meaning |
|---|---|
| `PERMISSION_DENIED` | Required OS permission not granted |
| `TARGET_NOT_FOUND` | `targetId` no longer exists (window closed, display disconnected) |
| `RESIZE_UNSUPPORTED` | Target does not support programmatic resize |
| `CAPTURE_FAILED` | Capture start/stream failed for a backend-specific reason (see `message`) |
| `UNSUPPORTED_CAPABILITY` | Caller invoked a method/option this backend doesn't advertise in `describe` |
| `SESSION_NOT_FOUND` | `sessionId` unknown to this sidecar process |
| `INTERNAL_ERROR` | Unexpected failure; `message` has detail, treat as a bug report |

## Cross-platform validation

See `research.md` §2 for the per-method capability matrix across macOS/Windows/Linux, produced *before* the macOS implementation (Phase 2+) started, to confirm the method list above doesn't need to change shape when Phase 16/17 land.
