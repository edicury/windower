## Phase 7 — CLI

**Goal:** Ship the `windower` binary implementing every command in `contracts/cli.md`, as a thin layer over the Phase 6 daemon client in `packages/core`.

- 🔵 Pick CLI framework (`citty` vs `commander` — trial both against the `--json`-everywhere requirement, record the decision here) and scaffold `packages/cli`.
- 🔵 Implement all commands: `targets`, `doctor`, `permission request`, `resize`, `start`, `status`, `stop`, `cancel`, `record`, `config get|set`, `daemon status|stop`, `list`.
- 🔵 Consistent `--json` behavior across every command: same shape as the corresponding daemon/MCP response, no CLI-only reformatting.
- 🔵 Human-readable (non-`--json`) output: tables for `targets`/`list`, concise status lines for `start`/`stop`.
- 🔵 Exit codes: `0` success, distinct non-zero codes at least for `1` generic failure and a specific one for `DAEMON_UNREACHABLE` (helps scripts distinguish "daemon down" from "bad input").
- 🔵 `windower --help` / per-command `--help` text.
- 🔵 Shell completion (bash/zsh) — nice-to-have, not gating.

**Exit criteria**

- Matches `spec.md` acceptance item: CLI works end-to-end with both human-readable and `--json` output for every command in `contracts/cli.md`.
- A scripted end-to-end run (`targets` → `resize` → `start` → sleep → `stop`) produces a valid video file purely via CLI calls, no direct daemon/core API usage.
- `--json` output for every command validates against its corresponding Zod schema in `packages/core` (automated test, not manual spot-check).
