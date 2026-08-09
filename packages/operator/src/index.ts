/**
 * @windower/operator — the observe → decide → act loop behind
 * `windower operate` / `run_operator` (Phase 19, contracts/operator.md).
 *
 * The daemon owns sidecar RPC, secret resolution, and run persistence and
 * calls into `runOperator(options, deps)`; this package owns the loop, the
 * closed tool surface, guardrail enforcement, secret substitution, redaction,
 * and the `<recording>.operator.json` transcript.
 *
 * Nothing here branches on the host OS — the loop only ever speaks
 * `OperatorDeps`, i.e. sidecar protocol methods (CLAUDE.md §protocol before
 * platform).
 */

export const OPERATOR_PACKAGE_NAME = "@windower/operator";

export { runOperator, type OperatorRunInternals } from "./run.js";
export {
  OPERATOR_TOOL_NAMES,
  ToolInputSchemas,
  buildToolSet,
  isOperatorToolName,
  type OperatorToolName,
  type ToolInput,
} from "./tools.js";
export {
  PROVIDER_REGISTRY,
  knownProviders,
  resolveModel,
  type ProviderEntry,
} from "./providers.js";
export {
  OPERATOR_ERROR_CODES,
  OperatorError,
  type OperatorErrorCode,
} from "./errors.js";
export {
  REDACTION_MARKER,
  createRedactedLogger,
  createRedactor,
  type LogSink,
  type RedactedLogger,
  type Redactor,
} from "./redaction.js";
export { placeholderToken, referencedPlaceholders, substituteSecrets } from "./secrets.js";
export {
  Deadline,
  MAX_WAIT_MS,
  assertWithinBounds,
  isWithinBounds,
  type BoundsPolicy,
} from "./guardrails.js";
export {
  createNullTranscriptWriter,
  createTranscriptWriter,
  framesDirFor,
  hashFrame,
  type TranscriptWriter,
} from "./transcript.js";
export { buildSystemPrompt } from "./prompt.js";
