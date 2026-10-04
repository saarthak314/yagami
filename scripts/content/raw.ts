// Intermediate result of the anchors step (work/<slug>/anchors/<unit>.raw.json):
// anchors with pixel boxes on the 300 dpi page renders, plus the crop box each
// page will be cut to. The assemble step turns this into the served Unit.

import type { Anchor } from "../../src/types";

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface RawPage {
  pdfPage: number;
  label: string;
  /** Render size in px (300 dpi). */
  width: number;
  height: number;
  /** Crop box in render px; may extend past the render edge (padded with paper). */
  crop: { left: number; top: number; width: number; height: number };
}

export interface RawAnchor {
  id: string;
  section: string;
  pdfPage: number;
  kind: Anchor["kind"];
  column: 0 | 1;
  box: Box;
  text: string;
}

export interface RawUnit {
  book: string;
  unit: string;
  title: string;
  pages: RawPage[];
  sections: { id: string; title: string; pdfPage: number; top: number }[];
  /** In reading order. */
  anchors: RawAnchor[];
}

/** Render resolution used by every adapter. */
export const DPI = 300;
