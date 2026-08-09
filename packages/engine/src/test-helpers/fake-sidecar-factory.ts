import {
  type CaptureTarget,
  type FakeSidecar,
  type FakeSidecarOptions,
  type PermissionReport,
  type SidecarClient,
  type SpawnSidecarOptions,
  createFakeSidecarPair,
} from "@windower/core";
import type { SidecarFactory, SidecarHandle } from "../recording-engine.js";

export interface SpawnedFakeSidecar {
  client: SidecarClient;
  sidecar: FakeSidecar;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

/**
 * Test double for `SidecarFactory`: every call spawns a fresh in-memory
 * `FakeSidecar` (mirrors "one sidecar process per session"), all sharing the
 * same `targets`/`capabilities` so transient enumerate calls (target-by-id
 * resolution, passthrough ops) see the same world as session-owning ones.
 * Records each spawn so tests can reach into a specific session's fake
 * sidecar (e.g. to call `emitCaptureEnded`) or manually fire the `onExit`
 * callback `RecordingEngine` registered, simulating a real process crash.
 */
export function createFakeSidecarFactory(options: {
  targets?: CaptureTarget[];
  capabilities?: FakeSidecarOptions["capabilities"];
  permissions?: Partial<PermissionReport>;
}): { spawnSidecar: SidecarFactory; spawns: SpawnedFakeSidecar[] } {
  const spawns: SpawnedFakeSidecar[] = [];

  const spawnSidecar = (spawnOptions: SpawnSidecarOptions): SidecarHandle => {
    const { client, sidecar, dispose } = createFakeSidecarPair({
      targets: options.targets,
      capabilities: options.capabilities,
      permissions: options.permissions,
    });
    spawns.push({ client, sidecar, onExit: spawnOptions.onExit });
    return {
      client,
      terminate: async () => {
        dispose();
      },
    };
  };

  return { spawnSidecar, spawns };
}
