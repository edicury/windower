# Windower

Windower is an AI-native screen recorder: a TypeScript orchestration layer (daemon, CLI, MCP server, Claude Code plugin) drives a native per-OS sidecar (Swift on macOS first) over a JSON-RPC stdio protocol, so agents can start/stop recordings, control windows, and get a structured event timeline without ever branching on platform above the sidecar boundary.

See [`specs/001-windower-mvp/`](./specs/001-windower-mvp/) for the full spec, architecture plan, and phased task breakdown — start with `spec.md`, `plan.md`, and `contracts/sidecar-protocol.md`.

## Build & run (macOS)

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

The daemon auto-starts on first CLI use (unix socket at `~/.windower/daemon.sock`); no separate process to launch manually. Use `windower daemon status` / `windower daemon stop` for explicit control.

First run will trigger macOS TCC prompts (Screen Recording, Accessibility, Microphone) — grant them via `windower permission request <capability>` or by letting the OS prompt fire, then re-run.

### Extra setup for the operator (`windower operate`)

Recording needs nothing beyond the steps above. The operator (`packages/operator`) additionally pulls in an AI SDK provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@ai-sdk/openai-compatible`) via `pnpm install`, and needs a model to talk to:

- **Hosted providers** read their API key from the environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or whatever `ModelConfig.apiKeyEnvVar` names. A key is **never** accepted as a CLI flag (shell history / process listing exposure), so export it in your shell rc before running `windower operate`.
- **Local / self-hosted models** need no key at all: `--model openai-compatible:<model> --base-url http://localhost:11434/v1` (Ollama, LM Studio, vLLM, …).

This is the one place Windower talks to the network, and only when you invoke the operator — see `specs/001-windower-mvp/spec.md` §7 for the scoped exception to the otherwise local-only design.
