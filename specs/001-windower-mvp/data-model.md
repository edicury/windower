# Data Model

All types are defined once as Zod schemas in `packages/core` and reused for: daemon RPC payloads, CLI `--json` output, MCP tool input/output schemas, and `manifest.json` / event-timeline files on disk. No type is redefined per-interface.

## CaptureTarget

Identifies what will be recorded. Returned by `enumerateTargets`, passed to `startCapture`.

```ts
type CaptureTarget =
  | { kind: "display"; id: string; name: string; bounds: Rect; isPrimary: boolean; scaleFactor: number }
  | { kind: "window"; id: string; title: string; appName: string; appBundleId: string; bounds: Rect; isFocused: boolean; resizable: boolean }
  | { kind: "region"; displayId: string; bounds: Rect }

type Rect = { x: number; y: number; width: number; height: number } // pixels, global coordinate space
```

- `window.id` and `display.id` are sidecar-stable identifiers (macOS: `CGWindowID` / `CGDirectDisplayID` stringified), stable for the life of the window/display but not guaranteed across relaunch — callers re-enumerate rather than caching IDs long-term.
- `region` has no independent ID; it's always specified relative to a `displayId`.

## VideoSettings

```ts
type VideoSettings = {
  fps: 24 | 30 | 60;                     // default 30
  codec: "h264" | "hevc";                // default h264
  container: "mp4" | "mov";              // default mp4
  resolution?: { width: number; height: number }; // omit = native target resolution
  quality: "low" | "medium" | "high" | "lossless_ish"; // maps to bitrate presets internally
  showCursor: boolean;                   // default true
}
```

## AudioSettings

```ts
type AudioTrackConfig =
  | { source: "system"; enabled: boolean }
  | { source: "microphone"; enabled: boolean; deviceId?: string }
  | { source: "narration"; filePath: string; offsetMs: number } // supplied at stop-time, see Session.narration

type AudioSettings = {
  tracks: AudioTrackConfig[];
  separateTracks: boolean; // true = mux as distinct tracks; false = mixed to one
}
```

Narration is modeled as an audio track kind so a future "more track types" addition (e.g. a second mic) doesn't require a shape change — see `plan.md` §8.

## RecordingSession

The daemon's live/persisted session record.

```ts
type SessionState = "pending" | "recording" | "stopping" | "finalized" | "canceled" | "failed";

type RecordingSession = {
  id: string;                  // uuid
  state: SessionState;
  target: CaptureTarget;
  video: VideoSettings;
  audio: AudioSettings;
  startedAt: string;           // ISO 8601
  stoppedAt?: string;
  error?: { code: string; message: string }; // present when state === "failed"
  outputPath?: string;         // present once finalized
  manifestPath?: string;       // present once finalized
  eventTimelinePath?: string;  // present once finalized
}
```

Persisted at `~/.windower/sessions/<id>.json`, updated on every state transition — this is what makes `windower status <id>` and crash recovery work without the daemon holding all state only in memory.

## OutputManifest (`manifest.json`, written next to the video file)

```ts
type OutputManifest = {
  windowerVersion: string;
  sessionId: string;
  target: CaptureTarget;                // snapshot at record time
  video: VideoSettings & { actualResolution: { width: number; height: number }; durationMs: number };
  audio: { tracks: Array<{ source: string; trackIndex: number }> };
  narration?: { filePath: string; offsetMs: number; trackIndex: number };
  eventTimelinePath?: string;           // relative path to the .events.json file
  operatorRunPath?: string;             // relative path to the OperatorRun record, when this recording was operator-driven
  createdAt: string;
  file: { path: string; sizeBytes: number; codec: string; container: string };
}
```

## EventTimeline (`<recording>.events.json`)

Phase 10 output — cursor/click capture only in MVP; consumed by Phase 15's post-processor for zoom/ripple rendering, and available to any agent that wants to reason about "what happened when."

```ts
type TimelineEvent =
  | { t: number; type: "cursor_move"; x: number; y: number; source?: "human" | "operator" }         // t = ms since recording start
  | { t: number; type: "mouse_down" | "mouse_up"; x: number; y: number; button: "left" | "right" | "other"; source?: "human" | "operator" }
  | { t: number; type: "key_down" | "key_up"; key: string; source?: "human" | "operator" }          // best-effort, capability-gated (see research.md §2)

type EventTimeline = {
  sessionId: string;
  events: TimelineEvent[];
  capabilities: { keystrokes: boolean }; // false on backends where key capture isn't available
}
```

Cursor-move sampling rate is capped (default 30Hz) to bound file size on long recordings — configurable in Phase 10's task file, not part of the public API surface in MVP.

## OperatorRun (Phase 19, `~/.windower/operator-runs/<id>.json`)

The daemon's live/persisted record of a guided operator run — deliberately parallel to `RecordingSession` so `OperatorRunManager` can reuse `SessionManager`'s persist-on-every-transition pattern.

```ts
type OperatorRunState = "pending" | "running" | "succeeded" | "failed" | "aborted" | "timed_out";

type OperatorRun = {
  id: string;                  // uuid
  state: OperatorRunState;
  task: string;                // the natural-language instruction
  model: ModelConfig;
  sessionId?: string;          // present when recording was not disabled — the RecordingSession this run drives
  steps: OperatorStep[];
  startedAt: string;           // ISO 8601
  endedAt?: string;
  error?: { code: string; message: string };
  transcriptPath?: string;     // full reasoning/tool-call transcript, written next to the recording if any
}
```

State machine: `pending → running → succeeded | failed | aborted | timed_out` — deliberately parallel to `SessionState` above.

## OperatorStep

One perceive/decide/act cycle within an `OperatorRun`.

```ts
type OperatorStep = {
  index: number;
  observationRef: string;      // reference to the captured frame (e.g. a path or in-memory handle) this step reasoned over
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }>;
  reasoning?: string;          // model's stated rationale, when the provider exposes one
  tMs: number;                 // ms since run start
}
```

## InputAction

Discriminated union on `kind`, passed as an array to `performInput` (see `contracts/sidecar-protocol.md`). Coordinates are pixels, global top-left-origin Quartz space — the same space `TimelineEvent` uses.

```ts
type InputAction =
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_down"; x: number; y: number; button: "left" | "right" | "other" }
  | { kind: "mouse_up"; x: number; y: number; button: "left" | "right" | "other" }
  | { kind: "mouse_click"; x: number; y: number; button: "left" | "right" | "other"; clickCount?: number }
  | { kind: "mouse_drag"; fromX: number; fromY: number; toX: number; toY: number; button: "left" | "right" | "other"; durationMs?: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "type_text"; text: string }
  | { kind: "key_press"; key: string; modifiers?: ("cmd" | "shift" | "ctrl" | "alt")[] }
  | { kind: "wait"; durationMs: number }
```

## SecretRef

A reference to a credential, never the credential's value — resolved at call time inside `packages/operator`, never persisted or logged.

```ts
type SecretRef = {
  name: string;             // placeholder name substituted into `task`, e.g. "password" for "{{password}}"
  source: "env" | "keychain" | "literal";
  ref: string;               // env var name, keychain item name, or (discouraged) the literal value itself
}
```

## ModelConfig

Selects the LLM the operator's own reasoning loop uses, independent of whatever model is driving the calling agent/harness.

```ts
type ModelConfig = {
  provider: string;          // e.g. "openai" | "anthropic" | "openai-compatible" | ...
  model: string;              // provider-specific model id
  baseUrl?: string;           // override, e.g. a local Ollama/LM Studio server for "openai-compatible"
  apiKeyEnvVar?: string;      // env var to read the API key from; never the key itself
}
```

## Permission state (`doctor` / `check_permissions`)

```ts
type PermissionStatus = "granted" | "denied" | "not_determined" | "not_applicable";

type PermissionReport = {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
  microphone: PermissionStatus;
  daemonRunning: boolean;
  sidecarAvailable: boolean;
  sidecarVersion?: string;
}
```

## WindowerConfig (`~/.windower/config.json`)

Backs `windower config get|set` (`packages/core/src/schemas/config.ts`'s `WindowerConfigSchema`). All fields optional; missing/partial config is synthesized against documented defaults.

```ts
type WindowerConfig = {
  outputDir?: string;                          // default ~/Movies/Windower
  filenameTemplate?: string;                   // default "{target}-{timestamp}"
  daemonIdleTimeoutMs?: number;                 // default 30min
  defaultVideo?: Partial<VideoSettings>;
  defaultAudio?: Partial<AudioSettings>;
  operator?: {                                  // Phase 19
    defaultModel?: ModelConfig;
    apiKeyEnvVar?: string;
    baseUrl?: string;
    guardrailDefaults?: { maxSteps?: number; timeoutSeconds?: number; unbounded?: boolean };
  };
}
```
