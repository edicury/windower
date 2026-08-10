import type {
  CaptureTarget,
  GuardrailState,
  LoopAbortReason,
  LoopReadyResult,
  OperatorRunOptions,
  OperatorRunState,
} from "@windower/core";
import {
  DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
  LOOP_ABORT_REASON_TO_STATE,
  LOOP_PROTOCOL_VERSION,
} from "@windower/core";
import { OPERATOR_ERROR_CODES, OperatorError } from "../errors.js";
import { type OperatorRunInternals, runOperator } from "../run.js";
import { createLoopDeps } from "./deps.js";
import { LoopRpcPeer, type LoopStreams } from "./rpc.js";

/**
 * The operator decision loop, running as its own OS process and speaking
 * contracts/operator-loop-protocol.md to the daemon over stdio.
 *
 * Extracting it applies the same "isolate what can fail" rule CLAUDE.md already
 * applies to capture sessions: this is the process that makes network calls to
 * a model provider, holds a growing transcript in memory, and links a provider
 * SDK the daemon has no reason to trust with its address space. A wedged,
 * leaking, or `kill -9`'d loop must not be able to take down the daemon.
 *
 * What this process does NOT do, by construction:
 * - hold a `SidecarClient`, spawn a native binary, or take the capture lock
 *   (every screen-facing action is a proxied request; see `./deps.ts`);
 * - hold a resolved secret value (it gets `secretNames` only);
 * - write to disk (the daemon owns all persistence — no `transcriptPath`);
 * - know that a recording exists. It never starts, stops, cancels, or looks one
 *   up, carries no session identifier, and behaves identically whether or not
 *   the screen is being recorded (contracts/operator.md §Recording
 *   independence). There is no method on this wire that could touch a recording
 *   even if this process were fully compromised.
 *
 * Guardrails are enforced on both sides. The copy here produces a better
 * transcript and stops a well-behaved child early; the daemon's copy is the
 * authoritative one and is the one that cannot be bypassed.
 */

export interface LoopChildResult {
  state: OperatorRunState;
  /** Process exit code: 0 on any clean wind-down, 1 on a handshake failure. */
  exitCode: number;
}

/** Test seam: the same internals `runOperator` already accepts. */
export type LoopChildInternals = Pick<OperatorRunInternals, "languageModel" | "now">;

export async function runLoopChild(
  streams: LoopStreams,
  internals: LoopChildInternals = {},
): Promise<LoopChildResult> {
  const abortController = new AbortController();
  let abortReason: LoopAbortReason | undefined;
  let currentStepIndex = -1;
  let eof = false;
  const startedAt = Date.now();

  const peer = new LoopRpcPeer(streams, {
    onAbort(params) {
      // A pushed notification, not a poll: the child spends most of every step
      // blocked inside a provider HTTP call, so polling would floor the kill
      // switch's latency at a model round trip.
      abortReason ??= params.reason;
      abortController.abort();
    },
    onPing() {
      return { pong: true, stepIndex: currentStepIndex, uptimeMs: Date.now() - startedAt };
    },
    onEof() {
      // The daemon is gone. There is nobody to `reportResult` to, and a child
      // that outlives its daemon is an orphan holding a provider connection.
      eof = true;
      abortReason ??= "daemon-shutdown";
      abortController.abort();
    },
  });

  let config: LoopReadyResult;
  try {
    config = await peer.request("ready", {
      loopProtocolVersion: LOOP_PROTOCOL_VERSION,
      pid: process.pid,
    });
  } catch (err) {
    // A version mismatch or a refused handshake is a broken install, never a
    // supported configuration — fail loudly rather than degrade.
    peer.close("Handshake failed.");
    throw err;
  }

  // `ready`'s result carries the **resolved** `CaptureTarget` and the run's
  // whole guardrail configuration (contracts/operator-loop-protocol.md
  // §Handshake). A handshake missing either is a broken daemon, not a
  // reduced-capability one — no method on this wire may be optional — so it
  // fails loudly rather than defaulting.
  const target: CaptureTarget | undefined = config.target;
  if (target === undefined) {
    peer.close("Handshake carried no resolved target.");
    throw new OperatorError(
      OPERATOR_ERROR_CODES.DEPENDENCY_ERROR,
      "The daemon's `ready` result carried no resolved target.",
    );
  }

  // The child's copy of the batch ceiling. It produces a better transcript and
  // stops a well-behaved turn early; the daemon's copy is what actually caps a
  // batch and is the one that cannot be bypassed.
  const maxBatchActions = config.maxBatchActions ?? DEFAULT_OPERATOR_MAX_BATCH_ACTIONS;

  const runOptions: OperatorRunOptions & OperatorRunInternals = {
    runId: config.runId,
    task: config.task,
    model: config.model,
    // No resolved values ever reach this process. Placeholders cross the wire
    // verbatim and the daemon substitutes them inside its `performInput`
    // handler (contracts/operator-loop-protocol.md §Secrets).
    secrets: [],
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    maxBatchActions,
    unbounded: config.unbounded,
    bounds: config.bounds,
    // The daemon resolved the selector once, before the spawn, so the child
    // never enumerates to find out what it is driving
    // (contracts/operator-loop-protocol.md §Handshake). It is the run's *only*
    // notion of what it operates — never a channel for telling the child that
    // something is recording that target.
    target,
    // Deliberately absent: `transcriptPath`. The child writes nothing to disk.
    signal: abortController.signal,
    env: config.env,
    onStep: async (step) => {
      // The whole closed step crosses the wire, so a turn's verification rides
      // along as `reportStep.step.checkpoint` — optional, exactly as the model
      // stated it, and absent when it stated none. There is deliberately no
      // checkpoint event method here: the child reports facts and the daemon
      // derives events (contracts/operator-loop-protocol.md §"Operator events
      // on this wire").
      await peer.request("reportStep", { step });
    },
    ...internals,
    startedAtMs: config.startedAtMs,
    secretNames: config.secretNames,
    logSink: (line) => peer.notify("log", { level: "info", message: line }),
    onBeginStep: async (index) => {
      currentStepIndex = index;
      await peer.request("beginStep", { index });
    },
    onPlan: async (content) => {
      // Content only. The daemon assigns `revision`/`atStepIndex`/`tMs`, so a
      // child cannot renumber, backdate, or overwrite a plan revision.
      const accepted = await peer.request("reportPlan", content);
      return accepted.revision;
    },
  };

  const result = await runOperator(runOptions, createLoopDeps(peer));

  // The daemon already knows the outcome it signalled and applies it
  // regardless; reporting the mapped state keeps the child's own record
  // consistent with it rather than silently disagreeing.
  let state = result.state;
  let error = result.error;
  if (abortReason !== undefined && result.state !== "succeeded") {
    state = LOOP_ABORT_REASON_TO_STATE[abortReason];
    if (abortReason === "max-steps") {
      error = {
        code: OPERATOR_ERROR_CODES.MAX_STEPS_EXCEEDED,
        message: "The daemon ended the run at its step ceiling.",
      };
    }
  }

  if (!eof) {
    try {
      await peer.request("reportResult", { state, summary: result.summary, error });
    } catch {
      // The daemon went away mid-report; there is nothing further to do and the
      // daemon's recovery pass will mark the run itself.
    }
    peer.close("Run finished.");
  }

  return { state, exitCode: 0 };
}
