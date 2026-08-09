## Phase 5 — Audio

**Goal:** Add system-audio and microphone capture as separate, correctly-synced tracks on top of Phase 4's video pipeline.

- 🔵 System audio: `SCStreamConfiguration.capturesAudio = true`, route the audio sample buffers to a second `AVAssetWriterInput` (audio) alongside the video input in the same `AVAssetWriter`.
- 🔵 Microphone: `AVCaptureSession` + `AVCaptureDevice` (default or `AudioSettings.tracks[].deviceId`-selected) feeding a third `AVAssetWriterInput` when `separateTracks: true`, or mixed into the system-audio track when `false`.
- 🔵 Timestamp alignment: all inputs (video, system audio, mic) must share the same `AVAssetWriter` session start time so tracks stay in sync — verify via a clap-test fixture (visual clap + audible clap, confirm frame-accurate alignment in the output).
- 🔵 Device enumeration for mic selection (`AVCaptureDevice.DiscoverySession`), surfaced through `getPermissions`/a small `listAudioDevices`-equivalent if needed for the CLI's `--mic-device` flag (Phase 7).
- 🔵 Graceful degradation: if mic permission is denied but `--audio-mic` was requested, fail fast with `PERMISSION_DENIED` rather than silently recording without it.

**Exit criteria**

- Matches `spec.md` acceptance item: system audio and mic record as separate, correctly-synced tracks — verified with the clap-test fixture (sync drift under one frame).
- `ffprobe` confirms track count/layout matches `AudioSettings` (2 tracks for system+mic separate, 1 for mixed).
- Denied mic permission with `--audio-mic` requested produces a clear `PERMISSION_DENIED` error, not a silent no-audio recording.
