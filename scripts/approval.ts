// Approval guard (P3, FR-SB-04): spend and render steps refuse to run unless storyboard.json has
// `approved: true`. `--allow-unapproved` is a fixture/dev escape hatch that warns instead.
import {existsSync, readFileSync} from 'node:fs';

export const APPROVAL_HINT =
  'Run `pnpm ve:gate <run-dir>` to review the summary, then `pnpm ve:gate <run-dir> --approve`.';

/** Returns a refusal message when the storyboard file is not approved, else undefined. */
export function approvalProblem(storyboardFile: string): string | undefined {
  if (!existsSync(storyboardFile)) return `storyboard not found: ${storyboardFile}`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storyboardFile, 'utf8'));
  } catch (e) {
    return `${storyboardFile} is not valid JSON: ${(e as Error).message}`;
  }
  const approved = (raw as {approved?: unknown} | null)?.approved;
  if (approved === true) return undefined;
  return `${storyboardFile} is not approved (approved !== true). ${APPROVAL_HINT}`;
}

export const UNAPPROVED_WARNING =
  'warning: --allow-unapproved set; skipping the approval gate (fixture/dev use only).';
