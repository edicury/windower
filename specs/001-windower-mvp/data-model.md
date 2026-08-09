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
  owner?: { pid: number; startedAt: string }; // Phase 20 — process that created/owns this session
}
```

Persisted at `~/.windower/sessions/<id>.json`, updated on every state transition — this is what makes `windower status <id>` and crash recovery work without the daemon holding all state only in memory.

- `owner` (Phase 20, optional so 0.1.x session files without it still parse): identifies the process that created the session, so a process only mutates (transitions/finalizes) sessions it owns or whose owner pid is confirmed dead. This is what makes the `attach`-mode local `stop`/`cancel` fallback safe — if nothing is listening on the socket at `stop` time, the CLI checks `owner.pid` liveness itself before marking the session `failed`/`canceled` locally, instead of spawning a fresh daemon that would just answer `SESSION_NOT_FOUND`. `startedAt` here is the owner process's start time (not the session's), used to disambiguate a dead pid from a live unrelated process that happens to have been assigned the same pid after reuse.

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
  | { t: number; type: "cursor_move"; x: number; y: number; source?: "user" | "operator" }         // t = ms since recording start
  | { t: number; type: "mouse_down" | "mouse_up"; x: number; y: number; button: "left" | "right" | "other"; source?: "user" | "operator" }
  | { t: number; type: "key_down" | "key_up"; key: string; source?: "user" | "operator" }          // best-effort, capability-gated (see research.md §2)

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

  // Phase 20 additions — all optional so an older client parsing a response
  // written by a pre-Phase-20 daemon (or vice versa) still succeeds. A field
  // being absent means "reporter predates this field," not "false"/"unknown."
  daemon?: {
    running: boolean;
    pid?: number;
    version?: string;
    protocolVersion?: number;
    startedAt?: string;              // ISO 8601, from daemon.json
    ageSeconds?: number;              // derived: now - startedAt, computed by the reporter
    socketPath?: string;
    versionMatchesClient?: boolean;   // daemon.version === client.version
  };
  client?: {
    name: string;                     // e.g. "windower-cli" | "windower-mcp-server"
    version: string;
    protocolVersion: number;
  };
  sidecar?: {
    available: boolean;
    version?: string;
    resolvedPath?: string;
    source?: "env-override" | "dev-build" | "npm-package";
    expectedVersion?: string;
  };
  windowerHome?: {
    path: string;
    fromEnvOverride: boolean;         // true if WINDOWER_HOME was set, false if defaulted
  };
  outputDir?: {
    path: string;
    writable: boolean;
  };
  activeSessions?: number;
  activeRuns?: number;

  // API-key env var presence only — booleans, never values. A row reading
  // "present in CLI: yes / present in daemon: no" is the one-line
  // self-diagnosis of the frozen-daemon-env bug that motivated Phase 20.
  apiKeyEnvVars?: Array<{
    name: string;                     // e.g. "ANTHROPIC_API_KEY", or the configured apiKeyEnvVar
    presentInClient: boolean;
    presentInDaemon: boolean;         // false/omitted-effectively-false when no daemon is running
  }>;
}
```

**Where `apiKeyEnvVars` lives:** modeled on `PermissionReport` itself, not a separate `DoctorReport` type. `packages/core/src/schemas/permissions.ts` defines exactly one report schema (`PermissionReportSchema`), consumed by both `windower doctor` and the `check_permissions` MCP tool (`GetPermissionsResultSchema = PermissionReportSchema.partial()` in `packages/core/src/protocol/methods.ts` — the sidecar's own permission response is a partial view over the same shape). Introducing a sibling `DoctorReport` type would fork that single-schema convention for a feature (env-var-presence diffing) that is just more permission/environment diagnostics, and `doctor`'s job in this codebase has always been "render `PermissionReport` plus daemon reachability" — see `contracts/cli.md`'s existing `doctor` section. Every new field above is optional for the same reason the existing ones already vary by reporter (`sidecarVersion` is only known once a sidecar has responded): different callers (sidecar `GetPermissionsResultSchema`, CLI-local `doctor`, daemon-backed `check_permissions`) populate different subsets of the same object, so exhaustiveness was never assumed even pre-Phase-20.

## Daemon state file (`~/.windower/daemon.json`)

Written by the daemon on successful `listen()`, unlinked on graceful shutdown. Lets `doctor` and stale-socket detection (`ensureDaemonRunning`) learn daemon identity and check pid liveness without connecting to the socket — see `specs/001-windower-mvp/tasks/phase-20-daemon-optional.md`.

```ts
type DaemonStateFile = {
  pid: number;
  version: string;                    // from packageVersion(), not a hardcoded constant
  protocolVersion: number;            // DAEMON_PROTOCOL_VERSION at listen time
  startedAt: string;                  // ISO 8601
  socketPath: string;
  windowerHome: string;               // resolved WINDOWER_HOME the daemon is operating against
  execPath: string;                   // process.execPath — for diagnosing which node ran the daemon
  entryPath: string;                  // resolved path of the daemon's entry module
}
```

## DaemonHello / DaemonInfo (`hello` / `daemon_info` RPC payloads)

The version-handshake payloads exchanged when a client connects to the daemon socket, per `contracts/daemon-rpc.md`. Defined here — not only in the contract — per this repo's convention that Zod shapes are the source of truth in `data-model.md` even when the RPC method semantics (request/response framing, error codes) live in `contracts/*.md` (see `OperatorRun` above, whose method-level docs live in `contracts/mcp-tools.md` / `contracts/cli.md` but whose shape is defined here).

```ts
// Client -> daemon, first call on every new connection.
type DaemonHelloRequest = {
  clientName: string;                 // e.g. "windower-cli" | "windower-mcp-server"
  clientVersion: string;
  protocolVersion: number;            // client's DAEMON_PROTOCOL_VERSION
  windowerHome: string;                // resolved WINDOWER_HOME, compared against the daemon's — mismatch is an error
  env?: {                              // scoped env snapshot, never process.env wholesale — see "Settled decisions" in phase-20-daemon-optional.md
    apiKeyEnvVar?: string;             // name of the model API key var, e.g. "ANTHROPIC_API_KEY"
    apiKeyValue?: string;              // the value itself — only ever sent for detached operate runs; never logged, never persisted
    secretRefs?: Array<{ name: string; value: string }>; // resolved `env:`-sourced SecretRefs named in this request only
  };
}

// Daemon -> client, response to `hello`; also the shape of `daemon_info` (a
// no-op probe callable without a full hello, used by `doctor` to report
// daemon identity without mutating connection state).
type DaemonInfo = {
  pid: number;
  version: string;
  protocolVersion: number;
  startedAt: string;                  // ISO 8601
  windowerHome: string;
}
```

`DaemonHelloRequest.env` is the one place a secret value is allowed to cross the socket, and only because the socket is already `0600`, same-UID-only, unauthenticated by design (see phase-20 "Settled decisions"). Blocking `operate` (the default) never populates it; only `operate --detach` and MCP's `run_operator` do.

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
