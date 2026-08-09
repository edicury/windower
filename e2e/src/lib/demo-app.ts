import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveDemoAppBinaryPath } from "./paths.js";

const execFileAsync = promisify(execFile);

/**
 * Fixed contract from fixtures/demo-app/README.md — do not infer these from
 * the running app, they are frozen by design so the e2e harness can assert
 * exact coordinates without any fuzzy geometry probing.
 */
export const DEMO_APP_TITLE = "Windower Demo App";

export const DEMO_APP_INITIAL_FRAME = {
  // AppKit screen coordinates, points, bottom-left origin.
  origin: { x: 200, y: 200 },
  size: { width: 900, height: 700 },
};

export const DEMO_APP_BUTTONS = ["demo-btn-1", "demo-btn-2", "demo-btn-3"] as const;
export type DemoAppButton = (typeof DEMO_APP_BUTTONS)[number];

/** Content-view point centers (bottom-left origin), per fixtures/demo-app/README.md. */
export const DEMO_APP_BUTTON_CENTERS: Record<DemoAppButton, { x: number; y: number }> = {
  "demo-btn-1": { x: 150, y: 150 },
  "demo-btn-2": { x: 450, y: 150 },
  "demo-btn-3": { x: 750, y: 150 },
};

export const DEMO_APP_BUTTON_SIZE = { width: 100, height: 50 };

export interface DemoAppClickLogEntry {
  button: DemoAppButton;
  seq: number;
  clickedAt: string;
}

export interface LaunchedDemoApp {
  proc: ChildProcess;
  pid: number;
  logPath: string;
  /** Sends SIGTERM (there is no in-app quit affordance — see fixtures README). */
  kill(): void;
}

const WINDOW_READY_RE = /^WINDOW_READY pid=(\d+) title="([^"]*)"/m;

/**
 * Launches the demo-app fixture and waits for its `WINDOW_READY` stdout
 * line before resolving, per fixtures/demo-app/README.md's "Startup signal"
 * section ("window enumeration attempted before this line is not
 * guaranteed to see the window").
 */
export async function launchDemoApp(options: {
  logPath: string;
  readyTimeoutMs?: number;
}): Promise<LaunchedDemoApp> {
  const binaryPath = resolveDemoAppBinaryPath();
  const proc = spawn(binaryPath, [], {
    env: { ...process.env, WINDOWER_DEMO_LOG: options.logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `demo-app did not print WINDOW_READY within ${readyTimeoutMs}ms.\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, readyTimeoutMs);

    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      if (WINDOW_READY_RE.test(stdout)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(`demo-app exited early (code=${code}) before WINDOW_READY.\nstderr: ${stderr}`),
      );
    };

    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
    }

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.once("error", onError);
    proc.once("exit", onExit);
  });

  if (proc.pid === undefined) {
    throw new Error("demo-app spawned without a pid");
  }

  return {
    proc,
    pid: proc.pid,
    logPath: options.logPath,
    kill: () => proc.kill("SIGTERM"),
  };
}

/** Reads and parses every JSONL line in the demo-app's click log so far. */
export async function readClickLog(logPath: string): Promise<DemoAppClickLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DemoAppClickLogEntry);
}

/**
 * ## Coordinate-space note
 *
 * fixtures/demo-app/README.md is explicit that converting from
 * "content-view points, bottom-left origin" to "windower pixels, top-left
 * origin" is the e2e harness's job, not the fixture's. This function does
 * that conversion for the purpose of driving a synthetic click at the
 * screen-pixel location AppKit would report for a given button center.
 *
 * Inputs:
 * - `windowBoundsPx`: the *whole window's* bounds in windower pixels
 *   (top-left origin) — i.e. exactly what `list_targets`/`resize_window`
 *   return for this window, post-resize.
 * - `scaleFactor`: the display's Retina scale factor (points -> pixels),
 *   from the `display` target windower reports this window's display as.
 *
 * ## Known approximation: title bar height
 * AppKit doesn't expose a window's title-bar height through any value this
 * harness has access to over the windower protocol (windower reports whole
 * *window* bounds, not content-view bounds — see
 * contracts/sidecar-protocol.md's `CaptureTarget`). Standard macOS
 * `.titled` windows without a unified/full-size-content-view toolbar use a
 * fixed **28pt** title bar on every currently supported macOS version; the
 * demo-app fixture does not opt into full-size content view, so this
 * constant applies. Override via `WINDOWER_DEMO_TITLEBAR_PT` if a future
 * macOS version changes it.
 *
 * Because each button is 100x50pt with its center 300pt from its neighbors,
 * a few points of title-bar error does not risk landing outside the
 * button — this conversion only needs to be "close enough to hit the
 * button", not pixel-exact.
 */
export function buttonCenterToScreenPixel(
  button: DemoAppButton,
  windowBoundsPx: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
): { x: number; y: number } {
  const titleBarPt = Number(process.env.WINDOWER_DEMO_TITLEBAR_PT ?? 28);
  const center = DEMO_APP_BUTTON_CENTERS[button];

  // content-view point -> window-relative point (flip Y: AppKit content
  // view is bottom-left origin, we need top-left-origin-from-window-top).
  const contentHeightPt = DEMO_APP_INITIAL_FRAME.size.height - titleBarPt;
  const windowRelXPt = center.x;
  const windowRelYPt = titleBarPt + (contentHeightPt - center.y);

  // window-relative point -> window-relative pixel (scale factor).
  const windowRelXPx = windowRelXPt * scaleFactor;
  const windowRelYPx = windowRelYPt * scaleFactor;

  return {
    x: windowBoundsPx.x + windowRelXPx,
    y: windowBoundsPx.y + windowRelYPx,
  };
}

/**
 * ## Click-driving choice: synthetic CGEvent clicks via `osascript`/System
 * Events, not manual human clicks.
 *
 * Considered both options the task explicitly calls out. Manual clicking
 * (a human/CI runner clicking within a time window) is strictly less
 * deterministic: it depends on a person being present and attentive at
 * exactly the right point in an automated test run, its timing can't be
 * bounded tightly, and it can't be scripted into a CI-adjacent "run this
 * locally" command a future contributor just executes. Synthetic clicks
 * via `osascript -e 'tell application "System Events" to click at {x, y}'`
 * need no GUI-scripting binary beyond what ships with macOS (`osascript`),
 * require no additional Homebrew dependency (ruled out `cliclick` for that
 * reason), and are exactly reproducible run to run. `System Events`
 * requires the same Accessibility grant this suite already needs for
 * window resize, so it adds no new TCC prerequisite.
 */
export async function synthesizeClick(x: number, y: number): Promise<void> {
  const script = `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`;
  await execFileAsync("osascript", ["-e", script]);
}
