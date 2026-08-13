import {
  type CaptureLockReport,
  DAEMON_PROTOCOL_VERSION,
  type DaemonIdentity,
  type DaemonReport,
  EXPECTED_SIDECAR_VERSION,
  type PermissionReport,
  type SidecarReport,
  WINDOWER_HOME_ENV,
  connectToDaemon,
  packageVersion,
  readConfig,
  readDaemonState,
  spawnSidecar as realSpawnSidecar,
  resolveSidecarBinaryPathWithSource,
  windowerHome,
} from "@windower/core";
import {
  type CaptureHold,
  CaptureLock,
  ScreenCaptureBusyError,
  SessionStore,
  type SidecarFactory,
  type SidecarHandle,
  captureLockPath,
  ensureWritableOutputDir,
} from "@windower/engine";
import type { Command } from "commander";
import { printResult } from "../output.js";

/** `hello`/`daemon_info`'s `clientName` convention (`data-model.md`'s `DaemonHelloRequest` doc). */
const CLIENT_NAME = "windower-cli";

/**
 * Diagnostic view of `~/.windower/capture.lock`
 * (`contracts/screen-capture-exclusivity.md` §Lock file). Purely a *report* of
 * what the mutex looked like while `doctor` ran — it is not a new coordination
 * object, carries no state of its own, and nothing branches on it.
 *
 * `CaptureLockReport` is defined in `packages/core` and carried on
 * `PermissionReportSchema` itself, per `data-model.md`: there is deliberately
 * no sibling `DoctorReport` type, and keeping the field on the one report
 * schema is what keeps `doctor --json` schema-validated rather than merely
 * schema-tolerated.
 */
export type DoctorReport = PermissionReport;

export interface DoctorProbeOptions {
  /** Injectable for tests — defaults to `@windower/core`'s real `spawnSidecar`. */
  spawnSidecar?: SidecarFactory;
  /** Bounded-wait budget override for the capture lock; defaults to `CaptureLock`'s. */
  captureWaitMs?: number;
}

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
 *
 * Phase 21: the capture-surface probe goes through `~/.windower/capture.lock`
 * (`contracts/screen-capture-exclusivity.md` §Acquire-or-wait) like every
 * other capture caller — a `doctor` run during a live recording must never be
 * a second ScreenCaptureKit process. A busy lock is a *diagnostic*, not a
 * crash: the capture-derived fields go unknown, the report is otherwise
 * intact, and `captureLock` names the holder. The control surface is probed
 * separately and takes **no** lock (§What never takes this lock).
 */
export async function buildDoctorReport(options: DoctorProbeOptions = {}): Promise<DoctorReport> {
  const spawnSidecar = options.spawnSidecar ?? realSpawnSidecar;
  const [capture, controlPermissions, daemon, config] = await Promise.all([
    probeCaptureSurface(spawnSidecar, options.captureWaitMs),
    probeControlSurface(spawnSidecar),
    probeDaemon(),
    readConfig().catch(() => undefined),
  ]);
  const sidecar = capture.sidecar;

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

  const activeSessions = await countActiveSessions();

  const report: DoctorReport = {
    // Merged capture + control view. `getPermissions` lives on BOTH surfaces
    // and each reports only its own kinds — capture: `screenRecording`/
    // `microphone`, control: `accessibility` (`contracts/sidecar-protocol.md`
    // §Method-ownership surfaces) — so a caller holding both connections
    // merges the two. An absent kind is **unknown, not denied**, which is
    // exactly what `"not_determined"` means here; no gap ever falls back to
    // `"denied"`.
    screenRecording: capture.permissions.screenRecording ?? "not_determined",
    accessibility:
      controlPermissions.accessibility ?? capture.permissions.accessibility ?? "not_determined",
    microphone: capture.permissions.microphone ?? "not_determined",
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
    captureLock: capture.lock,
  };
  return report;
}

interface CaptureSurfaceProbe {
  sidecar: SidecarReport;
  /** Capture-owned kinds only; an absent kind is unknown, never denied. */
  permissions: Partial<PermissionReport>;
  lock: CaptureLockReport;
}

/**
 * The single capture-surface probe: `describe()` + `getPermissions()` under
 * **one** hold of `~/.windower/capture.lock`, i.e. one capture process for the
 * whole command (it used to be two unlocked ones).
 *
 * The acquire-or-wait table is `CaptureLock`'s, unchanged: reuse this
 * process's capture sidecar if it somehow has one, else acquire and spawn,
 * else wait bounded, else `SCREEN_CAPTURE_BUSY` — and a holder from a foreign
 * `windowerHome` fails immediately. `doctor` never routes to the holder,
 * never steals a live lock, and never spawns a second ScreenCaptureKit
 * process; a busy lock simply becomes a diagnostic. Never throws.
 */
async function probeCaptureSurface(
  spawnSidecar: SidecarFactory,
  waitMs: number | undefined,
): Promise<CaptureSurfaceProbe> {
  let resolvedPath: string | undefined;
  let source: SidecarReport["source"];
  try {
    const resolved = resolveSidecarBinaryPathWithSource("capture");
    resolvedPath = resolved.path;
    source = resolved.source;
  } catch {
    // No binary resolvable for this platform/arch at all.
  }

  const sidecar: SidecarReport = {
    available: false,
    resolvedPath,
    source,
    expectedVersion: EXPECTED_SIDECAR_VERSION,
  };
  const free: CaptureLockReport = { path: captureLockPath(), held: false, busy: false };
  if (!resolvedPath) return { sidecar, permissions: {}, lock: free };

  const lock = new CaptureLock({
    spawnSidecar,
    ...(waitMs !== undefined ? { waitMs } : {}),
    // `doctor` renders its own diagnostics; a stray `[CaptureLock] …` line on
    // stderr would just be noise next to the report.
    onLog: () => {},
  });

  let hold: CaptureHold;
  try {
    hold = await lock.acquireCaptureHold({
      // `surface: "capture"` is explicit even though `binaryPath` already
      // pins the file: `SpawnSidecarOptions.surface` silently defaults to
      // `"capture"`, and a spawn whose surface is only implied is exactly the
      // shape of the bug this probe used to have.
      spawn: { surface: "capture", binaryPath: resolvedPath },
    });
  } catch (err) {
    if (err instanceof ScreenCaptureBusyError) {
      return { sidecar, permissions: {}, lock: busyLockReport(err) };
    }
    // Spawn failure (missing/unrunnable binary) — the lock is already
    // released by `CaptureLock`; report the surface as unavailable.
    return { sidecar, permissions: {}, lock: free };
  }

  try {
    const describeResult = await hold.client.describe();
    const permissions = await hold.client
      .getPermissions()
      .catch(() => ({}) as Partial<PermissionReport>);
    return {
      sidecar: { ...sidecar, available: true, version: describeResult.version },
      permissions,
      lock: free,
    };
  } catch {
    return { sidecar, permissions: {}, lock: free };
  } finally {
    await hold.release().catch(() => {});
  }
}

function busyLockReport(err: ScreenCaptureBusyError): CaptureLockReport {
  return {
    path: captureLockPath(),
    held: true,
    busy: true,
    pid: err.holder?.pid,
    acquiredAt: err.holder?.acquiredAt,
    windowerHome: err.holder?.windowerHome,
    message: err.message,
  };
}

/**
 * Control-surface probe — the only source of a real `accessibility` status,
 * which `performInput`/`resizeWindow` need and the capture surface cannot
 * answer for (`contracts/sidecar-protocol.md` §Method-ownership surfaces).
 *
 * Takes **no** capture lock and is deliberately not serialized against one:
 * control spawns touch no ScreenCaptureKit state, and locking them would
 * reintroduce the coupling Phase 21 deletes
 * (`contracts/screen-capture-exclusivity.md` §What never takes this lock).
 * Never throws — an unreachable control surface leaves `accessibility`
 * unknown, not denied.
 */
async function probeControlSurface(
  spawnSidecar: SidecarFactory,
): Promise<Partial<PermissionReport>> {
  let handle: SidecarHandle;
  try {
    const resolvedPath = resolveSidecarBinaryPathWithSource("control").path;
    handle = spawnSidecar({ surface: "control", binaryPath: resolvedPath });
  } catch {
    // No control binary for this platform, or it could not be spawned.
    return {};
  }

  try {
    return await handle.client.getPermissions();
  } catch {
    return {};
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

export function renderReport(report: DoctorReport): string {
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
  renderCaptureLockSection(lines, report);

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
  if (report.activeSessions !== undefined) {
    lines.push(`  Active sessions: ${report.activeSessions ?? 0}`);
  }

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

/**
 * Only rendered when the capture surface was actually unreachable because
 * another live process owned it — the diagnosis a user runs `doctor` to get.
 * A free lock is the normal case and prints nothing.
 */
function renderCaptureLockSection(lines: string[], report: DoctorReport): void {
  const lock = report.captureLock;
  if (!lock?.busy) return;

  const holder = lock.pid !== undefined ? `pid ${lock.pid}` : "another process";
  const acquired = lock.acquiredAt ? `, acquired ${lock.acquiredAt}` : "";
  lines.push(`  ⚠ Screen capture busy: held by ${holder}${acquired} — ${lock.path}`);
  const ownHome = report.windowerHome?.path;
  if (lock.windowerHome && ownHome && lock.windowerHome !== ownHome) {
    lines.push(
      `      holder's WINDOWER_HOME is ${lock.windowerHome}, this process resolved ${ownHome} — run both callers through the same home`,
    );
  }
  lines.push(
    "      Screen Recording, Microphone and the sidecar version could not be checked (unknown, not denied); " +
      "no second screen-capture process was started. Stop the holding recording and re-run `windower doctor`.",
  );
}
