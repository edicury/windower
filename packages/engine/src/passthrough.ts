import type { DaemonMethodMap, PermissionReport, SidecarClient } from "@windower/core";
import type { ControlEngine } from "./control-engine.js";
import type { SidecarFactory } from "./recording-engine.js";
import { type CaptureAccess, CaptureLock } from "./screen-capture-lock.js";

export interface PassthroughServiceOptions {
  /**
   * The screen-capture exclusivity lock
   * (`contracts/screen-capture-exclusivity.md`). Defaults to a `CaptureLock`
   * over `spawnSidecar`. A host should pass the **same** instance it gave
   * `RecordingEngine`, so a `list_targets` arriving during that host's own
   * recording takes row 1 of the acquire-or-wait table (reuse the capture
   * sidecar this process already has) instead of contending for the lock file
   * against itself.
   */
  capture?: CaptureAccess;
  /**
   * Control surface owner for `resize_window`. Optional: when absent,
   * `resizeWindow` falls back to a one-off spawn through `spawnSidecar`,
   * which is what a host whose sidecar still serves both surfaces (a
   * single-binary backend, or macOS before the Phase 21 split lands) needs.
   * Either way it **never** touches the capture lock.
   */
  control?: ControlEngine;
}

/**
 * `list_targets`/`check_permissions`/`request_permission`/`resize_window` —
 * the sidecar passthrough operations from contracts/mcp-tools.md that don't
 * belong to any `RecordingSession`.
 *
 * Phase 21: the three **capture-surface** operations no longer spawn their
 * own sidecar unconditionally. They go through the acquire-or-wait table of
 * `contracts/screen-capture-exclusivity.md`, which means:
 *
 * - with a recording live in this process, they reuse that recording's capture
 *   sidecar (row 1) — no file I/O, no spawn;
 * - with nothing holding the lock, they spawn a capture sidecar under it,
 *   exactly as this service used to — but now serialized system-wide, so two
 *   concurrent `list_targets` invocations from two CLI processes can never
 *   both have a capture binary alive (row 2);
 * - with the lock held by another live process, they wait briefly and then
 *   fail with `SCREEN_CAPTURE_BUSY` (rows 3/4). They never spawn a second
 *   ScreenCaptureKit process.
 *
 * This is the generalization of the `bugs.spec.md` #6 stopgap: "reuse the
 * recording's sidecar" stops being a special case the operator remembers to
 * apply and becomes the only path any caller has.
 *
 * `resize_window` is deliberately NOT in that list — it is a **control**
 * surface method with zero ScreenCaptureKit relationship, and taking the
 * capture lock before serving it would reintroduce exactly the coupling Phase
 * 21 exists to delete (`contracts/screen-capture-exclusivity.md` §What never
 * takes this lock).
 */
export class PassthroughService {
  private readonly capture: CaptureAccess;
  private readonly control: ControlEngine | undefined;

  constructor(
    private readonly spawnSidecar: SidecarFactory,
    options: PassthroughServiceOptions = {},
  ) {
    this.capture = options.capture ?? new CaptureLock({ spawnSidecar });
    this.control = options.control;
  }

  async listTargets(
    params: DaemonMethodMap["list_targets"]["params"],
  ): Promise<DaemonMethodMap["list_targets"]["result"]> {
    // "app" is a valid CLI/MCP filter (contracts/mcp-tools.md) but the sidecar
    // protocol only enumerates "display"|"window" (region has no independent
    // ID) — see packages/core/src/protocol/methods.ts.
    const sidecarKinds = params.kinds?.filter(
      (kind): kind is "display" | "window" => kind === "display" || kind === "window",
    );
    if (params.kinds && sidecarKinds && sidecarKinds.length === 0) {
      return { targets: [] };
    }

    return this.capture.withCaptureClient((client) =>
      client.enumerateTargets({ kinds: sidecarKinds }),
    );
  }

  /**
   * The **merged** permission report. `getPermissions` is on both surfaces and
   * each implementation reports only its own relevant kinds — capture:
   * `screenRecording`/`microphone`, control: `accessibility`
   * (`contracts/sidecar-protocol.md` §Method-ownership surfaces). A host
   * holding both connections merges the two; a host holding one gets a partial
   * report and MUST treat absent kinds as **unknown, not denied** — which is
   * exactly what `"not_determined"` means here, so every gap below falls back
   * to it and never to `"denied"`.
   *
   * A control surface that can't be reached is not an error: it downgrades
   * `accessibility` to unknown and leaves the capture-derived kinds (and
   * `sidecarAvailable`, which tracks the capture surface, the one recording
   * actually needs) untouched.
   */
  async checkPermissions(): Promise<DaemonMethodMap["check_permissions"]["result"]> {
    const [capture, control] = await Promise.all([
      this.captureSurfacePermissions(),
      this.controlSurfacePermissions(),
    ]);

    const report: PermissionReport = {
      screenRecording: capture?.permissions.screenRecording ?? "not_determined",
      // Control wins when it answered — it is the surface that owns
      // Accessibility. Falling back to the capture surface's value keeps a
      // single-binary backend (both surfaces in one process) working unchanged.
      accessibility:
        control?.accessibility ?? capture?.permissions.accessibility ?? "not_determined",
      microphone: capture?.permissions.microphone ?? "not_determined",
      daemonRunning: true,
      sidecarAvailable: capture !== undefined,
    };
    if (capture) report.sidecarVersion = capture.version;
    return report;
  }

  /**
   * Routed by kind, because each surface can only prompt for what it owns:
   * asking the control binary for Screen Recording would attribute the TCC
   * prompt to the wrong binary (and vice versa). Falls back to the capture
   * surface when no `ControlEngine` is injected — a single-binary backend
   * serves every kind from one process.
   */
  async requestPermission(
    params: DaemonMethodMap["request_permission"]["params"],
  ): Promise<DaemonMethodMap["request_permission"]["result"]> {
    if (params.kind === "accessibility" && this.control) {
      const client = await this.control.client();
      return client.requestPermission(params);
    }
    return this.capture.withCaptureClient((client) => client.requestPermission(params));
  }

  /**
   * Control surface — no capture lock, ever. Served by the injected
   * `ControlEngine` when the host has one; otherwise by a one-off spawn
   * through `spawnSidecar` (a backend whose single binary still implements
   * both surfaces).
   */
  async resizeWindow(
    params: DaemonMethodMap["resize_window"]["params"],
  ): Promise<DaemonMethodMap["resize_window"]["result"]> {
    if (this.control) return this.control.resizeWindow(params);

    // `surface: "control"` is load-bearing: `SpawnSidecarOptions.surface`
    // defaults to `"capture"`, so an unqualified spawn here would start a
    // *capture* binary — a second ScreenCaptureKit process, next to a possibly
    // live recording, to serve a call that touches no capture state at all.
    // That is precisely the hazard `contracts/screen-capture-exclusivity.md`
    // exists to remove. It still takes no capture lock: any number of control
    // processes may run concurrently with each other and with a capture one.
    const handle = this.spawnSidecar({ surface: "control" });
    try {
      return await handle.client.resizeWindow(params);
    } finally {
      await handle.terminate().catch(() => {});
    }
  }

  // ---- internals ----

  /** Capture-relevant kinds + the sidecar version, or `undefined` if the capture surface can't be reached. */
  private async captureSurfacePermissions(): Promise<
    | { permissions: Awaited<ReturnType<SidecarClient["getPermissions"]>>; version: string }
    | undefined
  > {
    try {
      return await this.capture.withCaptureClient(async (client) => {
        const describeResult = await client.describe();
        const permissions = await client.getPermissions();
        return { permissions, version: describeResult.version };
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Control-relevant kinds, or `undefined` when there is no control surface or
   * it can't be reached. Never takes the capture lock.
   */
  private async controlSurfacePermissions(): Promise<
    Awaited<ReturnType<SidecarClient["getPermissions"]>> | undefined
  > {
    if (!this.control) return undefined;
    try {
      const client = await this.control.client();
      return await client.getPermissions();
    } catch {
      return undefined;
    }
  }
}
