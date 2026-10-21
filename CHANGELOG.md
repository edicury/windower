# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Changed

- Docs: runs write `.windower/<slug>/` under the current working directory; recommend a scratch directory with the explained repo passed as absolute read-only `repoRoot`. README Quickstart covers the `$WINDOWER` install step, framekit from npm and the first-run Headless Shell download.
- Sequence validation: the self-message error now says it is unsupported and suggests a separate participant or a note step; documented in the scene catalog and authoring reference.
- framekit replaces Remotion as the only render engine. `template/` imports the compat entries of the published `@windower/framekit` package (installed from npm, no sibling checkout); `--engine` and `WINDOWER_ENGINE` accept only `framekit` (any other value exits 2); the Remotion engine, `studio` script, parity harness and `ve:make-template-framekit` are removed; `ve:doctor` check 5 reports the framekit browser; license note is the framekit MIT sentence.

### Added

- Remotion template, `ve:render` and `ve:doctor` preflight (Node, ffmpeg, Headless Shell, port, disk), with reuse of a downloaded Headless Shell across installs.
- Scene library with schema-validated scenes and a voice provider field in the storyboard spec.
- `windower` skill and `/explain-video` command: staged, resumable workflow with `.windower/<slug>/` runs, brief, storyboard validation, and an explicit approval gate.
- Source handling: source classifier (`ve:sources`), brief provenance lint (`ve:brief`), redaction (`ve:redact`), and gate disclosure of external MCP sources.
- Voice providers: ElevenLabs, OpenAI, Piper and silent; `ve:synth`, `ve:voices`, voice and model selection, `.windower.json` config (keys are env-only), and egress disclosure at the gate.
- Captions in SRT and VTT alongside `out/video.mp4`.
