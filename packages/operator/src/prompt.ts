import type { Rect } from "@windower/core";
import { OPERATOR_TOOL_NAMES } from "./tools.js";

/**
 * The system prompt *describes* the guardrails so the model can plan around
 * them, but never enforces them — enforcement lives in `guardrails.ts` and the
 * loop (contracts/operator.md §Guardrails). Secret **names** appear here;
 * secret values never do.
 */
export function buildSystemPrompt(params: {
  task: string;
  secretNames: readonly string[];
  maxSteps: number;
  timeoutMs: number;
  unbounded: boolean;
  bounds?: Rect;
}): string {
  const lines: string[] = [
    "You are Windower's operator: a bounded agent that drives a real computer's UI by looking at screenshots and issuing mouse/keyboard actions.",
    "",
    "TASK:",
    params.task,
    "",
    "HOW YOU WORK:",
    "- Each turn you receive a fresh screenshot of the target. Everything you know about the screen comes from that image.",
    "- Coordinates are absolute screen pixels, top-left origin, in the same space as the screenshot you were given.",
    "- Prefer one action per turn, then look again. Do not chain many blind actions.",
    "- Use `wait` when the UI needs time to settle, then observe again.",
    "- Call `done` with a summary as soon as the task is complete, or `fail` with a reason if it cannot be completed.",
    "",
    `AVAILABLE TOOLS (this is the complete set): ${OPERATOR_TOOL_NAMES.join(", ")}.`,
    "You have no shell, no filesystem access, and no network access. Do not ask for them.",
    "",
    "LIMITS (enforced by the runtime, not by you — exceeding one ends the run):",
    `- At most ${params.maxSteps} steps.`,
    `- At most ${Math.round(params.timeoutMs / 1000)} seconds of wall-clock time.`,
  ];

  if (!params.unbounded && params.bounds !== undefined) {
    const b = params.bounds;
    lines.push(
      `- Every coordinate must fall inside the target rect x=${b.x}, y=${b.y}, width=${b.width}, height=${b.height}. An out-of-bounds coordinate terminates the run.`,
    );
  } else {
    lines.push("- Coordinates are not restricted to a target rect on this run.");
  }

  if (params.secretNames.length > 0) {
    lines.push(
      "",
      "SECRETS:",
      `- The following placeholder tokens are available: ${params.secretNames.map((n) => `{{${n}}}`).join(", ")}.`,
      '- Pass a placeholder verbatim inside `type_text` (e.g. type_text with text "{{password}}"). The real value is substituted outside of you, immediately before the keystrokes are sent.',
      "- You will never see a secret's value, and you must never guess, reconstruct, or echo one.",
    );
  }

  return lines.join("\n");
}
