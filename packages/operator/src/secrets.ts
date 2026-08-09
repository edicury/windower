import type { ResolvedSecret } from "@windower/core";

/**
 * Secret-ref substitution (contracts/operator.md §Secret refs, point 2).
 *
 * The model's prompt and every tool-call argument it produces contain only
 * `{{name}}` placeholders. `substituteSecrets` is called from exactly one
 * place — the `type_text` tool handler, immediately before the `performInput`
 * RPC — so a resolved value exists in process memory only for the duration of
 * that single call and never enters a prompt, a tool result, a step record, or
 * a log line.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** The placeholder token the model is told to use for a given secret name. */
export function placeholderToken(name: string): string {
  return `{{${name}}}`;
}

/** Every `{{name}}` placeholder present in a string, in order of appearance. */
export function referencedPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Replaces `{{name}}` with the resolved value. Unknown placeholders are left
 * verbatim: an unresolved name is not a secret, and silently deleting it would
 * type the wrong thing into a live UI.
 */
export function substituteSecrets(text: string, secrets: readonly ResolvedSecret[]): string {
  if (secrets.length === 0) return text;
  const byName = new Map(secrets.map((s) => [s.name, s.value]));
  return text.replace(PLACEHOLDER, (whole, name: string) => byName.get(name) ?? whole);
}
