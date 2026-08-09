## Phase 13 — Testing & Hardening

**Goal:** End-to-end confidence beyond the per-phase unit/integration tests already required above — a real fixture app, a CI strategy that copes with TCC permission gating, and a soak test for long recordings.

- 🔵 `fixtures/demo-app` — a small, deterministic-geometry test app (native or Electron; pick whichever is faster to make pixel-perfect) with known button positions, so e2e tests can assert exact click coordinates against the event timeline and exact resize behavior.
- 🔵 e2e suite (Vitest + real daemon + real macOS sidecar, no mocking below the CLI/MCP layer): full golden path — enumerate `demo-app`'s window → resize → start with audio → click a sequence of known buttons → stop → assert manifest correctness, video plays and matches requested resolution/fps, event timeline matches the known click sequence.
- 🔵 CI strategy: GitHub Actions macOS runners cannot interactively grant TCC permissions. Document the chosen approach here — likely: e2e suite runs locally-gated (documented as a required pre-merge manual check) while CI runs everything that doesn't need Screen Recording/Accessibility grants (protocol tests, CLI arg parsing, schema validation, daemon lifecycle with a fake sidecar).
- 🔵 Soak test: 30-minute continuous recording (video + both audio tracks + event timeline), confirm no drift between audio/video sync, no memory growth in the daemon or sidecar, file finalizes correctly.
- 🔵 Crash-injection tests: kill the sidecar process mid-recording (daemon should mark session `failed` cleanly); kill the daemon mid-recording and restart (Phase 6's crash recovery).
- 🔵 Permission-denied path tests for every gated feature (resize, screen capture, mic).

**Exit criteria**

- Matches `spec.md` acceptance item: fixture-app e2e suite is green (locally, with the CI-gating caveat documented above); 30-minute soak test completes without drift or crash.
- Every error-taxonomy code in `contracts/sidecar-protocol.md` has at least one test that triggers it and asserts the correct propagation to CLI/MCP output.
- Crash-injection tests pass: no hung sessions, no daemon crash from a sidecar crash.
