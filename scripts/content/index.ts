// Content pipeline: PDF pages → paragraph anchors → dark-mode page images + Unit JSON.
// No model calls: books are shown as their original pages.
//
// Steps (pipeline names): render, anchors, assemble.

import type { BookConfig } from "../../src/types";
import { textAnchors } from "./text";
import { feynmanAnchors } from "./scanned/feynman";
import { genericScannedAnchors } from "./scanned/generic";

export { renderUnit } from "./render";
export { assembleUnit, writeLibrary } from "./assemble";

/**
 * Optional OCR rules for scanned books whose layout the generic adapter can't
 * handle, selected by BookConfig.source.layout. Everything else uses the
 * generic scanned adapter (or the text layer for born-digital PDFs).
 */
const LAYOUT_PROFILES: Record<string, (book: BookConfig, unitId: string) => Promise<void>> = {
  feynman: feynmanAnchors,
};

/** Locate paragraph anchors: from the PDF text layer, or by OCR for scanned books. */
export async function anchorUnit(book: BookConfig, unitId: string): Promise<void> {
  if (book.source.kind === "text") return textAnchors(book, unitId);
  const profile = book.source.layout ? LAYOUT_PROFILES[book.source.layout] : undefined;
  return (profile ?? genericScannedAnchors)(book, unitId);
}
