// Shared contracts between the content pipeline (scripts/), the app (src/) and
// the generated demos (src/demos/). Change with care: all three depend on it.
//
// The app hosts several "books" (a textbook, a paper, ...). Each book has one
// or more "units" (a chapter, or a whole paper) and is configured by
// books/<slug>/book.json (BookConfig). Layout on disk:
//   books/<slug>/book.json                 config (committed)
//   work/<slug>/...                        pipeline scratch (git-ignored)
//   public/books/index.json                Library (git-ignored, generated)
//   public/books/<slug>/units/<unit>.json  Unit (git-ignored, generated)
//   public/books/<slug>/pages/<unit>/<label>.webp
//   src/demos/<slug>/<unit>/plan.json      DemoPlan (committed)
//   src/demos/<slug>/<unit>/<Component>.tsx

// ---------------------------------------------------------------------------
// Book config — books/<slug>/book.json
// ---------------------------------------------------------------------------

export type Domain = "math" | "cs" | "physics" | "ml";

export interface BookConfig {
  /** kebab-case, also the URL segment, e.g. "feynman-1", "attention". */
  slug: string;
  /** Full title, e.g. "The Feynman Lectures on Physics". */
  title: string;
  /** Short name for the top bar, e.g. "Feynman Lectures". */
  short: string;
  /** Muted text after the short name, e.g. "Vol. I" or "Vaswani et al., 2017". */
  subtitle?: string;
  source: {
    /** PDF path relative to the repo root (git-ignored). */
    pdf: string;
    /** Where the PDF can be fetched if missing (optional). */
    url?: string;
    /** "text": born-digital PDF with a text layer. "scanned": image-only pages, located by OCR. */
    kind: "text" | "scanned";
    /** Layout profile for scanned books whose OCR rules are book-specific (e.g. "feynman"). */
    layout?: string;
  };
  domain: Domain;
  /**
   * How page images are adapted to the dark reader:
   * "invert": plain inversion (black & white scans).
   * "lightness": invert lightness but keep hue (born-digital pages with colour figures).
   */
  recolor: "invert" | "lightness";
  units: {
    /** URL-safe id, e.g. "13" or "paper". */
    id: string;
    title: string;
    /** 1-based inclusive PDF page range. */
    pages: [number, number];
  }[];
}

// ---------------------------------------------------------------------------
// Book content — the original pages, recoloured for dark mode, plus paragraph
// anchors (from the PDF text layer, or OCR for scans). The text itself is
// never re-typeset; the app shows the page images.
// ---------------------------------------------------------------------------

/** Page label as printed, e.g. "13-5" or "4". */
export type PageLabel = string;

/**
 * Section id as printed, e.g. "13-2" or "3.2.1". Text before the first
 * numbered section uses "<unit>-0" (e.g. "13-0", "paper-0"); unnumbered
 * headings get a slug ("abstract", "references", "appendix-a").
 */
export type SectionId = string;

export interface PageImage {
  label: PageLabel;
  /** Path under public/, e.g. "books/attention/pages/paper/4.webp". */
  src: string;
  /** Natural display size in CSS px at 1x (the image at `src` is ~2x for retina). */
  width: number;
  height: number;
  /** Sharper variants for zoom / high-DPI screens (`src` included), widest last. */
  srcset?: { src: string; w: number }[];
}

export interface Anchor {
  /**
   * Stable id: `<section>-p<n>`, n counting paragraphs (incl. display
   * equations and figures as their own anchors) from 1 within the section.
   * Headings: `<section>-h`. e.g. "13-2-p4", "3.2.1-p2".
   */
  id: string;
  section: SectionId;
  page: PageLabel;
  /** Vertical position of the paragraph's top edge on its page, 0..1 of page height. */
  y: number;
  /** Paragraph bottom edge, 0..1 of page height (same page as `y`). */
  y1: number;
  /** Left / right edges 0..1 of page width (marker goes left of `x`). */
  x: number;
  x1: number;
  /** 0 = single column or left column, 1 = right column. Anchors are in reading order. */
  column: 0 | 1;
  kind: "para" | "heading" | "equation" | "figure" | "table" | "other";
}

export interface Unit {
  book: string;
  unit: string;
  title: string;
  sections: { id: SectionId; title: string; page: PageLabel; y: number }[];
  pages: PageImage[];
  /** In reading order: page, then column, then top to bottom. */
  anchors: Anchor[];
}

/** public/books/index.json */
export interface Library {
  books: {
    slug: string;
    title: string;
    short: string;
    subtitle?: string;
    domain: Domain;
    units: { id: string; title: string; sections: Unit["sections"] }[];
  }[];
}

/**
 * Pipeline-only companion (work/<slug>/text/<unit>.json, never served): text per
 * anchor id (PDF text layer or OCR), used as planning input. Not displayed.
 */
export interface UnitText {
  book: string;
  unit: string;
  text: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Demo plans — written by the pipeline to src/demos/<slug>/<unit>/plan.json (committed).
// ---------------------------------------------------------------------------

/**
 * Inline text format for captions and labels: plain text plus
 *   *italic*   **bold**   $inline LaTeX$
 * Nothing else. Literal `*` or `$` are escaped as \* and \$.
 */
export type InlineMd = string;

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export type ControlSpec =
  | { type: "slider"; id: string; label: string; min: number; max: number; step: number; unit?: string }
  | { type: "toggle"; id: string; label: string }
  | { type: "select"; id: string; label: string; options: { value: string; label: string }[] };

export interface ReadoutSpec {
  id: string;
  /** Short label, may contain $LaTeX$, e.g. "$T + U$". */
  label: string;
  /**
   * Physically/mathematically valid range of the readout's value (e.g. an error rate ≥ 0, a
   * probability in [0, 1]). The checks fail a readout that shows a value outside it.
   */
  range?: [number, number];
}

export interface Preset {
  id: string;
  label: string;
  /** Full parameter set for this preset (every control id must have a value). */
  params: Params;
}

export interface Beat {
  /** Anchor id the beat is attached to, e.g. "13-2-p4". */
  anchor: string;
  preset: string;
  /** One or two sentences, plain and specific to this paragraph. InlineMd. */
  caption: InlineMd;
  /** Overrides on top of the preset params ("text values"). */
  params?: Params;
}

export interface DemoSpec {
  /** kebab-case, unique within chapter, e.g. "work-gravity". */
  id: string;
  /** Short title shown in small caps, e.g. "Work done by gravity". */
  title: string;
  /** PascalCase component name; file is src/demos/<slug>/<unit>/<Component>.tsx. */
  component: string;
  /** Precise description of what the demo shows and the physics/maths/algorithm it must implement. */
  brief: string;
  presets: Preset[];
  controls: ControlSpec[];
  readouts: ReadoutSpec[];
  beats: Beat[];
  /** Numeric values the text pins down, checked against the rendered readouts (no model needed). */
  expect?: Expectation[];
  /**
   * Id of a template from src/demo/templates/catalog.ts. When set, the app renders that template with
   * `config` and `component` is ignored (no generated file is needed).
   */
  template?: string;
  /** The template's config, validated by the catalog entry's `validate`. */
  config?: unknown;
  /**
   * Set by verify when the demo still fails after all rounds: a one-line reason. The reader shows a
   * quiet "may be inaccurate" note with it — a failing demo is never shipped silently.
   */
  flagged?: string;
}

/** A readout value the demo must show at a beat (verified deterministically after the stage settles). */
export interface Expectation {
  /** Beat index the value applies to (the demo shows that beat's params). */
  beat: number;
  /** ReadoutSpec.id */
  readout: string;
  /** Expected numeric value of the readout at that beat. */
  value: number;
  /** Relative tolerance (default 0.02); 0 means exact. */
  tol?: number;
}

export interface DemoPlan {
  book: string;
  unit: string;
  demos: DemoSpec[];
}

// ---------------------------------------------------------------------------
// Demo components — src/demos/<slug>/<unit>/<Component>.tsx, default export.
// Built on the kit in src/demo/kit.ts (see that file for helpers).
// ---------------------------------------------------------------------------

export interface DemoProps {
  /** Current parameter values: preset params, then beat params, then user edits. */
  params: Params;
  /** Which preset is active (the shell also merges its params into `params`). */
  preset: string;
  /** Whether the animation should advance. */
  playing: boolean;
  /** Increments when the user presses Restart; reset simulation state when it changes. */
  resetKey: number;
  /** Stage size in CSS px. The demo must draw to exactly this box. */
  width: number;
  height: number;
  /** Publish live values keyed by ReadoutSpec.id. Throttled by the shell; call freely. */
  setReadouts: (values: Record<string, string | number>) => void;
}
