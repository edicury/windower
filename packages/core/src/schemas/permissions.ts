import { z } from "zod";

/**
 * PermissionStatus / PermissionReport — used by `doctor` / `check_permissions`.
 * See data-model.md §Permission state.
 */
export const PermissionStatusSchema = z.enum([
  "granted",
  "denied",
  "not_determined",
  "not_applicable",
]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

/**
 * Phase 20 additions — all optional so an older client parsing a response
 * written by a pre-Phase-20 daemon (or vice versa) still succeeds. A field
 * being absent means "reporter predates this field," not "false"/"unknown."
 * See `data-model.md` §PermissionReport for the field-level source of truth.
 */
export const DaemonReportSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().optional(),
  version: z.string().optional(),
  protocolVersion: z.number().int().optional(),
  /** ISO 8601, from daemon.json. */
  startedAt: z.string().optional(),
  /** Derived: now - startedAt, computed by the reporter. */
  ageSeconds: z.number().optional(),
  socketPath: z.string().optional(),
  /** daemon.version === client.version. */
  versionMatchesClient: z.boolean().optional(),
});
export type DaemonReport = z.infer<typeof DaemonReportSchema>;

export const ClientReportSchema = z.object({
  /** e.g. "windower-cli" | "windower-mcp-server". */
  name: z.string(),
  version: z.string(),
  protocolVersion: z.number().int(),
});
export type ClientReport = z.infer<typeof ClientReportSchema>;

export const SidecarReportSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  resolvedPath: z.string().optional(),
  source: z.enum(["env-override", "dev-build", "npm-package"]).optional(),
  expectedVersion: z.string().optional(),
});
export type SidecarReport = z.infer<typeof SidecarReportSchema>;

export const WindowerHomeReportSchema = z.object({
  path: z.string(),
  /** true if WINDOWER_HOME was set, false if defaulted. */
  fromEnvOverride: z.boolean(),
});
export type WindowerHomeReport = z.infer<typeof WindowerHomeReportSchema>;

export const OutputDirReportSchema = z.object({
  path: z.string(),
  writable: z.boolean(),
});
export type OutputDirReport = z.infer<typeof OutputDirReportSchema>;

/** API-key env var presence only — booleans, never values. */
export const ApiKeyEnvVarReportSchema = z.object({
  name: z.string(),
  presentInClient: z.boolean(),
  /** false/omitted-effectively-false when no daemon is running. */
  presentInDaemon: z.boolean(),
});
export type ApiKeyEnvVarReport = z.infer<typeof ApiKeyEnvVarReportSchema>;

/**
 * ScreenCaptureKit exclusivity diagnostics for `doctor`
 * (`contracts/screen-capture-exclusivity.md`).
 *
 * This is a *diagnostic*, not a permission — it lives here because `doctor`'s
 * report is a `PermissionReport` plus optional fields, per `data-model.md`
 * (there is deliberately no sibling `DoctorReport` type). Carrying it here is
 * what keeps `doctor --json` schema-validated.
 *
 * It records only what the lock file already says. It is NOT a routing or
 * discovery mechanism: `doctor` never connects to the holder, never steals a
 * live lock, and never spawns a second ScreenCaptureKit process.
 */
export const CaptureLockReportSchema = z.object({
  /** `~/.windower/capture.lock`, resolved against this process's `WINDOWER_HOME`. */
  path: z.string(),
  /** Another live process held the lock while `doctor` ran. */
  held: z.boolean(),
  /**
   * `doctor` could not probe the capture surface because of that holder, so
   * the capture-derived fields are **unknown, not denied**.
   */
  busy: z.boolean(),
  /** Holder identity — diagnostics only, verbatim from the lock payload. */
  pid: z.number().optional(),
  acquiredAt: z.string().optional(),
  windowerHome: z.string().optional(),
  /** The `SCREEN_CAPTURE_BUSY` message, verbatim. */
  message: z.string().optional(),
});
export type CaptureLockReport = z.infer<typeof CaptureLockReportSchema>;

export const PermissionReportSchema = z.object({
  screenRecording: PermissionStatusSchema,
  accessibility: PermissionStatusSchema,
  microphone: PermissionStatusSchema,
  daemonRunning: z.boolean(),
  sidecarAvailable: z.boolean(),
  sidecarVersion: z.string().optional(),

  // Phase 20 additions — see data-model.md.
  daemon: DaemonReportSchema.optional(),
  client: ClientReportSchema.optional(),
  sidecar: SidecarReportSchema.optional(),
  windowerHome: WindowerHomeReportSchema.optional(),
  outputDir: OutputDirReportSchema.optional(),
  activeSessions: z.number().optional(),
  activeRuns: z.number().optional(),
  apiKeyEnvVars: z.array(ApiKeyEnvVarReportSchema).optional(),

  // Phase 21 addition — see data-model.md.
  captureLock: CaptureLockReportSchema.optional(),
});
export type PermissionReport = z.infer<typeof PermissionReportSchema>;
