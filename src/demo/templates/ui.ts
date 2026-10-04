// Kit-side helpers shared by the template components (theme colours, label fonts).

import { theme } from "../kit";
import type { Color } from "./configs";

/** A config colour name → the current theme's colour (read at draw time, so theme switches apply live). */
export function tc(c: Color | undefined, fallback: Color = "fg"): string {
  return theme[c ?? fallback];
}

/** Default colours for the n-th series when the config doesn't name one. */
export const SERIES: Color[] = ["accent", "accent2", "fg", "muted"];

export const LABEL_FONT = '11px "Geist Variable", system-ui, sans-serif';
export const MONO_FONT = '11px "Geist Mono Variable", ui-monospace, monospace';
