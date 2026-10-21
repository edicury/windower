import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, statSync, statfsSync} from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

export const EXIT = {
  ok: 0,
  error: 1,
  validation: 2,
  environment: 3,
  provider: 4,
  render: 5,
} as const;

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const TEMPLATE = path.join(ROOT, 'template');

export type Level = 'pass' | 'warn' | 'fail';
export interface CheckResult {
  id: number;
  name: string;
  level: Level;
  message: string;
  fix?: string;
}

export const LICENSE_NOTE =
  'framekit is MIT licensed; windower renders with framekit only and installs no third-party renderer code.';

export const ESBUILD_NOTE =
  'framekit bundling uses esbuild, whose install script pnpm-workspace.yaml allows (allowBuilds); if pnpm reports "Ignored build scripts: esbuild", run `pnpm rebuild esbuild`.';

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL'));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Free only if every interface a dev server could clash on accepts a listen (another app may hold ::1 or 0.0.0.0 only). */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
    if (!(await canListen(port, host))) return false;
  }
  return true;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function nodeMajor(version = process.versions.node): number {
  return Number(version.split('.')[0]);
}

export function hasBinary(name: string): boolean {
  return spawnSync(name, ['-version'], {stdio: 'ignore'}).status === 0;
}

const SHELL_BIN = 'chrome-headless-shell';

/** Shared cache (WINDOWER_BROWSER_CACHE, default ~/.cache/windower); its shell is passed to framekit as --browser-executable. */
export function sharedShellDir(): string {
  const base = process.env.WINDOWER_BROWSER_CACHE ?? path.join(os.homedir(), '.cache', 'windower');
  return path.join(base, SHELL_BIN);
}

/** Finds the headless shell executable inside a browser cache directory, if present. */
export function findShellExecutable(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const walk = (d: string, depth: number): string | undefined => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name === SHELL_BIN) return full;
      if (e.isDirectory() && depth < 4) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(dir, 0);
}

export function freeDiskGb(dir: string): number {
  const s = statfsSync(dir);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export function findDsStore(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findDsStore(full));
    else if (entry.name === '.DS_Store') found.push(full);
  }
  return found;
}

interface CodeScene {
  id?: string;
  type?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  code?: string;
}

/** Returns one problem per invalid code scene; each names the scene id. */
export function codeSceneProblems(
  storyboard: {repoRoot?: string; scenes?: CodeScene[]},
  baseDir = process.cwd(),
): string[] {
  const problems: string[] = [];
  const {scenes = []} = storyboard;
  const repoRoot = storyboard.repoRoot ? path.resolve(baseDir, storyboard.repoRoot) : undefined;
  if (!repoRoot || !existsSync(repoRoot)) {
    return [`repoRoot does not exist: ${repoRoot ?? '(unset)'}`];
  }
  for (const s of scenes.filter((x) => x.type === 'code')) {
    const id = s.id ?? '(no id)';
    const file = path.join(repoRoot, s.file ?? '');
    if (!s.file || !existsSync(file) || !statSync(file).isFile()) {
      problems.push(`scene ${id}: file not found under repoRoot: ${s.file ?? '(unset)'}`);
      continue;
    }
    const lines = readFileSync(file, 'utf8').split('\n').length;
    const a = s.startLine;
    const b =
      s.endLine ??
      (a !== undefined && s.code
        ? a + s.code.replace(/\n$/, '').split('\n').length - 1
        : undefined);
    if (!a || !b || a < 1 || a > b || b > lines) {
      problems.push(`scene ${id}: invalid line range ${a}-${b} (file has ${lines} lines)`);
    }
  }
  return problems;
}

export function propsProblem(runDir: string): string | undefined {
  const props = path.join(runDir, 'props.json');
  const sb = path.join(runDir, 'storyboard.json');
  if (!existsSync(props)) return `props.json is missing in ${runDir}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(props, 'utf8'));
  } catch (e) {
    return `props.json is not valid JSON: ${(e as Error).message}`;
  }
  const p = parsed as {scenes?: unknown};
  if (!p || typeof p !== 'object' || !Array.isArray(p.scenes) || p.scenes.length === 0) {
    return 'props.json has the wrong shape (expected a non-empty "scenes" array)';
  }
  if (existsSync(sb) && statSync(props).mtimeMs < statSync(sb).mtimeMs) {
    return 'props.json is older than storyboard.json (re-run prepare)';
  }
  return undefined;
}
