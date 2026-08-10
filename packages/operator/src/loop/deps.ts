import type { InputAction, OperatorDeps, Rect } from "@windower/core";
import type { LoopRpcPeer } from "./rpc.js";

/**
 * The loop child's `OperatorDeps`.
 *
 * > The loop child **never** constructs a `SidecarClient`, **never** spawns a
 * > native binary, and **never** opens `~/.windower/capture.lock`.
 * > — contracts/operator-loop-protocol.md
 *
 * Every screen-facing effect is a proxied request to the daemon, which serves
 * it from the capture sidecar or the control sidecar. That rule is enforced by
 * the dependency-graph test in `loop-entry.deps.test.ts`, not by code review —
 * mirroring how the native split is enforced by `otool -L` rather than
 * convention. This module is therefore deliberately import-poor: one type-only
 * import from `@windower/core` (erased at compile time) and the RPC peer.
 *
 * The adapter adds no capability of its own. These five methods are exactly
 * `OperatorDeps`' five members (Phase 22 added `enumerateElements`), which
 * are exactly the five sidecar-facing methods every other Windower interface
 * already uses — the child can do strictly less than the in-process loop
 * could, because it cannot reach a `SidecarClient` at all.
 *
 * Note what is *not* here: nothing that starts, stops, cancels, or looks up a
 * recording. The operator does not know whether one exists and behaves
 * identically either way, so there is nothing here it could touch even by
 * accident (contracts/operator.md §Recording independence).
 */
export function createLoopDeps(peer: LoopRpcPeer): OperatorDeps {
  return {
    captureFrame(params: { format: "png" | "jpeg"; maxWidth?: number; quality?: number }) {
      // `fresh` is left unset — the loop takes whatever the capture sidecar's
      // frame-sharing policy gives it (contracts/sidecar-protocol.md). Whether
      // that frame came from an already-live capture source or a one-shot
      // capture is unobservable here, by design.
      return peer.request("captureFrame", params);
    },

    performInput(actions: InputAction[]) {
      // Actions cross the wire in **placeholder form**: `{{name}}` is what the
      // model emitted and what the child forwards. The daemon substitutes the
      // real value immediately before the control-surface RPC, so no secret
      // value ever exists in this process.
      return peer.request("performInput", { actions });
    },

    async listTargets(kinds?: Array<"display" | "window" | "app">) {
      const result = await peer.request("enumerateTargets", kinds === undefined ? {} : { kinds });
      return result.targets;
    },

    resizeWindow(targetId: string, bounds: Rect) {
      return peer.request("resizeWindow", { targetId, bounds });
    },

    enumerateElements(params) {
      // No `target` param, same rule as the other four: the daemon resolves
      // the run's target itself (Phase 22).
      return peer.request("enumerateElements", params);
    },
  };
}
