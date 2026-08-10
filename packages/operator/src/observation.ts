import type { UIElement } from "@windower/core";
import { ELEMENT_LIST_MAX_CHARS } from "./prompt.js";

/**
 * Phase 22 observation policy support: rendering an accessibility-element
 * list into compact line-oriented TEXT for the model (contracts/operator.md
 * §Observation policy — "Elements enter the model's context as text, not
 * pretty-printed JSON").
 */

/** Marks a user message as an elements observation, so pruning can find it by content shape alone — the same style `run.ts`'s frame pruning already uses (scanning for a `file` content part). */
export const ELEMENTS_OBSERVATION_MARKER = "ELEMENTS OBSERVATION";

function flags(el: UIElement): string {
  const bits: string[] = [];
  if (el.enabled === false) bits.push("disabled");
  if (el.focused === true) bits.push("focused");
  return bits.length === 0 ? "" : ` [${bits.join(",")}]`;
}

function renderLine(el: UIElement): string {
  const { x, y, width, height } = el.bounds;
  const label = el.label === undefined ? "" : ` "${el.label}"`;
  const value = el.value === undefined || el.value === "" ? "" : ` value="${el.value}"`;
  return `[${el.ref}] ${el.role}${label}${value} rect(${x},${y},${width}x${height})${flags(el)}`;
}

/**
 * Renders an element list as the text the model actually reads. Capped at
 * `maxChars` (default `ELEMENT_LIST_MAX_CHARS`, stated in the prompt) —
 * truncation drops whole trailing lines and says so explicitly, rather than
 * cutting a line mid-way, which would fabricate a shorter rect or ref.
 */
export function renderElementsAsText(
  elements: readonly UIElement[],
  options: { truncatedByServer?: boolean; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? ELEMENT_LIST_MAX_CHARS;
  const header = `${ELEMENTS_OBSERVATION_MARKER} — ${elements.length} element(s).`;
  if (elements.length === 0) {
    return [header, "(no interactable elements found)"].join("\n");
  }

  const lines: string[] = [];
  let used = header.length;
  let cut = false;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element === undefined) continue;
    const line = renderLine(element);
    // +1 for the joining newline.
    if (used + line.length + 1 > maxChars) {
      cut = true;
      lines.push(
        `[${elements.length - i} more element(s) omitted — call observe_elements to narrow the list]`,
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const truncationNote =
    cut || options.truncatedByServer === true
      ? "\n(list truncated; use observe_elements with role/labelContains/maxElements to narrow it)"
      : "";

  return [header, ...lines].join("\n") + truncationNote;
}
