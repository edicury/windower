import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonError, type ResolvedSecret, type SecretRef } from "@windower/core";

const execFileAsync = promisify(execFile);

/**
 * Resolves `SecretRef`s to values, in the daemon, at run start
 * (contracts/operator.md §Secret refs). Resolved values live in memory for the
 * duration of one operator run and are never written to the run JSON, the
 * transcript, or any log.
 *
 * The `keychain` source is the only platform-shaped part of the operator
 * pipeline, so it is expressed as a *swappable resolver function* rather than
 * an `if (platform === "macos")` branch (CLAUDE.md §protocol before platform):
 * a Windows/Linux daemon build supplies its own credential-store function and
 * nothing else in this file changes.
 */
export type KeychainResolver = (ref: string) => Promise<string>;

export interface SecretResolverOptions {
  /** Defaults to `process.env` — injectable so tests never touch the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the macOS `security` CLI. Other OSes inject their own store here. */
  keychain?: KeychainResolver;
  /** Defaults to `console.warn` — the `literal` source logs a shell-history warning. */
  warn?: (message: string) => void;
}

/**
 * `security find-generic-password -w -s <ref>` — the macOS credential store.
 * Only reachable when the daemon is running on a host whose `security` binary
 * exists; a failure surfaces as a structured `INVALID_ARGS` error rather than
 * an unhandled rejection, and the item's value never reaches the error message.
 */
export const macosKeychainResolver: KeychainResolver = async (ref) => {
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", ref]);
    const value = stdout.replace(/\n$/, "");
    if (value.length === 0) throw new Error("empty value");
    return value;
  } catch {
    throw new DaemonError(
      "INVALID_ARGS",
      `Could not resolve keychain secret "${ref}" from the OS credential store`,
    );
  }
};

export class SecretResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychain: KeychainResolver;
  private readonly warn: (message: string) => void;

  constructor(options: SecretResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.keychain = options.keychain ?? macosKeychainResolver;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * Resolves every ref or throws — a run must never start half-credentialed.
   * Errors name the *ref*, never the value.
   */
  async resolveAll(refs: readonly SecretRef[]): Promise<ResolvedSecret[]> {
    const resolved: ResolvedSecret[] = [];
    for (const ref of refs) {
      resolved.push({ name: ref.name, value: await this.resolveOne(ref) });
    }
    return resolved;
  }

  private async resolveOne(ref: SecretRef): Promise<string> {
    switch (ref.source) {
      case "env": {
        const value = this.env[ref.ref];
        if (value === undefined || value.length === 0) {
          throw new DaemonError(
            "INVALID_ARGS",
            `Secret "${ref.name}": environment variable "${ref.ref}" is not set in the daemon's environment`,
          );
        }
        return value;
      }
      case "keychain":
        return await this.keychain(ref.ref);
      case "literal":
        this.warn(
          `[SecretResolver] secret "${ref.name}" was passed as a literal value — it is exposed in shell history and process listings. Prefer --secret <name>=env:<VAR> or keychain:<item>.`,
        );
        return ref.ref;
    }
  }
}

/**
 * Replaces every resolved secret value found anywhere in `value` with its
 * `{{name}}` placeholder. Applied to `OperatorStep`s before they are persisted,
 * so a sloppy or compromised operator loop still cannot leak a credential into
 * `~/.windower/operator-runs/<runId>.json` or `<recording>.operator.json`
 * (contracts/operator.md §Secret refs, substitution boundary rule 3).
 */
export function redactSecrets<T>(value: T, secrets: readonly ResolvedSecret[]): T {
  if (secrets.length === 0) return value;
  return redact(value, secrets) as T;
}

function redact(value: unknown, secrets: readonly ResolvedSecret[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (secret.value.length === 0) continue;
      out = out.split(secret.value).join(`{{${secret.name}}}`);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(item, secrets);
    }
    return out;
  }
  return value;
}
