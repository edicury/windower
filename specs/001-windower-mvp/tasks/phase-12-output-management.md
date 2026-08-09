## Phase 12 — Output Management

**Goal:** Configurable output folder + filename templating + the full `manifest.json` writer, tying together Phases 4/5/10/11's outputs into the documented `OutputManifest` shape.

- 🔵 `~/.windower/config.json` — `outputDir` (default `~/Movies/Windower`), `filenameTemplate` (default something like `{app}-{date}-{time}`), `daemonIdleTimeoutMs`, default `VideoSettings`/`AudioSettings`. `windower config get|set` (Phase 7) reads/writes this.
- 🔵 Filename template resolution: `{app}`, `{date}`, `{time}`, `{sessionId}` placeholders resolved from the session's target/timestamps; collision handling (append `-2`, `-3`, ... rather than overwrite).
- 🔵 `manifest.json` writer — assembles the full `OutputManifest` (`data-model.md`) from the finalized session: target snapshot, actual video settings, audio track list, narration info if present, event-timeline path, file stats (size via `fs.stat`).
- 🔵 Output directory creation (mkdir -p semantics) and a pre-flight writable-check before starting a recording, so a bad `outputDir` fails at `start` time, not after minutes of recording at `stop` time.
- 🔵 Retention/cleanup: none automatic in MVP (explicitly note this — it's the user/agent's folder to manage), but `windower list` and `config` make it easy for an agent to find and clean up old recordings itself if asked.

**Exit criteria**

- Matches `spec.md` acceptance item: every recording writes to the configured output folder with a `manifest.json` matching the documented schema (validated against the Zod schema in a test, not just eyeballed).
- Filename collisions are handled without ever silently overwriting a prior recording.
- Starting a recording with a non-writable `outputDir` fails immediately at `start`, with a clear error, not after the recording completes.
