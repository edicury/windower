import type { DaemonMethodMap, PermissionReport } from "@windower/core";
import type { SidecarFactory } from "./recording-engine.js";

/**
 * `list_targets`/`check_permissions`/`request_permission`/`resize_window` —
 * the sidecar passthrough operations from contracts/mcp-tools.md that don't
 * belong to any `RecordingSession`. Each call spawns a short-lived sidecar,
 * does its one RPC, and terminates it — these aren't captures, so they don't
 * warrant the "one sidecar process per active session" lifecycle the
 * `RecordingEngine` uses.
 */
export class PassthroughService {
  constructor(private readonly spawnSidecar: SidecarFactory) {}

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

    const handle = this.spawnSidecar({});
    try {
      return await handle.client.enumerateTargets({ kinds: sidecarKinds });
    } finally {
      await handle.terminate().catch(() => {});
    }
  }

  async checkPermissions(): Promise<DaemonMethodMap["check_permissions"]["result"]> {
    const handle = this.spawnSidecar({});
    try {
      const describeResult = await handle.client.describe();
      const partial = await handle.client.getPermissions();
      const report: PermissionReport = {
        screenRecording: partial.screenRecording ?? "not_determined",
        accessibility: partial.accessibility ?? "not_determined",
        microphone: partial.microphone ?? "not_determined",
        daemonRunning: true,
        sidecarAvailable: true,
        sidecarVersion: describeResult.version,
      };
      return report;
    } catch {
      return {
        screenRecording: "not_determined",
        accessibility: "not_determined",
        microphone: "not_determined",
        daemonRunning: true,
        sidecarAvailable: false,
      };
    } finally {
      await handle.terminate().catch(() => {});
    }
  }

  async requestPermission(
    params: DaemonMethodMap["request_permission"]["params"],
  ): Promise<DaemonMethodMap["request_permission"]["result"]> {
    const handle = this.spawnSidecar({});
    try {
      return await handle.client.requestPermission(params);
    } finally {
      await handle.terminate().catch(() => {});
    }
  }

  async resizeWindow(
    params: DaemonMethodMap["resize_window"]["params"],
  ): Promise<DaemonMethodMap["resize_window"]["result"]> {
    const handle = this.spawnSidecar({});
    try {
      return await handle.client.resizeWindow(params);
    } finally {
      await handle.terminate().catch(() => {});
    }
  }
}
