## Phase 11 — Narration Hook

**Goal:** Let an agent supply a pre-generated audio file (e.g. TTS output) plus a time offset at stop-time, muxed into the final recording as an additional track — the AI-native differentiator over Screen Studio/Loom.

- 🔵 `stop_recording`/`windower stop` accept `narration: { filePath, offsetMs }` (per `contracts/mcp-tools.md` / `contracts/cli.md`).
- 🔵 Daemon validates the file exists and is a decodable audio format (via `AVAsset` probe) before attempting mux — fail fast with a clear error rather than producing a broken output file.
- 🔵 Mux step: after the sidecar finalizes the base recording (video + system/mic tracks), a post-mux pass (AVFoundation `AVMutableComposition` or an `ffmpeg` invocation — decide and document here) inserts the narration as an additional audio track starting at `offsetMs`, without re-encoding video.
- 🔵 `OutputManifest.narration` populated with the applied offset and resulting track index.
- 🔵 Handle offset edge cases: narration longer than the video (truncate or allow overhang — decide and document), negative/zero offset.

**Exit criteria**

- Matches `spec.md` acceptance item: a supplied narration audio file is muxed into the output at the correct offset — verified via `ffprobe` track listing and a manual playback check that narration audio starts at the right point.
- Video track is untouched (same duration/resolution/codec) after narration mux — no re-encode side effects.
- Invalid/missing narration file path produces a clear error and does not corrupt or block finalization of the base recording (i.e., the video itself is still saved even if narration mux fails — decide and document this fallback behavior explicitly here).
