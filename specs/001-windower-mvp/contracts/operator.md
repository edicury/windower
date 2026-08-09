# Operator Contract

`packages/operator` (Phase 19, v1.2). The operator is a bounded, tool-using agent loop that turns one natural-language instruction into a sequence of `performInput`/`captureFrame` sidecar calls, optionally wrapped in a recording session. It adds no capability the sidecar protocol doesn't already express — every tool below maps 1:1 onto an existing daemon or sidecar method.

## Tool surface exposed to the model

The model only ever sees this closed set of tools. No shell, filesystem, or raw network tool is ever offered, regardless of provider or config.

| Tool | Params | Maps to |
|---|---|---|
| `screenshot` | `{ maxWidth?: number }` | sidecar `captureFrame` |
| `move_mouse` | `{ x: number, y: number }` | sidecar `performInput` (`mouse_move`) |
| `click` | `{ x: number, y: number, button?: "left"\|"right"\|"other" }` | sidecar `performInput` (`mouse_click`) |
| `double_click` | `{ x: number, y: number }` | sidecar `performInput` (two `mouse_click` actions) |
| `drag` | `{ fromX: number, fromY: number, toX: number, toY: number }` | sidecar `performInput` (`mouse_drag`) |
| `scroll` | `{ x: number, y: number, deltaX: number, deltaY: number }` | sidecar `performInput` (`scroll`) |
| `type_text` | `{ text: string }` — may contain `{{name}}` secret-ref placeholders | sidecar `performInput` (`type_text`), after secret substitution |
| `press_key` | `{ key: string, modifiers?: string[] }` | sidecar `performInput` (`key_press`) |
| `wait` | `{ ms: number }` | local sleep, no RPC (bounded by guardrails, see below) |
| `list_targets` | `{ kinds?: ("display"\|"window"\|"app")[] }` | sidecar `enumerateTargets` (via daemon) |
| `resize_window` | `{ targetId: string, bounds: Rect }` | sidecar `resizeWindow` (via daemon) |
| `done` | `{ summary: string }` | ends the run, no RPC — `OperatorRun.state` → `"succeeded"` |
| `fail` | `{ reason: string }` | ends the run, no RPC — `OperatorRun.state` → `"failed"` |

There is no tool that spawns a process, reads/writes the filesystem, or makes an HTTP request. The model cannot escape the tool surface above; anything the operator does to the machine happens through `performInput`/`captureFrame`/`enumerateTargets`/`resizeWindow` — the same four sidecar-facing methods every other Windower interface (CLI, MCP, plugin) already uses.

## Model configuration

`--model <provider>:<model>`, e.g.:

- `anthropic:claude-sonnet-5`
- `openai:gpt-5`
- `openai-compatible:llama-3.3` with `--base-url <url>` for local/self-hosted endpoints (e.g. Ollama, LM Studio)

Provider selection is a thin dispatch over the Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/openai-compatible`) — swapping the config string swaps the model with zero code change in `packages/operator`.

API keys are resolved from an environment variable named per-provider in config (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), **never** accepted as a CLI flag — a key typed on the command line ends up in shell history and process listings, which this contract explicitly avoids.

Defaults (provider, model, base URL, guardrail values) live in a new `operator` block of `WindowerConfig` (`~/.windower/config.json`), read/written via the existing `windower config get|set` command — no separate config file.

## Secret refs

`--secret <name>=<source>:<ref>`, repeatable. `source` is one of:

- `env` — `<ref>` is an environment variable name, resolved from the daemon's environment.
- `keychain` — `<ref>` is a macOS Keychain item name (post-MVP backends resolve their own OS credential store equivalents).
- `literal` — `<ref>` is the value itself, inline on the command line. Discouraged; using `literal` logs a warning (shell history exposure) but is not blocked, for quick local testing.

**Substitution boundary** (load-bearing, applies everywhere a secret can flow):

1. The model's prompt and every tool-call argument it produces only ever contain the placeholder token `{{name}}` — the real value is never included in anything sent to or returned from the model.
2. Real-value substitution happens exactly once, inside the `type_text` tool handler, immediately before the `performInput` RPC call is made — the substituted value exists in process memory only as long as it takes to issue that one RPC call.
3. A redaction filter runs over the operator transcript, per-step records, daemon logs, and sidecar logs before any of them are persisted to disk — every known secret value is replaced with `{{name}}` (or a fixed redaction marker if the name itself is unknown at filter time) wherever it would otherwise appear.

## Guardrails

All guardrails are enforced by the `packages/operator` runtime, not requested via the model's system prompt — the model is never trusted to self-limit.

| Guardrail | Default | Override |
|---|---|---|
| `maxSteps` | 40 | `--max-steps <n>` |
| `timeoutMs` (wall-clock) | 300000 (5 min) | `--timeout <s>` |
| Target-bounds clamp | every coordinate in every input tool call is clamped to the recorded target's `Rect` | `--unbounded` disables clamping |
| Kill switch | `windower operate abort <runId>` (CLI) / `abort_operator_run` (daemon RPC / MCP) | — |
| Tool surface | fixed at the table above — no filesystem, process-spawn, or network tool is ever offered to the model, in any configuration | not overridable |

Exceeding `maxSteps` or `timeoutMs`, or an out-of-bounds coordinate under a non-`--unbounded` run, ends the run with `state: "failed"` and a structured error (`INPUT_OUT_OF_BOUNDS` for the bounds case), the same error taxonomy used by the sidecar protocol.

## Transcript format

Written to `<recording>.operator.json`, next to the video file — matching the existing repo convention that manifest/timeline files are durable records living beside the video, not in a separate DB. Reachable via a new optional `OutputManifest.operatorRunPath` field pointing at this file when a recording was operator-driven.

```ts
type OperatorRun = {
  runId: string;
  task: string;                    // the natural-language instruction
  model: string;                   // "provider:model" as configured
  steps: OperatorStep[];
  state: "running" | "succeeded" | "failed" | "aborted";
  startedAt: string;                // ISO 8601
  endedAt?: string;
  error?: { code: string; message: string };
};

type OperatorStep = {
  index: number;
  observation: { screenshotRef: string; hash: string }; // ref to a stored frame, not inlined
  reasoning?: string;               // model's stated rationale for this step, if the provider exposes it
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>; // secrets already redacted to {{name}}
  tMs: number;                      // ms since run start
};
```

`observation.screenshotRef` points at a frame captured via `captureFrame`, stored alongside the transcript rather than inlined as base64 — keeps `<recording>.operator.json` small and diffable. `toolCalls[].args` reflects exactly what the model saw and sent, i.e. secret placeholders (`{{name}}`), never resolved values — this is the same document the redaction filter (see "Secret refs" above) has already run over before it's written.
