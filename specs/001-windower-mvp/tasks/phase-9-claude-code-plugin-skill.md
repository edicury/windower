## Phase 9 — Claude Code Plugin + Skill

**Goal:** Package Windower as an installable Claude Code plugin (`plugins/claude-code`) so an agent gets the CLI/MCP server plus a `SKILL.md` teaching the record-a-demo workflow — mirrors how chrome-skills packages browser control.

- 🔵 `plugins/claude-code/plugin.json` (or current Claude Code plugin manifest format) — declares the MCP server entry point and any bundled commands.
- 🔵 `plugins/claude-code/SKILL.md` — teaches the workflow: enumerate targets → resize target → start recording → perform the on-screen actions being demoed → stop recording → report the output path/manifest to the user. Explicit about the non-blocking `start`/`stop` pattern (the single most important thing for an agent to internalize — it's the opposite of most "do X and wait" tools).
- 🔵 A handful of worked recipes in the skill or a companion doc: "record a browser demo," "record a terminal session," "record with narration."
- 🔵 First-run guidance embedded in the skill: what to do when `check_permissions` reports missing grants (tell the user, don't loop retrying).
- 🔵 Manual dogfood pass: install the plugin locally, ask Claude Code to record a real multi-step demo end to end.

**Exit criteria**

- Matches `spec.md` acceptance item: installing the plugin gives Claude a `SKILL.md`-driven workflow that records a real demo end-to-end without the operator specifying CLI flags manually — verified by dogfooding with a naive prompt like "record yourself creating a new file in this project."
- The skill correctly handles the missing-permissions case by explaining to the user rather than failing opaquely.
