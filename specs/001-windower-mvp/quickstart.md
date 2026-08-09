# Quickstart

## Install

```bash
npm install -g @windower/cli
# or, for Claude Code:
claude plugin install windower
```

Installing either pulls the codesigned/notarized macOS sidecar binary (see `plan.md` §6 / Phase 14).

## Grant permissions

```bash
windower doctor
```

First run reports all three as `not_determined`. Trigger prompts explicitly, one at a time:

```bash
windower permission request screenRecording
windower permission request accessibility
windower permission request microphone   # only if you'll use mic capture
```

Re-run `windower doctor` to confirm `granted` for each you need. Screen Recording and Accessibility require a one-time approval in System Settings → Privacy & Security; macOS may require relaunching the calling process (Terminal, or Claude Code) after granting.

## First recording — CLI

```bash
# 1. See what's available
windower targets --json

# 2. Pick a window and size it deterministically
windower resize --window <id> --width 1280 --height 720

# 3. Start recording (returns immediately)
windower start --target <id> --kind window --audio-mic --json
# => { "sessionId": "..." }

# ... do the thing you're demoing ...

# 4. Stop and get the file
windower stop <sessionId> --json
# => { "outputPath": "...", "manifestPath": "...", "eventTimelinePath": "..." }
```

## First recording — agent (MCP / Claude Code skill)

With the Claude Code plugin installed, an agent given a task like *"record a demo of logging into the app and creating a project"* follows the `SKILL.md` workflow:

1. `list_targets` → find the app's window.
2. `resize_window` → set a clean, consistent size (e.g. 1280×720).
3. `start_recording` → get `sessionId`.
4. Perform the actual UI actions (click, type, navigate) via its normal computer-use / browser tools.
5. `stop_recording` → get the file path and manifest.
6. Report the file path (and optionally the event timeline) back to the user.

No CLI flags to remember — the skill encodes this sequence and sane defaults.

## Configure output location

```bash
windower config set outputDir ~/Movies/Windower/demos
windower config set filenameTemplate "{app}-{date}-{time}"
```

## Troubleshooting

Run `windower doctor` first — it reports permission state, daemon health (`daemonRunning`), and sidecar availability (`sidecarAvailable`) in one call. Logs: `~/.windower/logs/`.
