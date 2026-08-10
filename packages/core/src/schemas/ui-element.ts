import { z } from "zod";
import { RectSchema } from "./rect.js";

/**
 * UIElement (Phase 22) — one accessibility element of a target, as returned
 * by the sidecar protocol's `enumerateElements` (contracts/sidecar-protocol.md).
 * This is the operator's default percept — see data-model.md §UIElement.
 *
 * Flat list plus `parentRef`, deliberately NOT a nested tree: a flat list
 * serializes smaller and truncates cleanly (a nested tree cut at a depth/count
 * bound leaves orphaned subtrees and an ambiguous record of what was
 * dropped). A consumer that needs hierarchy rebuilds it from `parentRef`.
 *
 * `role` is a NORMALIZED cross-platform vocabulary — never a raw
 * `AXRole`/`UIA_ControlType`/AT-SPI role string. The mapping lives in each
 * native backend, below the stdio line; an unmapped native role surfaces as
 * `role: "other"` with the native role in `subrole`
 * (CLAUDE.md "protocol before platform").
 *
 * `bounds` is PIXELS, global top-left-origin Quartz space — the same space
 * `InputAction` uses, so this rect's center feeds straight into `performInput`
 * with no conversion (CLAUDE.md's units rule).
 */
export const UIElementSchema = z.object({
  /** Opaque, stable within one `generation`; never a raw memory address. */
  ref: z.string(),
  role: z.string(),
  /** Platform-native refinement when it disambiguates, e.g. macOS "AXSearchField". */
  subrole: z.string().optional(),
  /** Accessible name — title, label, or description, whichever the platform exposes. */
  label: z.string().optional(),
  /** Current value for fields/toggles, truncated to a documented max length. */
  value: z.string().optional(),
  bounds: RectSchema,
  enabled: z.boolean(),
  focused: z.boolean().optional(),
  /**
   * Actions the platform advertises. INFORMATIONAL ONLY — Windower never
   * invokes them. AX is a sensor here, never an actuator (see
   * tasks/phase-22-operator-ax-first.md's settled decisions).
   */
  actions: z.array(z.string()).optional(),
  parentRef: z.string().optional(),
});
export type UIElement = z.infer<typeof UIElementSchema>;
