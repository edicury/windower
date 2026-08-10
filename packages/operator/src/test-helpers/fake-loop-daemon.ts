import { PassThrough } from "node:stream";
import type {
  GuardrailState,
  InputAction,
  LoopAbortReason,
  LoopPingResult,
  LoopReadyResult,
  OperatorPlan,
  OperatorStep,
  Rect,
} from "@windower/core";
import { LOOP_PROTOCOL_VERSION } from "@windower/core";
import type { LoopStreams } from "../loop/rpc.js";
import { FAKE_TARGET, TINY_PNG_BASE64 } from "./fakes.js";

/**
 * A fake **daemon** for the loop-child side of
 * contracts/operator-loop-protocol.md — same spirit as
 * `packages/core/src/protocol/fake-sidecar.ts`, one layer up: an in-memory peer
 * that implements the serving side of the wire so the child can be driven end
 * to end with no daemon, no sidecar, and no native binary anywhere.
 *
 * It implements the guardrails on the *serving* side, which is where they
 * actually live: the step bracket, the per-step action count, the batch
 * ceiling, and plan-revision identity. That is what lets a test prove the child
 * cannot bypass them rather than merely that it doesn't try.
 */

export interface FakeLoopDaemonOptions {
  config?: Partial<LoopReadyResult>;
  maxBatchActions?: number;
  /** Per-method overrides — throw a `{ code }` object to reject with that code. */
  onPerformInput?: (actions: InputAction[]) => { performed: number } | undefined;
  onResizeWindow?: (targetId: string, bounds: Rect) => void;
  onCaptureFrame?: () => void;
}

export interface FakeLoopDaemonCalls {
  ready: number;
  beginStep: number[];
  captureFrame: number;
  performInput: InputAction[][];
  enumerateTargets: number;
  resizeWindow: Array<{ targetId: string; bounds: Rect }>;
  reportPlan: Array<{ steps: string[]; rationale?: string; revision: number }>;
  reportStep: OperatorStep[];
  reportResult: Array<{ state: string; summary?: string; error?: { code: string } }>;
  log: Array<{ level: string; message: string }>;
  /** Method names, in wire order — the transcript of the protocol itself. */
  order: string[];
}

const BOUNDS: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

export class FakeLoopDaemon {
  readonly streams: LoopStreams;
  readonly calls: FakeLoopDaemonCalls = {
    ready: 0,
    beginStep: [],
    captureFrame: 0,
    performInput: [],
    enumerateTargets: 0,
    resizeWindow: [],
    reportPlan: [],
    reportStep: [],
    reportResult: [],
    log: [],
    order: [],
  };
  /** Everything the child ever sent, verbatim — used to assert on secrets. */
  readonly rawFromChild: string[] = [];

  private readonly toChild = new PassThrough();
  private readonly fromChild = new PassThrough();
  private readonly options: FakeLoopDaemonOptions;
  private readonly config: LoopReadyResult;
  private readonly maxBatchActions: number;

  private buffer = "";
  private started = false;
  private ended = false;
  private stepsUsed = 0;
  private openStep: number | undefined;
  private actionsInStep = 0;
  private planRevision: number | undefined;
  private aborted = false;
  private nextDaemonRequestId = 1;
  private readonly pings = new Map<number, (result: LoopPingResult) => void>();
  /** The daemon's copy of run state, as it would persist it. */
  plan: OperatorPlan | undefined;

  constructor(options: FakeLoopDaemonOptions = {}) {
    this.options = options;
    this.maxBatchActions = options.maxBatchActions ?? 8;
    this.config = {
      runId: "run-loop-1",
      task: "Do the thing",
      model: { provider: "mock", model: "mock-model" },
      secretNames: [],
      maxSteps: 10,
      timeoutMs: 60_000,
      unbounded: false,
      bounds: BOUNDS,
      startedAtMs: Date.now(),
      // The daemon resolves the selector before the spawn and hands the child
      // the resolved target (contracts/operator-loop-protocol.md §Handshake).
      target: FAKE_TARGET,
      ...options.config,
    } as LoopReadyResult;
    this.streams = { input: this.toChild, output: this.fromChild };
    this.fromChild.setEncoding("utf8");
    this.fromChild.on("data", (chunk: string) => this.onData(chunk));
  }

  /** Pushes `abort` — the kill switch the child cannot poll for cheaply. */
  abort(reason: LoopAbortReason = "user"): void {
    this.aborted = true;
    this.write({ jsonrpc: "2.0", method: "abort", params: { reason } });
  }

  /** Sends `ping` and resolves with the child's answer. */
  ping(): Promise<LoopPingResult> {
    const id = this.nextDaemonRequestId++;
    return new Promise((resolve) => {
      this.pings.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method: "ping", params: {} });
    });
  }

  /** Simulates a daemon that went away (SIGKILL): EOF on the child's stdin. */
  killDaemon(): void {
    this.toChild.end();
  }

  guardrail(): GuardrailState {
    return {
      stepsUsed: this.stepsUsed,
      maxSteps: this.config.maxSteps,
      actionsInStep: this.openStep === undefined ? 0 : this.actionsInStep,
      maxBatchActions: this.maxBatchActions,
      remainingMs: this.config.timeoutMs,
      aborted: this.aborted,
      unbounded: this.config.unbounded,
      bounds: this.config.bounds,
      planRevision: this.planRevision,
    };
  }

  private write(message: unknown): void {
    this.toChild.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.rawFromChild.push(line);
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: LoopPingResult;
      };
      if (message.method === undefined) {
        if (message.id !== undefined && message.result !== undefined) {
          this.pings.get(message.id)?.(message.result);
          this.pings.delete(message.id);
        }
        continue;
      }
      this.calls.order.push(message.method);
      try {
        const result = this.serve(message.method, message.params);
        if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, result });
      } catch (err) {
        const code = (err as { code?: string }).code ?? "INTERNAL_ERROR";
        if (message.id !== undefined) {
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: (err as Error).message, data: { code } },
          });
        }
      }
    }
  }

  private fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  private requireOpenStep(method: string): void {
    if (this.openStep === undefined) this.fail("NO_OPEN_STEP", `${method} outside an open step.`);
  }

  private serve(method: string, rawParams: unknown): unknown {
    const params = (rawParams ?? {}) as Record<string, never>;
    if (method !== "ready" && !this.started) this.fail("LOOP_NOT_STARTED", "ready must be first.");
    if (this.ended) this.fail("LOOP_ALREADY_ENDED", "The run already reported its result.");

    switch (method) {
      case "ready": {
        if (this.started) this.fail("LOOP_PROTOCOL_VIOLATION", "A second ready.");
        const version = (params as unknown as { loopProtocolVersion: number }).loopProtocolVersion;
        if (version !== LOOP_PROTOCOL_VERSION) {
          this.fail("LOOP_PROTOCOL_VERSION_MISMATCH", `Loop protocol ${version} is not supported.`);
        }
        this.started = true;
        this.calls.ready += 1;
        return this.config;
      }

      case "guardrailState":
        return this.guardrail();

      case "beginStep": {
        const index = (params as unknown as { index: number }).index;
        if (this.openStep !== undefined) this.fail("LOOP_PROTOCOL_VIOLATION", "Nested beginStep.");
        if (this.aborted) this.fail("OPERATOR_ABORTED", "The run was aborted.");
        if (index !== this.stepsUsed) {
          this.fail("STEP_INDEX_MISMATCH", `Expected index ${this.stepsUsed}, got ${index}.`);
        }
        if (index >= this.config.maxSteps) {
          this.fail("OPERATOR_MAX_STEPS_EXCEEDED", "The run exhausted its step budget.");
        }
        this.stepsUsed += 1;
        this.openStep = index;
        this.actionsInStep = 0;
        this.calls.beginStep.push(index);
        return { guardrail: this.guardrail() };
      }

      case "captureFrame": {
        this.requireOpenStep(method);
        this.calls.captureFrame += 1;
        this.options.onCaptureFrame?.();
        return { imageBase64: TINY_PNG_BASE64, width: 1920, height: 1080, scale: 2 };
      }

      case "enumerateTargets": {
        this.requireOpenStep(method);
        this.calls.enumerateTargets += 1;
        return { targets: [] };
      }

      case "performInput": {
        this.requireOpenStep(method);
        this.chargeAction();
        const actions = (params as unknown as { actions: InputAction[] }).actions;
        this.calls.performInput.push(actions);
        const overridden = this.options.onPerformInput?.(actions);
        return overridden ?? { performed: actions.length };
      }

      case "resizeWindow": {
        this.requireOpenStep(method);
        this.chargeAction();
        const { targetId, bounds } = params as unknown as { targetId: string; bounds: Rect };
        this.calls.resizeWindow.push({ targetId, bounds });
        this.options.onResizeWindow?.(targetId, bounds);
        return { actualBounds: bounds, result: "success" };
      }

      case "reportPlan": {
        this.requireOpenStep(method);
        const { steps, rationale } = params as unknown as { steps: string[]; rationale?: string };
        // The daemon owns plan *identity*; the child supplies only content.
        const revision = this.planRevision === undefined ? 0 : this.planRevision + 1;
        this.planRevision = revision;
        this.plan = {
          revision,
          steps,
          rationale,
          atStepIndex: this.openStep as number,
          tMs: 0,
        };
        this.calls.reportPlan.push({ steps, rationale, revision });
        return { accepted: true, revision };
      }

      case "reportStep": {
        const step = (params as unknown as { step: OperatorStep }).step;
        if (this.openStep === undefined) {
          this.fail("LOOP_PROTOCOL_VIOLATION", "reportStep with no open step.");
        }
        if (step.index !== this.openStep) {
          this.fail("STEP_INDEX_MISMATCH", `reportStep for ${step.index}, open ${this.openStep}.`);
        }
        this.openStep = undefined;
        this.actionsInStep = 0;
        this.calls.reportStep.push(step);
        return { accepted: true, guardrail: this.guardrail() };
      }

      case "reportResult": {
        this.ended = true;
        this.calls.reportResult.push(
          params as unknown as { state: string; summary?: string; error?: { code: string } },
        );
        return { accepted: true };
      }

      case "log": {
        this.calls.log.push(params as unknown as { level: string; message: string });
        return undefined;
      }

      default:
        this.fail("LOOP_PROTOCOL_VIOLATION", `Unknown child → daemon method "${method}".`);
    }
  }

  /** Per-action, on arrival — never once for the batch up front. */
  private chargeAction(): void {
    if (this.actionsInStep >= this.maxBatchActions) {
      this.fail(
        "OPERATOR_BATCH_LIMIT_EXCEEDED",
        `More than ${this.maxBatchActions} actions in one step.`,
      );
    }
    this.actionsInStep += 1;
  }
}
