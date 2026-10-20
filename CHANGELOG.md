# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- Remotion template, `ve:render` and `ve:doctor` preflight (Node, ffmpeg, Headless Shell, port, disk), with reuse of a downloaded Headless Shell across installs.
- Scene library with schema-validated scenes and a voice provider field in the storyboard spec.
- `windower` skill and `/explain-video` command: staged, resumable workflow with `.windower/<slug>/` runs, brief, storyboard validation, and an explicit approval gate.
- Source handling: source classifier (`ve:sources`), brief provenance lint (`ve:brief`), redaction (`ve:redact`), and gate disclosure of external MCP sources.
- Voice providers: ElevenLabs, OpenAI, Piper and silent; `ve:synth`, `ve:voices`, voice and model selection, `.windower.json` config (keys are env-only), and egress disclosure at the gate.
- Captions in SRT and VTT alongside `out/video.mp4`.
