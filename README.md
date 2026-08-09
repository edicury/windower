# Windower

Windower is an AI-native screen recorder: a TypeScript orchestration layer (CLI, MCP server, Claude Code plugin, and a background daemon used only by the flows that need one) drives a native per-OS sidecar (Swift on macOS first) over a JSON-RPC stdio protocol, so agents can start/stop recordings, control windows, and get a structured event timeline without ever branching on platform above the sidecar boundary.

See [`specs/001-windower-mvp/`](./specs/001-windower-mvp/) for the full spec, architecture plan, and phased task breakdown — start with `spec.md`, `plan.md`, and `contracts/sidecar-protocol.md`.

## Quick start

`windower record` is the zero-setup path: it runs entirely in the invoking process — no background daemon to start, stop, or reason about.

```bash
npx windower record --duration 10
```

This records 10 seconds of the primary display to your default output folder (`~/Movies/Windower`) and writes `manifest.json` and an `.events.json` timeline alongside the video. Nothing is left running afterward.

For the primary agent-facing flow — start now, perform the actions being demoed, stop when done — use the two-call form instead of `record`:

```bash
windower start --target <id>        # → { sessionId }, returns immediately
# ...perform the on-screen actions being demoed...
windower stop <sessionId>           # finalizes: video + manifest + event timeline
```

`windower targets` lists what's available to record (windows/displays/apps) before you start. `windower doctor` is a read-only, no-daemon health check — run it first if anything looks wrong; it never triggers a permission prompt.

First run will trigger macOS TCC prompts (Screen Recording, Accessibility, Microphone) — grant them via `windower permission request <capability>` or by letting the OS prompt fire, then re-run.

### Where a daemon *does* show up

Two flows genuinely need a process that outlives the CLI invocation, and only these auto-start a background daemon (unix socket at `~/.windower/daemon.sock`) as an implementation detail:

- **`windower start` / `stop` / `cancel`** (the two-call recording pattern above) — `start` needs something to own the in-progress capture between the two calls, so it spawns a daemon if none is listening; `stop`/`cancel` attach to it.
- **`windower operate --detach`** and **`operate abort`** — the non-blocking form of the operator (see below).

Every other command (`record`, `targets`, `doctor`, `permission request`, `resize`, `status`, `list`, `config`, and blocking `operate`) runs entirely in the invoking process and never starts or requires a daemon. If you do end up with one running — say, from a `start`/`stop` session — `windower daemon status` reports on it and `windower daemon stop` shuts it down cleanly (finalizing any in-flight recording first; `--discard` cancels instead). You should rarely need to touch these directly. Full command-by-command routing lives in `specs/001-windower-mvp/contracts/cli.md`'s "Daemon policy" section.

### The operator (`windower operate`)

`windower operate "<task>"` drives an LLM-guided run — perceive the screen, synthesize input, complete the task — and records it. It **blocks by default**: it runs in the invoking process, streams step progress to stderr, and prints the final result when done, so it works with zero daemon setup just like `record`. Pass `--detach` to get the old non-blocking behavior back (`{ runId }` immediately, poll with `operate status`) if you want to kick off a long run from a terminal and walk away.

```bash
windower operate "Open waroom.co, log in as {{user}}/{{password}}, create an incident" \
  --secret password=keychain:waroom --resolution 1920x1080 --out ~/Desktop --json
```

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

`windower` resolves the sidecar binary at `native/macos/.build/debug/windower-sidecar-macos` automatically (dev-build convention — see `packages/core/src/process/sidecar-path.ts`). Override with `WINDOWER_SIDECAR_BINARY_PATH=<path>` if you built elsewhere.

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
| `WINDOWER_SIDECAR_BINARY_PATH` | unset (auto-resolved) | CLI, daemon, MCP server (anything that spawns the native sidecar) | Pins the exact sidecar binary to spawn, skipping auto-resolution. Without it, resolution tries the dev-build path under `native/<os>/.build/debug/` (inside a monorepo checkout), then falls back to the platform-specific `@windower/sidecar-<os>-<arch>` npm package. `windower doctor`'s `sidecar.source` reports which strategy actually resolved (`env-override` / `dev-build` / `npm-package`). See `packages/core/src/process/sidecar-path.ts`. |
| `WINDOWER_DAEMON_BIN_PATH` | unset (auto-resolved) | CLI, MCP server (whichever process spawns the daemon) | Pins the exact daemon entrypoint (`node <path>`) that `ensureDaemonRunning` spawns, mirroring `WINDOWER_SIDECAR_BINARY_PATH`'s resolution order (env override → dev-build path → published `@windower/daemon` package). Useful for testing a version-mismatch auto-restart against a real older build. See `packages/core/src/daemon/connect.ts`. |
| `WINDOWER_BACKEND` | unset | CLI only | `local` or `daemon` — debugging escape hatch that overrides the normal command → backend-mode routing (see the "Daemon policy" table in `specs/001-windower-mvp/contracts/cli.md`). Forces an otherwise-`local` command through the daemon, or vice versa. Equivalent to the `--daemon`/`--no-daemon` CLI flags, which take precedence over this variable when both are given. Has no effect on `attach`-mode commands (`stop`, `cancel`, `daemon status`/`stop`/`restart`) — attaching only to an already-listening daemon is inherent to their correctness and isn't overridable. |
| `WINDOWER_OPERATOR_DEBUG` | unset | `packages/operator` (used by both blocking `operate` in-process and the daemon-backed detached path) | When set (any truthy value), the operator's redacted logger writes its log lines to stderr instead of discarding them. Every line still passes through the same redaction filter as the transcript, so secrets are never printed even with this on — it only controls whether the (already-redacted) lines are emitted at all. |
| `ANTHROPIC_API_KEY` | unset | `packages/operator`, read by whichever process runs the operator (the CLI itself for blocking `operate`, the daemon for `--detach`/MCP's `run_operator`) | API key for the `anthropic` provider. Used when `--model anthropic:...` (or the configured default) is selected and no `apiKeyEnvVar` override names a different variable. |
| `OPENAI_API_KEY` | unset | same as above | API key for the `openai` provider. |
| `OPENAI_COMPATIBLE_API_KEY` | unset | same as above | API key for the `openai-compatible` provider (e.g. a hosted OpenAI-compatible endpoint that isn't local/keyless). |
| *(configurable)* `apiKeyEnvVar` | provider's default var above | same as above | Not an env var itself — a `ModelConfig`/`~/.windower/config.json` `operator.apiKeyEnvVar` setting that names a *different* environment variable to read the key from, for a provider whose key isn't in one of the three defaults above. `windower doctor` reports this configured var's presence alongside the three defaults. |

`windower doctor` reports presence (never values) of all four API-key variables above, separately for the invoking CLI process and — where verifiable — a running daemon, which is exactly the class of bug ("the daemon that answered had a different, older environment than the shell I'm running `operate` from") this environment-variable reference exists to make visible.
