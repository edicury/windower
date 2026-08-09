# Windower

Windower is an AI-native screen recorder: a TypeScript orchestration layer (daemon, CLI, MCP server, Claude Code plugin) drives a native per-OS sidecar (Swift on macOS first) over a JSON-RPC stdio protocol, so agents can start/stop recordings, control windows, and get a structured event timeline without ever branching on platform above the sidecar boundary.

See [`specs/001-windower-mvp/`](./specs/001-windower-mvp/) for the full spec, architecture plan, and phased task breakdown — start with `spec.md`, `plan.md`, and `contracts/sidecar-protocol.md`.
