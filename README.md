<div align="center">

# Windower

**Your agent records the demo.**

AI-native screen recorder: a TypeScript orchestration layer (CLI, MCP server, Claude Code plugin, and an on-demand daemon) drives a native macOS Swift sidecar over a JSON-RPC stdio protocol — so an agent can start/stop recordings, control windows, and get a structured event timeline without ever branching on platform.

[![CI](https://github.com/edicury/windower/actions/workflows/ci.yml/badge.svg)](https://github.com/edicury/windower/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)
![Status](https://img.shields.io/badge/status-MVP%20in%20progress-orange)

</div>

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
  - [The two-call recording pattern](#the-two-call-recording-pattern)
  - [Where a daemon does show up](#where-a-daemon-does-show-up)
  - [The operator (`windower operate`)](#the-operator-windower-operate)
- [Platform support](#platform-support)
- [Building from source](#building-from-source-development)
- [Environment variables](#environment-variables)
- [Documentation](#documentation)

## Features

- **Agent-native** — every capability is an MCP tool (9 currently: `list_targets`, `check_permissions`, `request_permission`, `resize_window`, `start_recording`, `stop_recording`, `cancel_recording`, `get_session`, `list_sessions`), written to be called directly by a model, plus an equivalent CLI and Claude Code plugin.
- **Deterministic capture** — windows are resized/repositioned to exact pixel bounds before a single frame is captured, so recordings are reproducible instead of "whatever was on screen."
- **Structured timeline, not just video** — window changes and session lifecycle land as a JSON event timeline (`<recording>.events.json`) next to the video, giving future editing something precise to work from rather than raw pixels.
- **Real output management** — templated filenames, collision-safe suffixing, an unwritable-output-directory check that fails at `start` rather than `stop`, and a schema'd `manifest.json` beside every recording.
- **Optional LLM-guided operator** — `windower operate` can drive the screen itself (perceive, synthesize input, complete a task) via a user-configured model endpoint, independent of whether anything is being recorded.
- **Protocol-first, multi-OS by design** — every method above the sidecar boundary is OS-agnostic JSON-RPC; the only platform-specific code lives in the native sidecar (Swift on macOS today, Windows/Linux sidecars post-MVP against the same protocol).

Interaction-aware post-processing — zooms, ripples, trims, narration rendering, gif/webm export — is a **planned v1.1 milestone**, not yet implemented. What ships today is the raw material for it: a precise, capture-free event timeline recorded alongside every session.

## Quick start

`windower record` is the zero-setup path: it runs entirely in the invoking process — no background daemon to start, stop, or reason about.

```bash
npx windower record --duration 10
```

This records 10 seconds of the primary display to your default output folder (`~/Movies/Windower`) and writes `manifest.json` and an `.events.json` timeline alongside the video. Nothing is left running afterward.

`windower targets` lists what's available to record (windows/displays/apps) before you start. `windower doctor` is a read-only, no-daemon health check — run it first if anything looks wrong; it never triggers a permission prompt.

First run will trigger macOS TCC prompts (Screen Recording, Accessibility, Microphone) — grant them via `windower permission request <capability>` or by letting the OS prompt fire, then re-run.

### The two-call recording pattern

For the primary agent-facing flow — start now, perform the actions being demoed, stop when done — use the two-call form instead of `record`. This is the single most important semantic in Windower: `start` returns a `sessionId` immediately and does not block, so the calling agent performs the actions being demoed *between* the two calls.

```bash
windower start --target <id>        # → { sessionId }, returns immediately
# ...perform the on-screen actions being demoed...
windower stop <sessionId>           # finalizes: video + manifest + event timeline
```

A blocking `windower record --duration <n>` exists too, but it's sugar over the same primitive, not the primary flow.

### Where a daemon *does* show up

Two flows genuinely need a process that outlives the CLI invocation, and only these auto-start a background daemon (unix socket at `~/.windower/daemon.sock`) as an implementation detail:

- **`windower start` / `stop` / `cancel`** (the two-call recording pattern above) — `start` needs something to own the in-progress capture between the two calls, so it spawns a daemon if none is listening; `stop`/`cancel` attach to it.
- **`windower operate --detach`** and **`operate abort`** — the non-blocking form of the operator (see below).

Every other command (`record`, `targets`, `doctor`, `permission request`, `resize`, `status`, `list`, `config`, and blocking `operate`) runs entirely in the invoking process and never starts or requires a daemon. If you do end up with one running — say, from a `start`/`stop` session — `windower daemon status` reports on it and `windower daemon stop` shuts it down cleanly (finalizing any in-flight recording first; `--discard` cancels instead). A hard `windower daemon kill` force-kills the daemon and any sidecar processes it owns by pid, bypassing the socket, for a hung/unreachable daemon. You should rarely need to touch these directly. Full command-by-command routing lives in `specs/001-windower-mvp/contracts/cli.md`'s "Daemon policy" section.

### The operator (`windower operate`)

`windower operate "<task>" --target <id>` drives an LLM-guided run — perceive the screen, synthesize input, complete the task. It **records nothing**: recording and operating are independent capabilities, and the caller sequences them. It **blocks by default**: it runs in the invoking process, streams step progress to stderr, and prints the final result when done, so it works with zero daemon setup just like `record`. Pass `--detach` to get the non-blocking behavior (`{ runId }` immediately, poll with `operate status`) if you want to kick off a long run from a terminal and walk away.

```bash
windower operate "Open waroom.co, log in as {{user}}/{{password}}, create an incident" \
  --target <id> --secret password=keychain:waroom --json
```

Want a video of it? Wrap the run in the ordinary two-call recording pattern — three independent commands you control, passing the same target to both:

```bash
SESSION=$(windower start --target <id> --resolution 1920x1080 --out ~/Desktop --json | jq -r .sessionId)
windower operate "Open waroom.co and create an incident" --target <id> --json
windower stop "$SESSION" --json
```

The run never starts, stops, or touches that recording — aborting or failing a run leaves it recording until you stop it. The run's own artifact is its transcript at `~/.windower/operator-runs/<runId>/transcript.json`; the video and `manifest.json` come from `start`/`stop`.

## Platform support

macOS (Apple Silicon, M1+) only for now. Windows and Linux sidecars are post-MVP (`native/windows/`, `native/linux/`) — same JSON-RPC protocol, no changes required above the sidecar boundary.

## Building from source (development)

Requires macOS, Xcode command-line tools (for Swift/SPM), Node 20+, pnpm 9.

```bash
# 1. Install TS deps
pnpm install

# 2. Build the native macOS sidecar (debug build)
cd native/macos
swift build
cd ../..

# 3. Build the TS packages (core, cli, daemon, ...)
pnpm build

# 4. Put `windower` on PATH — either:
pnpm link --global -C packages/cli    # requires `pnpm setup` once, if no global bin dir yet
# or, simpler, alias it in your shell rc:
echo "alias windower='node $(pwd)/packages/cli/dist/index.js'" >> ~/.zshrc && source ~/.zshrc
```

`swift build` produces **two** binaries from the one Swift Package: `windower-capture-macos` (ScreenCaptureKit + AVFoundation — the only process allowed to touch ScreenCaptureKit) and `windower-control-macos` (CGEvent/Accessibility input and window control, which cannot link ScreenCaptureKit even transitively). `windower` resolves both at `native/macos/.build/debug/<name>` automatically (dev-build convention — see `packages/core/src/process/sidecar-path.ts`). Override either with `WINDOWER_SIDECAR_BINARY_PATH=<path>` / `WINDOWER_CONTROL_BINARY_PATH=<path>` if you built elsewhere.

### Extra setup for the operator (`windower operate`)

Recording needs nothing beyond the steps above. The operator (`packages/operator`) additionally pulls in an AI SDK provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@ai-sdk/openai-compatible`) via `pnpm install`, and needs a model to talk to:

- **Hosted providers** read their API key from the environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or whatever `ModelConfig.apiKeyEnvVar` names. A key is **never** accepted as a CLI flag (shell history / process listing exposure), so export it in your shell rc before running `windower operate`. Because blocking `operate` (the default) runs in the invoking CLI process itself, it always reads the key from *that* shell — there's no separate daemon environment to get out of sync with it.
- **Local / self-hosted models** need no key at all: `--model openai-compatible:<model> --base-url http://localhost:11434/v1` (Ollama, LM Studio, vLLM, …).

This is the one place Windower talks to the network, and only when you invoke the operator — see `specs/001-windower-mvp/spec.md` §7 for the scoped exception to the otherwise local-only design.

## Environment variables

All of these are optional; Windower runs with sensible defaults if none are set. "Surface" says which process(es) read the variable.

| Variable | Default | Surface | What it does |
|---|---|---|---|
| `WINDOWER_HOME` | `~/.windower` | CLI, daemon, MCP server | Overrides the root state directory — sessions (`sessions/`), operator runs, `config.json`, `daemon.sock`, `daemon.json`, lockfiles. Mainly for tests/CI so nothing touches a real home directory; a CLI and daemon that resolve this independently and disagree fail loudly at the `hello` handshake (`DAEMON_VERSION_MISMATCH`, naming both paths) rather than silently splitting state. |
| `WINDOWER_SIDECAR_BINARY_PATH` | unset (auto-resolved) | CLI, daemon, MCP server (anything that spawns the capture sidecar) | Pins the exact **capture**-surface binary (`windower-capture-macos`) to spawn, skipping auto-resolution. Keeps its pre-split name — it always pointed at the capture surface. Without it, resolution tries the dev-build path under `native/<os>/.build/debug/` (inside a monorepo checkout), then falls back to the platform-specific `@windower/sidecar-<os>-<arch>` npm package. `windower doctor`'s `sidecar.source` reports which strategy actually resolved (`env-override` / `dev-build` / `npm-package`). See `packages/core/src/process/sidecar-path.ts`. |
| `WINDOWER_CONTROL_BINARY_PATH` | unset (auto-resolved) | CLI, daemon, MCP server (anything that spawns the control sidecar) | The same override for the **control**-surface binary (`windower-control-macos`, which backs `performInput`/`resizeWindow` and never touches ScreenCaptureKit). A separate variable rather than a shared one, since one path can't name two binaries; same resolution order. A platform that implements both surfaces in one binary simply points both variables at it — the two-binary split is macOS's answer to the single-ScreenCaptureKit-writer invariant, not a protocol requirement. |
| `WINDOWER_DAEMON_BIN_PATH` | unset (auto-resolved) | CLI, MCP server (whichever process spawns the daemon) | Pins the exact daemon entrypoint (`node <path>`) that `ensureDaemonRunning` spawns, mirroring `WINDOWER_SIDECAR_BINARY_PATH`'s resolution order (env override → dev-build path → published `@windower/daemon` package). Useful for testing a version-mismatch auto-restart against a real older build. See `packages/core/src/daemon/connect.ts`. |
| `WINDOWER_BACKEND` | unset | CLI only | `local` or `daemon` — debugging escape hatch that overrides the normal command → backend-mode routing (see the "Daemon policy" table in `specs/001-windower-mvp/contracts/cli.md`). Forces an otherwise-`local` command through the daemon, or vice versa. Equivalent to the `--daemon`/`--no-daemon` CLI flags, which take precedence over this variable when both are given. Has no effect on `attach`-mode commands (`stop`, `cancel`, `daemon status`/`stop`/`restart`) — attaching only to an already-listening daemon is inherent to their correctness and isn't overridable. |
| `WINDOWER_OPERATOR_DEBUG` | unset | `packages/operator` (used by both blocking `operate` in-process and the daemon-backed detached path) | When set (any truthy value), the operator's redacted logger writes its log lines to stderr instead of discarding them. Every line still passes through the same redaction filter as the transcript, so secrets are never printed even with this on — it only controls whether the (already-redacted) lines are emitted at all. |
| `ANTHROPIC_API_KEY` | unset | `packages/operator`, read by whichever process runs the operator (the CLI itself for blocking `operate`, the daemon for `--detach`/MCP's `run_operator`) | API key for the `anthropic` provider. Used when `--model anthropic:...` (or the configured default) is selected and no `apiKeyEnvVar` override names a different variable. |
| `OPENAI_API_KEY` | unset | same as above | API key for the `openai` provider. |
| `OPENAI_COMPATIBLE_API_KEY` | unset | same as above | API key for the `openai-compatible` provider (e.g. a hosted OpenAI-compatible endpoint that isn't local/keyless). |
| *(configurable)* `apiKeyEnvVar` | provider's default var above | same as above | Not an env var itself — a `ModelConfig`/`~/.windower/config.json` `operator.apiKeyEnvVar` setting that names a *different* environment variable to read the key from, for a provider whose key isn't in one of the three defaults above. `windower doctor` reports this configured var's presence alongside the three defaults. |

`windower doctor` reports presence (never values) of all four API-key variables above, separately for the invoking CLI process and — where verifiable — a running daemon, which is exactly the class of bug ("the daemon that answered had a different, older environment than the shell I'm running `operate` from") this environment-variable reference exists to make visible.

## Documentation

The spec, architecture plan, and phased task breakdown live in [`specs/001-windower-mvp/`](./specs/001-windower-mvp/) — the source of truth for how this repo is built:

- [`spec.md`](./specs/001-windower-mvp/spec.md) — product spec
- [`plan.md`](./specs/001-windower-mvp/plan.md) — architecture and stack rationale
- [`contracts/sidecar-protocol.md`](./specs/001-windower-mvp/contracts/sidecar-protocol.md) — the frozen TS ↔ native sidecar JSON-RPC contract
- [`contracts/cli.md`](./specs/001-windower-mvp/contracts/cli.md) — CLI command/flag/exit-code reference
- [`contracts/mcp-tools.md`](./specs/001-windower-mvp/contracts/mcp-tools.md) — MCP tool reference

For current build status — which phase is in progress, what's done, what's blocked — see [`STATUS.md`](./STATUS.md).
