# Sidecar Protocol Contract

Every native backend (`native/macos`, future `native/windows`, `native/linux`) implements this exact protocol. The daemon is written against this document, not against any specific OS's APIs.

## Transport

- Sidecar is spawned as a child process by the daemon.
- Requests/responses/notifications are **JSON-RPC 2.0**, one JSON object per line (newline-delimited), on the sidecar's stdin (daemon → sidecar) and stdout (sidecar → daemon).
- stderr is free-form human-readable logs only — never protocol data.
- The daemon owns the lifecycle of every sidecar process it spawns. For the **capture surface** (below) this means one capture process per active `RecordingSession`, spawned on `startCapture`, terminated after `stopCapture`/`cancelCapture` completes. The **control surface** has no session lifecycle of its own — the daemon may keep one long-lived control process or spawn one on demand.
- A client may hold connections to **more than one sidecar process at the same time for one logical session** (e.g. a capture connection and a control connection). Each connection is an independent JSON-RPC channel with its own `id` space; nothing correlates them except the `sessionId` the caller passes in params.
- Responses correlate to requests by JSON-RPC `id` alone. A caller MUST NOT assume requests are answered in the order they were sent, and a backend MAY service requests concurrently (e.g. handling a `stopCapture` while an earlier `captureFrame`/`enumerateTargets` call is still in flight or blocked on a slow OS completion handler) rather than strictly one-at-a-time. `packages/core/src/protocol/sidecar-client.ts`'s `SidecarClient` already implements the caller side this way (a `Map<id, PendingCall>`, no ordering assumption) — this line makes that existing behavior an explicit contract requirement rather than an implementation detail, so every backend (including future Windows/Linux ones) can rely on being allowed to answer out of order instead of serializing all RPC handling on one blockable thread. See `native/macos`'s `main.swift` for the reference implementation (`rpcQueue`, a concurrent `DispatchQueue` fed by the stdin read loop).

## Method-ownership surfaces

The method list is split into two **surfaces**, each a self-contained method-ownership group. A surface is a contract, not a process count — see "Topology is not part of the contract" below.

| Surface | Methods | macOS binary (Phase 21) |
|---|---|---|
| **Capture** | `describe`, `enumerateTargets`, `getPermissions`, `requestPermission`, `startCapture`, `stopCapture`, `cancelCapture`, `captureFrame` | `windower-capture-macos` |
| **Control** | `describe`, `getPermissions`, `requestPermission`, `performInput`, `resizeWindow` | `windower-control-macos` |

Why each method lands where it does:

- `enumerateTargets`, `startCapture`, `stopCapture`, `cancelCapture`, `captureFrame` all read screen content or screen-content metadata, so they belong to whatever owns the platform's screen-capture state. There are no separate audio methods to place — audio is configured entirely through `startCapture`'s `AudioSettings` param, so it follows `startCapture` onto the capture surface.
- `performInput` and `resizeWindow` write input events and window geometry. They read no screen content and share no OS resource with capture, so they are on the control surface.
- `describe` is on **both** surfaces. Each implementation reports only its own capabilities (see Handshake), never the other's.
- `getPermissions`/`requestPermission` are on **both** surfaces, and were already specified as returning the "backend-relevant subset" of `PermissionReport` — that wording now does real work. A capture implementation reports the capture-relevant kinds (`screenRecording`, `microphone`); a control implementation reports the ones its own methods need (`accessibility`). A daemon holding both connections merges the two reports; a daemon holding one gets a partial report and MUST treat absent kinds as unknown, not denied.

**Topology is not part of the contract.** The protocol does not require two binaries, two processes, or any particular process boundary — a backend may implement both surfaces in one process, split them across two, or use any other topology, as long as every method it advertises via `describe` behaves as specified here. The macOS two-binary split is a Phase 21 implementation decision driven by a macOS-specific resource constraint (see `research.md` §2); Windows and Linux backends (Phases 16/17) are explicitly free to choose differently.

**This grouping is not a breaking change.** No method's params or result shape changes as part of the split, with the single exception of the additive, optional `fresh` param on `captureFrame` documented below. Capability strings already work per-implementation via `describe` with zero new fields — the protocol never assumed one process implements every method, it just happened to be true until Phase 21.

## Handshake

On spawn, the daemon sends `describe` before anything else, on each connection it holds:

```jsonc
// → {"jsonrpc":"2.0","id":1,"method":"describe","params":{}}
// ← {"jsonrpc":"2.0","id":1,"result":{
//     "platform": "macos",
//     "version": "0.1.0",
//     "capabilities": [
//       "enumerate.displays", "enumerate.windows", "enumerate.apps",
//       "window-control", "capture.display", "capture.window", "capture.region",
//       "audio.system", "audio.system.perApp", "audio.microphone",
//       "cursor.visible", "eventTimeline.cursor", "eventTimeline.mouse", "eventTimeline.keyboard",
//       "input.mouse", "input.keyboard", "screenshot"
//     ]
//   }}
```

The example above is a single implementation that happens to advertise every capability. When the two surfaces are separate implementations, **each `describe` reports only the capabilities of the methods that implementation actually serves** — a capture implementation advertises `enumerate.*`/`capture.*`/`audio.*`/`cursor.*`/`eventTimeline.*`/`screenshot` and does not advertise `input.*`/`window-control`; a control implementation advertises `input.mouse`/`input.keyboard`/`window-control` and nothing else. A caller holding both connections takes the union; a caller holding one MUST NOT infer anything about capabilities it did not see.

The daemon MUST check a capability is present before calling any method that depends on it, and MUST surface `UNSUPPORTED_CAPABILITY` up the stack (not crash) when a caller requests something the active backend can't do — including when it routes a method to the surface that owns it and that surface doesn't advertise the capability.

## Methods — capture surface

| Method | Params | Result | Required capability |
|---|---|---|---|
| `describe` | `{}` | `{ platform, version, capabilities[] }` | always available |
| `enumerateTargets` | `{ kinds?: ("display"\|"window")[] }` | `{ targets: CaptureTarget[] }` | `enumerate.*` |
| `getPermissions` | `{}` | `PermissionReport` (backend-relevant subset) | always available |
| `requestPermission` | `{ kind: "screenRecording"\|"accessibility"\|"microphone" }` | `{ status: PermissionStatus }` | always available |
| `startCapture` | `{ sessionId, target: CaptureTarget, video: VideoSettings, audio: AudioSettings }` | `{ started: true }` (then streams `event` and `frameStats` notifications) | `capture.*` matching `target.kind` |
| `stopCapture` | `{ sessionId }` | `{ outputFilePath, actualDurationMs, actualResolution }` | — |
| `cancelCapture` | `{ sessionId }` | `{ canceled: true }` | — |
| `captureFrame` | `{ target: CaptureTarget, format: "png"\|"jpeg", maxWidth?: number, quality?: number, fresh?: boolean }` | `{ imageBase64, width, height, scale }` | `screenshot` |

## Methods — control surface

| Method | Params | Result | Required capability |
|---|---|---|---|
| `describe` | `{}` | `{ platform, version, capabilities[] }` | always available |
| `getPermissions` | `{}` | `PermissionReport` (backend-relevant subset) | always available |
| `requestPermission` | `{ kind: "screenRecording"\|"accessibility"\|"microphone" }` | `{ status: PermissionStatus }` | always available |
| `performInput` | `{ sessionId?, actions: InputAction[] }` | `{ performed: number }` | `input.mouse` / `input.keyboard` (per action `kind`) |
| `resizeWindow` | `{ targetId: string, bounds: Rect }` | `{ actualBounds: Rect, result: "success"\|"partial"\|"unsupported" }` | `window-control` |

`performInput`'s `sessionId` stays optional and stays a plain correlation hint: the control surface does not own sessions and MUST NOT reject a `sessionId` it doesn't recognize (only the capture surface, which does own sessions, returns `SESSION_NOT_FOUND`).

`CaptureTarget`, `VideoSettings`, `AudioSettings`, `Rect`, `PermissionStatus`/`PermissionReport` are exactly the shapes in `data-model.md` — this contract does not redefine them.

`performInput` takes an **array** of actions deliberately, not a single action per call — a click-then-type sequence (focus a field, then type into it) is one atomic round trip and one capability check, not N round trips each re-validating `input.mouse`/`input.keyboard`. `InputAction` is a discriminated union on `kind`: `mouse_move`, `mouse_down`, `mouse_up`, `mouse_click`, `mouse_drag`, `scroll`, `type_text`, `key_press`, `wait` — see `data-model.md` for the exact per-kind fields. Coordinates in every mouse-related action are **pixels, global top-left-origin Quartz space** — the same coordinate space `TimelineEvent` already uses, so a coordinate read from an event timeline or a `captureFrame` result can be fed straight into `performInput` with no conversion.

### Frame sharing (`captureFrame`, `fresh`)

`captureFrame` is specified as "a frame of this target", not "a screenshot taken at the instant of this call". That leaves one optimization explicitly open to backends:

> When the capture implementation already has a live capture stream covering the requested target, it **MAY** serve the most recently delivered frame from that stream instead of invoking a fresh single-shot screenshot capture.

This is opt-in behavior of the implementation, not of the caller, and it is observable only as:

- **(a) potentially lower latency** — the frame is already in hand, so no new OS capture round trip is needed;
- **(b) staleness bounded by the stream's own frame interval** — a served frame is at most one frame period old (e.g. ≤ ~33 ms at 30 fps). It is never arbitrarily old: if no stream is live, or the live stream's target does not cover the requested one, the implementation MUST fall back to a real capture.

`fresh?: boolean` (default `false`) lets a caller opt out. When `fresh: true`, the implementation MUST perform a real single-shot capture regardless of any active stream. Callers should leave it unset; it exists for the rare case that needs a guaranteed-at-this-instant frame and is willing to pay the latency (and, on backends with a contended capture resource, the extra contention) for it. The param is additive and optional — a backend that never shares frames satisfies the contract by ignoring it, since its behavior is already `fresh: true` in effect.

### Platform notes: input synthesis

- `CGEventPost` (the macOS mechanism behind `performInput`) requires the same Accessibility TCC grant the sidecar already requests and reports via `getPermissions`/`requestPermission` (`Permissions.swift`'s `accessibilityStatus()`) — there is no new permission kind to add and no `PermissionReport` schema change.
- macOS secure event input blocks event **taps** from reading keystrokes, not `CGEventPost` from **writing** them — typing into a password field or other secure-input context works normally but is invisible to the event timeline. This is the same `keystrokes: false`-style degradation already documented for Phase 10's `eventTimeline.keyboard` capability; the operator (Phase 19) must treat this as an expected capability gap, not a failure.

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
| `INPUT_UNSUPPORTED` | Caller requested an `InputAction.kind` this backend cannot synthesize |
| `INPUT_OUT_OF_BOUNDS` | A mouse coordinate in `performInput` falls outside any known display's bounds |

## Cross-platform validation

See `research.md` §2 for the per-method capability matrix across macOS/Windows/Linux, produced *before* the macOS implementation (Phase 2+) started, to confirm the method list above doesn't need to change shape when Phase 16/17 land.
