// Engine seam (FR-ADOPT-02): everything engine-specific that render, snapshots and doctor need.
import type {CheckResult} from '../lib.js';

export type EngineName = 'framekit';

export interface RunResult {
  ok: boolean;
  tail: string;
  /** Windower-scheme exit code of the engine process (0 on success). */
  exitCode?: number;
}

export interface SelectOptions {
  serveUrl: string;
  port: number;
  id: string;
  inputProps: Record<string, unknown>;
}

export interface StillOptions {
  composition: unknown;
  serveUrl: string;
  port: number;
  output: string;
  frame: number;
  inputProps: Record<string, unknown>;
}

export interface MediaOptions {
  id: string;
  output: string;
  port: number;
  propsFile?: string;
  extraArgs?: string[];
}

export interface Engine {
  name: EngineName;
  licenseNote: string;
  /** Returns a problem message when the engine's dependencies are missing, else undefined. */
  precheck(): string | undefined;
  /** Bundles the template entry point and returns the serve URL. */
  bundle(entryPoint: string): Promise<string>;
  selectComposition(opts: SelectOptions): Promise<unknown>;
  renderStill(opts: StillOptions): Promise<void>;
  /** Renders a composition to a media file (retry once, stderr tail on failure). */
  renderMedia(opts: MediaOptions): RunResult;
  /** Runs the engine CLI with raw arguments (retry once, stderr tail on failure). */
  run(args: string[]): RunResult;
  /** Engine-specific doctor checks. */
  doctorChecks(): CheckResult[];
}
