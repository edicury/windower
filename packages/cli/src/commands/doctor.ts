import {
  type ApiKeyEnvVarReport,
  DAEMON_PROTOCOL_VERSION,
  type DaemonIdentity,
  type DaemonReport,
  EXPECTED_SIDECAR_VERSION,
  type PermissionReport,
  type PermissionStatus,
  type SidecarReport,
  WINDOWER_HOME_ENV,
  connectToDaemon,
  isTerminalOperatorRunState,
  packageVersion,
  readConfig,
  readDaemonState,
  readRawConfig,
  resolveSidecarBinaryPathWithSource,
  spawnSidecar,
  windowerHome,
} from "@windower/core";
import { OperatorRunStore, SessionStore, ensureWritableOutputDir } from "@windower/engine";
import type { Command } from "commander";
import { printResult } from "../output.js";

/** `hello`/`daemon_info`'s `clientName` convention (`data-model.md`'s `DaemonHelloRequest` doc). */
const CLIENT_NAME = "windower-cli";

/**
 * Provider API-key env vars `doctor` always checks, per `contracts/cli.md`'s
 * `doctor` report shape. The user's configured `operator.apiKeyEnvVar` (from
 * `~/.windower/config.json`) is appended to this list, deduplicated, if set.
 */
const DEFAULT_API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
];

/** `windower doctor [--json]` — PermissionReport + daemon/sidecar/environment health, read-only, never prompts. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Report permission and daemon/sidecar/environment health (read-only, never triggers a prompt)",
    )
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      const report = await buildDoctorReport();
      printResult(json, report, renderReport);
    });
}

/**
 * Assembles the full `PermissionReport` entirely `local` — per
 * `contracts/cli.md`'s Daemon policy, `doctor` never starts, contacts (in
 * the auto-spawn sense), or requires a daemon. It spawns its own transient
 * sidecar for permission/version info (same one-shot pattern
 * `PassthroughService` uses for `list_targets`/etc — kept inline here
 * instead of routed through `PassthroughService.checkPermissions()` because
 * that method still hardcodes `daemonRunning: true`, exactly the
 * tautological bug this rewrite exists to fix) and only *probes* an
 * already-running daemon via `readDaemonState()` + a live RPC, never
 * spawning one.
 */
export async function buildDoctorReport(): Promise<PermissionReport> {
  const [sidecar, permissions, daemon, config, rawConfig] = await Promise.all([
    probeSidecar(),
    probeSidecarPermissions(),
    probeDaemon(),
    readConfig().catch(() => undefined),
    readRawConfig().catch(() => undefined),
  ]);

  const client = {
    name: CLIENT_NAME,
    version: packageVersion(import.meta.url),
    protocolVersion: DAEMON_PROTOCOL_VERSION,
  };

  const homeOverride = process.env[WINDOWER_HOME_ENV];
  const windowerHomeReport = {
    path: windowerHome(),
    fromEnvOverride: Boolean(homeOverride && homeOverride.trim().length > 0),
  };

  const outputDirPath = config?.outputDir ?? windowerHome();
  let outputDirWritable = false;
  try {
    await ensureWritableOutputDir(outputDirPath);
    outputDirWritable = true;
  } catch {
    outputDirWritable = false;
  }

  const [activeSessions, activeRuns] = await Promise.all([
    countActiveSessions(),
    countActiveRuns(),
  ]);

  const apiKeyEnvVars = buildApiKeyEnvVarsReport(rawConfig?.operator?.apiKeyEnvVar);

  const report: PermissionReport = {
    screenRecording: permissions.screenRecording,
    accessibility: permissions.accessibility,
    microphone: permissions.microphone,
    // Legacy top-level fields, kept for backward compat — mirror the new
    // nested `daemon`/`sidecar` blocks below rather than being independently
    // tautological (this is the exact bug phase-20 exists to fix:
    // `daemonRunning` used to be hardcoded `true` because "if you got a
    // response, it was true").
    daemonRunning: daemon.running,
    sidecarAvailable: sidecar.available,
    sidecarVersion: sidecar.version,
    daemon,
    client,
    sidecar,
    windowerHome: windowerHomeReport,
    outputDir: { path: outputDirPath, writable: outputDirWritable },
    activeSessions,
    activeRuns,
    apiKeyEnvVars,
  };
  return report;
}

interface SidecarPermissions {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
  microphone: PermissionStatus;
}

/** Spawns a one-shot transient sidecar, calls `describe()`, and reports version/path/availability — never throws. */
async function probeSidecar(): Promise<SidecarReport> {
  let resolvedPath: string | undefined;
  let source: SidecarReport["source"];
  try {
    const resolved = resolveSidecarBinaryPathWithSource();
    resolvedPath = resolved.path;
    source = resolved.source;
  } catch {
    // No binary resolvable for this platform/arch at all.
  }

  if (!resolvedPath) {
    return { available: false, resolvedPath, source, expectedVersion: EXPECTED_SIDECAR_VERSION };
  }

  const handle = spawnSidecar({ binaryPath: resolvedPath });
  try {
    const describeResult = await handle.client.describe();
    return {
      available: true,
      version: describeResult.version,
      resolvedPath,
      source,
      expectedVersion: EXPECTED_SIDECAR_VERSION,
    };
  } catch {
    return { available: false, resolvedPath, source, expectedVersion: EXPECTED_SIDECAR_VERSION };
  } finally {
    await handle.terminate().catch(() => {});
  }
}

/** Spawns its own one-shot transient sidecar to read permission status — never throws (unknown on failure). */
async function probeSidecarPermissions(): Promise<SidecarPermissions> {
  const fallback: SidecarPermissions = {
    screenRecording: "not_determined",
    accessibility: "not_determined",
    microphone: "not_determined",
  };
  let resolvedPath: string | undefined;
  try {
    resolvedPath = resolveSidecarBinaryPathWithSource().path;
  } catch {
    return fallback;
  }

  const handle = spawnSidecar({ binaryPath: resolvedPath });
  try {
    const partial = await handle.client.getPermissions();
    return {
      screenRecording: partial.screenRecording ?? "not_determined",
      accessibility: partial.accessibility ?? "not_determined",
      microphone: partial.microphone ?? "not_determined",
    };
  } catch {
    return fallback;
  } finally {
    await handle.terminate().catch(() => {});
  }
}

/** `process.kill(pid, 0)` liveness check — mirrors `connect.ts`'s private `isPidAlive`. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Probes an already-running daemon without ever spawning one:
 * 1. `readDaemonState()` — fast, no connection. Absent state file -> not
 *    running.
 * 2. If present, verify the recorded pid is actually alive — a stale
 *    `daemon.json` from a crashed daemon must NOT be reported as running.
 * 3. If alive, attempt a live `daemon_info` RPC for the authoritative
 *    identity, falling back to the state-file data if the socket doesn't
 *    answer (daemon.json present + pid alive but socket unresponsive is
 *    itself useful diagnostic info, not a crash).
 */
async function probeDaemon(): Promise<DaemonReport> {
  const state = await readDaemonState();
  if (!state) {
    return { running: false };
  }
  if (!isPidAlive(state.pid)) {
    // Stale state file from a crashed daemon — not running.
    return { running: false };
  }

  const clientVersion = packageVersion(import.meta.url);

  try {
    const client = await connectToDaemon(state.socketPath);
    try {
      const identity = await client.daemonInfo();
      return daemonReportFromIdentity(identity, clientVersion);
    } finally {
      client.dispose();
    }
  } catch {
    // Pid alive, state file present, but the socket didn't answer — report
    // what we know from disk rather than failing the whole command.
    return daemonReportFromIdentity(state, clientVersion);
  }
}

function daemonReportFromIdentity(identity: DaemonIdentity, clientVersion: string): DaemonReport {
  const ageSeconds = Math.max(0, (Date.now() - new Date(identity.startedAt).getTime()) / 1000);
  return {
    running: true,
    pid: identity.pid,
    version: identity.version,
    protocolVersion: identity.protocolVersion,
    startedAt: identity.startedAt,
    ageSeconds,
    socketPath: identity.socketPath,
    versionMatchesClient: identity.version === clientVersion,
  };
}

const ACTIVE_SESSION_STATES = new Set(["pending", "recording", "stopping"]);

async function countActiveSessions(): Promise<number> {
  try {
    const store = new SessionStore();
    const sessions = await store.load();
    return sessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state)).length;
  } catch {
    return 0;
  }
}

async function countActiveRuns(): Promise<number> {
  try {
    const store = new OperatorRunStore();
    const runs = await store.load();
    return runs.filter((r) => !isTerminalOperatorRunState(r.state)).length;
  } catch {
    return 0;
  }
}

/**
 * `presentInClient` is a direct `process.env` read on this CLI process —
 * always accurate. `presentInDaemon` is a known gap as of Phase 20: the
 * daemon's `hello`/`daemon_info` RPCs (`data-model.md`'s `DaemonInfo`) carry
 * identity only, not env-var presence — there is currently no RPC that lets
 * a probing client ask a running daemon "do you see env var X?" without
 * sending a `hello` env snapshot (which is opt-in, secret-carrying, and
 * deliberately never populated by a read-only command like `doctor`).
 * Rather than fabricate an answer, this reports `presentInDaemon: false`
 * whenever it cannot be verified live — which is honest ("we don't know" and
 * "not running" both collapse to `false` today) but means a real `true`
 * case in the daemon can currently only ever be under-reported, never
 * over-reported. Closing this gap needs a small new daemon-side capability
 * (e.g. a `presentEnvVars` field on `daemon_info`) — left as a follow-up,
 * not invented here since it would mean touching the frozen `DaemonInfo`
 * contract shape.
 */
function buildApiKeyEnvVarsReport(
  configuredApiKeyEnvVar: string | undefined,
): ApiKeyEnvVarReport[] {
  const names = [...DEFAULT_API_KEY_ENV_VARS];
  if (configuredApiKeyEnvVar && !names.includes(configuredApiKeyEnvVar)) {
    names.push(configuredApiKeyEnvVar);
  }
  return names.map((name) => ({
    name,
    presentInClient: Boolean(process.env[name]),
    presentInDaemon: false,
  }));
}

function checkbox(ok: boolean): string {
  return ok ? "[x]" : "[ ]";
}

const PERMISSION_HINTS: Array<{
  key: "screenRecording" | "accessibility" | "microphone";
  label: string;
}> = [
  { key: "screenRecording", label: "Screen Recording" },
  { key: "accessibility", label: "Accessibility" },
  { key: "microphone", label: "Microphone" },
];

export function renderReport(report: PermissionReport): string {
  const lines = ["windower doctor"];
  for (const { key, label } of PERMISSION_HINTS) {
    const status = report[key];
    lines.push(`  ${checkbox(status === "granted")} ${label}: ${status}`);
    if (status !== "granted" && status !== "not_applicable") {
      lines.push(`      → run \`windower permission request ${key}\` to grant it`);
    }
  }

  renderDaemonSection(lines, report);
  renderSidecarSection(lines, report);

  if (report.client) {
    lines.push(
      `  Client: ${report.client.name} v${report.client.version} (protocol v${report.client.protocolVersion})`,
    );
  }
  if (report.windowerHome) {
    lines.push(
      `  WINDOWER_HOME: ${report.windowerHome.path}${
        report.windowerHome.fromEnvOverride ? " (from WINDOWER_HOME override)" : ""
      }`,
    );
  }
  if (report.outputDir) {
    lines.push(
      `  ${checkbox(report.outputDir.writable)} Output directory: ${report.outputDir.path}${
        report.outputDir.writable ? "" : " (not writable)"
      }`,
    );
  }
  if (report.activeSessions !== undefined || report.activeRuns !== undefined) {
    lines.push(
      `  Active sessions: ${report.activeSessions ?? 0}, active operator runs: ${report.activeRuns ?? 0}`,
    );
  }

  renderApiKeySection(lines, report);

  return lines.join("\n");
}

function renderDaemonSection(lines: string[], report: PermissionReport): void {
  const daemon = report.daemon;
  lines.push(`  ${checkbox(report.daemonRunning)} Daemon running`);
  if (!daemon || !daemon.running) return;

  const parts = [
    daemon.pid !== undefined ? `pid ${daemon.pid}` : undefined,
    daemon.version !== undefined ? `v${daemon.version}` : undefined,
    daemon.protocolVersion !== undefined ? `protocol v${daemon.protocolVersion}` : undefined,
    daemon.ageSeconds !== undefined ? `up ${Math.round(daemon.ageSeconds)}s` : undefined,
  ].filter((p): p is string => p !== undefined);
  if (parts.length > 0) {
    lines.push(`      ${parts.join(", ")}`);
  }
  if (daemon.versionMatchesClient === false) {
    lines.push(
      "      ⚠ this daemon's version does not match the invoking CLI's — run `windower daemon restart`",
    );
  }
}

function renderSidecarSection(lines: string[], report: PermissionReport): void {
  const versionMismatch =
    report.sidecarVersion !== undefined && report.sidecarVersion !== EXPECTED_SIDECAR_VERSION;
  lines.push(
    `  ${checkbox(report.sidecarAvailable)} Sidecar available${
      report.sidecarVersion ? ` (v${report.sidecarVersion})` : ""
    }`,
  );
  if (report.sidecar?.resolvedPath) {
    lines.push(
      `      ${report.sidecar.resolvedPath} (${report.sidecar.source ?? "unknown source"})`,
    );
  }
  if (versionMismatch) {
    lines.push(
      `      ⚠ version mismatch: this CLI expects v${EXPECTED_SIDECAR_VERSION} — reinstall/rebuild the sidecar to match, or you may see confusing protocol errors`,
    );
  }
}

function renderApiKeySection(lines: string[], report: PermissionReport): void {
  if (!report.apiKeyEnvVars || report.apiKeyEnvVars.length === 0) return;
  lines.push("  API key env vars (presence only, values never shown):");
  for (const entry of report.apiKeyEnvVars) {
    lines.push(
      `      ${entry.name}: present in CLI: ${entry.presentInClient ? "yes" : "no"} / ` +
        `present in daemon: ${entry.presentInDaemon ? "yes" : "no"}`,
    );
  }
  if (report.daemonRunning) {
    lines.push(
      '      note: "present in daemon" cannot currently be verified live (no RPC exposes env-var ' +
        'presence) and is reported as "no" whenever unverified — a real `yes` in the daemon can be ' +
        "under-reported here, never over-reported.",
    );
  }
}
