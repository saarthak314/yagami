// Planner/builder quality rules that don't need a model: which parts of a unit may carry demos
// (no exercises, references or front matter), how many demos a unit gets, figure/table references
// (whole regions for the builder; beats that name a figure sit near it), template briefs that admit
// a stand-in, and grounding — every number a spec states (template data, expectations, captions)
// must appear in the source or follow simply from it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import sharp from "sharp";
import type { Anchor, BookConfig, DemoSpec } from "../../src/types";
import { ocrTextLayer, pagePng, rawUnitPath } from "../books";
import type { RawUnit } from "../content/raw";
import { unitSanity } from "../content/sanity";
import { emit } from "../lib/report";
import { type Ctx, log, tag, textSourceNote } from "./common";

// --- Source wording ------------------------------------------------------------------------

/** The unit text came from OCR: a scan, or a text PDF whose text layer was made by OCR (`source.ocr`, or detected). */
export function isOcr(book: BookConfig): boolean {
  if (book.source.kind !== "text" || (book.source as { ocr?: unknown }).ocr === true) return true;
  return fs.existsSync(book.source.pdf) && ocrTextLayer(book.source.pdf);
}

/** How the per-anchor text was obtained, for prompt wording (OCR'd text layers are never called accurate). */
export function sourceNote(book: BookConfig): { name: string; caveat: string } {
  if (book.source.kind === "text" && isOcr(book))
    return {
      name: "OCR text from the PDF's text layer (noisy)",
      caveat: "This text layer was made by OCR, so it is noisy: letters, digits and symbols may be misread and maths is garbled; check numbers and equations against the page images, which are authoritative.",
    };
  return textSourceNote(book);
}

// --- Sections and anchors that never carry demos -------------------------------------------

const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

/** Squashed ids/titles (letters only) of sections without demo-worthy content. */
const SKIP_PREFIX = /^(references|bibliography|literaturecited|workscited|acknowledg|keywords|ccsconcepts|acmreferenceformat|problemsfor|exercisesfor|practiceproblems|classproblems|homeworkproblems|examproblems|tableofcontents|listoffigures|listoftables)/;
const SKIP_EXACT = new Set(["problems", "exercises", "homework", "solutions", "questions", "reviewquestions", "contents", "index", "glossary", "dedication", "copyright", "abouttheauthor", "abouttheauthors", "frontmatter", "backmatter"]);
const SKIP_SUFFIX = /(andexercises|andproblems|exercises|homework)$/;
/** Section kinds (from the content step) without demo-worthy content. */
const SKIP_KIND = /exercise|problem|solution|reference|biblio|front|back|index|contents|acknowledg/i;

/** Why a section never carries demos (exercises, references, front matter), or null. */
export function skipSectionReason(s: { id: string; title?: string; kind?: string }): string | null {
  if (s.kind && SKIP_KIND.test(s.kind)) return s.kind;
  for (const v of [s.id, s.title ?? ""].map(squash)) {
    if (!v) continue;
    if (SKIP_PREFIX.test(v) || SKIP_EXACT.has(v) || SKIP_SUFFIX.test(v)) return v;
  }
  return null;
}

/** A paragraph that opens a block of exercises inside a section ("Problems for Section 20.1", "Class Problems"). */
const EXERCISE_HEADER = /^(problems for section\b|exercises for section\b|(practice|class|homework|exam|review) (problems|exercises|questions)\s*$|(problems|exercises)\s*$)/i;
/** One exercise ("Problem 20.3.", "Exercise 2.1"). */
const EXERCISE_ITEM = /^(problem|exercise)\s+\d+(\.\d+)*\.?(\s|$)/i;

/**
 * Anchors that may carry demos: not in a skipped section (exercises, references, front matter), and
 * not inside a run of exercises within a section (from an exercise header, or from the first of two
 * or more numbered problems in the same section, up to the next heading of a section that isn't skipped).
 */
export function plannableAnchors(c: Ctx): Anchor[] {
  const sections = new Map(c.unit.sections.map((s) => [s.id, s]));
  const skipped = (id: string) => {
    const s = sections.get(id) as ({ id: string; title: string; kind?: string } | undefined);
    return !!skipSectionReason(s ?? { id });
  };
  const anchors = c.unit.anchors;
  const text = (a: Anchor) => (c.text.text[a.id] ?? "").replace(/\s+/g, " ").trim();
  const items = anchors.map((a) => a.kind !== "heading" && EXERCISE_ITEM.test(text(a)));
  const out: Anchor[] = [];
  let inExercises = false;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a.kind === "heading") inExercises = skipped(a.section);
    else if (!inExercises) {
      const t = text(a);
      const another = () => anchors.some((x, j) => j > i && items[j] && x.section === a.section);
      if ((t.length <= 60 && EXERCISE_HEADER.test(t)) || (items[i] && another())) inExercises = true;
    }
    if (!inExercises && !skipped(a.section)) out.push(a);
  }
  return out;
}

// --- Sanity gate before planning ---------------------------------------------------------------

/** Below this share of the unit's text left for demos (after exercises, references, front matter), planning is refused. */
const MIN_PLANNABLE_SHARE = 0.1;
/** Below this share, planning goes ahead with a warning. */
const WARN_PLANNABLE_SHARE = 0.5;

/**
 * Check the unit before planning: the content step's sanity problems (no sections, a giant section,
 * front-matter-heavy, contents-like titles, page-sized anchors…) become warn events, and so does a
 * unit whose text is mostly exercises/references/front matter. Throws when almost nothing is left
 * to plan (rather than planning garbage). Returns the problems for callers and tests.
 */
export function sanityGate(c: Ctx, keep: Anchor[], who = `plan ${tag(c.book.slug, c.unit.unit)}`): string[] {
  const out: string[] = [];
  const warn = (message: string) => {
    out.push(message);
    emit({ type: "log", level: "warn", message: `${who}: ${message}` });
  };
  let problems: { code: string; message: string }[] = [];
  try {
    problems = unitSanity(c.unit, c.text.text);
  } catch (e) {
    log(`${who}: sanity check failed (${(e as Error).message})`);
  }
  const severe = new Set(["no-sections", "giant-section", "front-matter-heavy", "toc-title", "page-sized-anchor"]);
  for (const p of problems.filter((p) => severe.has(p.code)).slice(0, 4)) warn(`content check: ${p.message}`);
  const rest = problems.filter((p) => !severe.has(p.code));
  if (rest.length) log(`${who}: content check: ${rest.length} minor problem(s): ${rest.slice(0, 3).map((p) => p.code).join(", ")}`);
  const len = (a: Anchor) => (a.kind === "heading" ? 0 : (c.text.text[a.id] ?? "").length);
  const total = c.unit.anchors.reduce((n, a) => n + len(a), 0);
  const kept = keep.reduce((n, a) => n + len(a), 0);
  const share = total ? kept / total : keep.length ? 1 : 0;
  if (!keep.some((a) => a.kind !== "heading") || (total > 2000 && share < MIN_PLANNABLE_SHARE))
    throw new Error(`${who}: refusing to plan — only ${Math.round(share * 100)}% of the text is outside exercises, references and front matter (check the unit's page range and sections)`);
  if (total > 2000 && share < WARN_PLANNABLE_SHARE) warn(`only ${Math.round(share * 100)}% of the text is outside exercises, references and front matter`);
  return out;
}

// --- Demo cap -----------------------------------------------------------------------------

/** Most demos for any unit. */
export const DEMO_CAP_MAX = 10;
/** A page counts as substantive with at least this much plannable text (figures and tables count ~400 chars). */
const SUBSTANTIVE_PAGE_CHARS = 900;
/** A section counts as substantive with at least this much plannable text. */
const SUBSTANTIVE_SECTION_CHARS = 1500;

/**
 * Most demos for a unit, from its substantive (plannable, text-bearing) pages and sections: the old
 * caps as a floor (≤ 3 pages: 5, ≤ 6: 6, else 7), scaling up with ~1 per 3 substantive pages or
 * ~0.6 per substantive section, at most DEMO_CAP_MAX (10). Benchmarked: ~1 per 2 pages up to 12
 * tripled the cost of long papers for demos that mostly repeated ideas.
 */
export function demoCap(c: Ctx, keep: Anchor[]): number {
  const weight = (a: Anchor) => (a.kind === "heading" ? 0 : a.kind === "figure" || a.kind === "table" ? 400 : (c.text.text[a.id] ?? "").trim().length);
  const perPage = new Map<string, number>();
  const perSection = new Map<string, number>();
  for (const a of keep) {
    perPage.set(a.page, (perPage.get(a.page) ?? 0) + weight(a));
    perSection.set(a.section, (perSection.get(a.section) ?? 0) + weight(a));
  }
  const subPages = [...perPage.values()].filter((n) => n >= SUBSTANTIVE_PAGE_CHARS).length;
  const subSections = [...perSection.values()].filter((n) => n >= SUBSTANTIVE_SECTION_CHARS).length;
  const base = subPages <= 3 ? 5 : subPages <= 6 ? 6 : 7;
  return Math.min(DEMO_CAP_MAX, Math.max(base, Math.round(subPages / 3), Math.ceil(subSections * 0.6)));
}

// --- Stand-ins ------------------------------------------------------------------------------

const STAND_IN = [
  /\bstand[- ]ins?\b/i,
  /\bas a (surrogate|placeholder) for\b/i,
  /\bclosest (template|fit|match|available|we can|approximation|thing)\b/i,
  /\b(rough|loose|crude) (analogue|analog|version) of (the|what)\b/i,
  /\bapproximat\w* (of|to) (the|what|this|that|its) (text|paper|book|chapter|figure|diagram|described|setup|scene|picture|protocol|algorithm|system)\b/i,
  /\binstead of (the|a|an) (actual|real|text's|paper's|book's|chapter's)\b/i,
  /\bcan(?:not|'t) (show|draw|render|model|represent|reproduce) [^.]{0,40}\b(exactly|directly|faithfully|itself)\b/i,
  /\b(does not|doesn't) (exactly|directly|faithfully) (show|draw|model|represent|reproduce)\b/i,
  /\bnot exactly (what|the|how)\b/i,
];

/** The phrase by which a template brief admits it only approximates what the text describes, or null. */
export function standInPhrase(...texts: (string | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    for (const re of STAND_IN) {
      const m = re.exec(t);
      if (m) return m[0];
    }
  }
  return null;
}

// --- Figure and table references ---------------------------------------------------------------

export interface FigRef {
  kind: "figure" | "table";
  /** As printed, e.g. "3", "13-3", "20.9". */
  num: string;
  /** "Figure 3" / "Table 2". */
  label: string;
}

/** Figures and tables a text names ("Fig. 13-3", "Figure 2", "Figs. 4", "Table 1"), in order, deduplicated. */
export function figureRefs(text: string): FigRef[] {
  const out: FigRef[] = [];
  for (const m of text.matchAll(/\b(Fig(?:ure|s?\.)?|Table)s?\s*(\d+(?:[-–.]\d+)*)/gi)) {
    const kind = /^t/i.test(m[1]) ? "table" : "figure";
    const num = m[2].replace("–", "-");
    const label = `${kind === "table" ? "Table" : "Figure"} ${num}`;
    if (!out.some((r) => r.label === label)) out.push({ kind, num, label });
  }
  return out;
}

const refPattern = (r: FigRef) => `${r.kind === "table" ? "Table" : "Fig(?:ure|\\.)?"}\\s*${r.num.replace(/[-.]/g, "[-–—.]\\s*")}(?![\\d])`;

/** The anchor holding figure/table `r`: the figure/table anchor (or caption) that starts with its label. */
export function figureAnchor(c: Ctx, r: FigRef): Anchor | undefined {
  const head = new RegExp(`^\\s*${refPattern(r)}`, "i");
  const any = new RegExp(`\\b${refPattern(r)}`, "i");
  const t = (a: Anchor) => c.text.text[a.id] ?? "";
  const figs = c.unit.anchors.filter((a) => a.kind === "figure" || a.kind === "table");
  return figs.find((a) => head.test(t(a))) ?? c.unit.anchors.find((a) => a.kind !== "heading" && head.test(t(a))) ?? figs.find((a) => any.test(t(a)));
}

/** True when anchor `a` mentions figure/table `r`. */
function mentions(c: Ctx, a: Anchor, r: FigRef): boolean {
  return new RegExp(`\\b${refPattern(r)}`, "i").test(c.text.text[a.id] ?? "");
}

/**
 * A beat whose text names "Figure N"/"Table N" must sit on or near that figure: within 3 anchors of
 * it, on its page, or on a paragraph that mentions it. Otherwise the beat moves to the figure itself or
 * a paragraph that mentions it — preferring those near the figure, then the one nearest the beat
 * (unused, allowed anchors only). Returns notes for logs.
 */
export function anchorFigureBeats(beats: { anchor: string; text: string }[], c: Ctx, used: Set<string>, allowed?: Set<string>): string[] {
  const notes: string[] = [];
  const anchors = c.unit.anchors;
  const order = new Map(anchors.map((a, i) => [a.id, i]));
  const taken = new Set([...used, ...beats.map((b) => b.anchor)]);
  for (const b of beats) {
    const idx = order.get(b.anchor);
    if (idx === undefined) continue;
    for (const r of figureRefs(b.text)) {
      const f = figureAnchor(c, r);
      if (!f) continue;
      const fi = order.get(f.id)!;
      const here = anchors[idx];
      if (Math.abs(fi - idx) <= 3 || here.page === f.page || mentions(c, here, r)) break;
      const ok = (a: Anchor) => a.kind !== "heading" && !taken.has(a.id) && (!allowed || allowed.has(a.id));
      const options = anchors.filter((a) => ok(a) && (a.id === f.id || (a.kind === "para" && mentions(c, a, r))));
      if (!options.length) continue;
      // Near the figure first (on it, or a paragraph within 5 anchors / on its page), then nearest to the beat.
      const near = (a: Anchor) => (a.id === f.id || Math.abs(order.get(a.id)! - fi) <= 5 || a.page === f.page ? 0 : 1);
      const best = options.sort((x, y) => near(x) - near(y) || Math.abs(order.get(x.id)! - idx) - Math.abs(order.get(y.id)! - idx))[0];
      notes.push(`beat naming ${r.label} moved ${b.anchor} → ${best.id}`);
      taken.delete(b.anchor);
      taken.add(best.id);
      b.anchor = best.id;
      break;
    }
  }
  return notes;
}

// --- Whole figure/table regions ----------------------------------------------------------------

const PX = 300 / 72; // raw boxes are in 300 dpi render px; pdftotext works in pt
const rawCache = new Map<string, RawUnit | null>();
const pageWordCache = new Map<string, { l: number; t: number; r: number; b: number; text: string }[]>();

function rawUnit(book: BookConfig, unitId: string): RawUnit | null {
  const f = rawUnitPath(book.slug, unitId);
  const key = `${f}:${fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0}`;
  if (!rawCache.has(key)) rawCache.set(key, fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as RawUnit) : null);
  return rawCache.get(key)!;
}

/** Words of one PDF page from the text layer (pt), [] when unavailable. */
function pageWords(pdf: string, pdfPage: number) {
  const key = `${pdf}:${pdfPage}`;
  let words = pageWordCache.get(key);
  if (!words) {
    words = [];
    try {
      const xml = execFileSync("pdftotext", ["-bbox", "-f", String(pdfPage), "-l", String(pdfPage), pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
      const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      for (const m of xml.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) words.push({ l: +m[1], t: +m[2], r: +m[3], b: +m[4], text: dec(m[5]) });
    } catch {
      /* no pdftotext or no text layer */
    }
    pageWordCache.set(key, words);
  }
  return words;
}

export interface Region {
  anchor: Anchor;
  label: string;
  /** Every text line inside the region, top to bottom (cells separated by two spaces). */
  lines: string[];
}

/**
 * All text lines of a figure/table region: the words of the PDF text layer inside the anchor's box,
 * grouped into rows (a table's body, a figure's labels and numbers). Scans and books without a
 * text layer fall back to the anchor's own text.
 */
export function regionLines(c: Ctx, a: Anchor): string[] {
  const own = (c.text.text[a.id] ?? "").replace(/\s+/g, " ").trim();
  const raw = c.book.source.kind === "text" && fs.existsSync(c.book.source.pdf) ? rawUnit(c.book, c.unit.unit) : null;
  const ra = raw?.anchors.find((x) => x.id === a.id);
  if (!ra) return own ? [own] : [];
  const pad = 3;
  const box = { l: ra.box.l / PX - pad, t: ra.box.t / PX - pad, r: ra.box.r / PX + pad, b: ra.box.b / PX + pad };
  const inside = pageWords(c.book.source.pdf, ra.pdfPage).filter((w) => {
    const cx = (w.l + w.r) / 2;
    const cy = (w.t + w.b) / 2;
    return cx >= box.l && cx <= box.r && cy >= box.t && cy <= box.b;
  });
  if (!inside.length) return own ? [own] : [];
  inside.sort((x, y) => (x.t + x.b) / 2 - (y.t + y.b) / 2);
  const rows: (typeof inside)[] = [];
  for (const w of inside) {
    const row = rows.at(-1);
    const cy = (w.t + w.b) / 2;
    if (row && Math.abs(cy - (row[0].t + row[0].b) / 2) <= 0.5 * Math.max(2, row[0].b - row[0].t)) row.push(w);
    else rows.push([w]);
  }
  return rows.map((row) => {
    row.sort((x, y) => x.l - y.l);
    let s = row[0].text;
    for (let i = 1; i < row.length; i++) s += (row[i].l - row[i - 1].r > 0.8 * (row[i].b - row[i].t) ? "  " : " ") + row[i].text;
    return s;
  });
}

/** A high-resolution crop of a region from the 300 dpi render (original colours), or null. */
export async function regionCrop(c: Ctx, a: Anchor, max = 1600): Promise<Buffer | null> {
  const raw = rawUnit(c.book, c.unit.unit);
  const ra = raw?.anchors.find((x) => x.id === a.id);
  if (!ra) return null;
  const file = pagePng(c.book.slug, ra.pdfPage);
  if (!fs.existsSync(file)) return null;
  try {
    const meta = await sharp(file).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const pad = 24;
    const left = Math.max(0, Math.round(ra.box.l - pad));
    const top = Math.max(0, Math.round(ra.box.t - pad));
    const width = Math.min(W - left, Math.round(ra.box.r - ra.box.l + 2 * pad));
    const height = Math.min(H - top, Math.round(ra.box.b - ra.box.t + 2 * pad));
    if (width < 8 || height < 8) return null;
    return await sharp(file).extract({ left, top, width, height }).resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Figures/tables a demo refers to: named in `texts` (idea, beat focus/captions, brief) or in the
 * text of its beat anchors. At most `max`, each with every text line of its region.
 */
export function referencedRegions(c: Ctx, texts: string[], beatAnchors: string[], max = 4): Region[] {
  const all = [...texts, ...beatAnchors.map((id) => c.text.text[id] ?? "")].join("\n");
  const out: Region[] = [];
  for (const r of figureRefs(all)) {
    const a = figureAnchor(c, r);
    if (!a || out.some((x) => x.anchor.id === a.id)) continue;
    out.push({ anchor: a, label: r.label, lines: regionLines(c, a) });
    if (out.length >= max) break;
  }
  return out;
}

/** Regions as prompt text (each region's lines in full, capped at ~4k chars). */
export function regionsText(regions: Region[]): string {
  return regions
    .map((r) => {
      let body = r.lines.join("\n");
      if (body.length > 4000) body = body.slice(0, 4000) + "\n…";
      return `${r.label} — the whole region [${r.anchor.id}] (p.${r.anchor.page}), every text line as printed:\n${body}`;
    })
    .join("\n\n");
}

// --- Grounding --------------------------------------------------------------------------------

interface Printed {
  value: number;
  /** Decimal places as printed. */
  dec: number;
  /** Where it is printed, e.g. "Table 3" or "[6.2-p4]". */
  where: string;
  /** A short excerpt around it. */
  snippet: string;
}

/** Numbers printed in a text: "5.98", "28.4%" (also as 0.284), "1,024", "−0.5". */
export function printedNumbers(text: string, where: string, percentAsFraction = true): Printed[] {
  const out: Printed[] = [];
  for (const m of text.matchAll(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?|(?<![\w.])\.\d+%?/g)) {
    const raw = m[0];
    const pct = raw.endsWith("%");
    const body = raw.replace(/[,%]/g, "");
    const value = Number(body);
    if (!Number.isFinite(value)) continue;
    const dec = body.includes(".") ? body.split(".")[1].length : 0;
    const i = m.index ?? 0;
    const snippet = text.slice(Math.max(0, i - 40), i + raw.length + 30).replace(/\s+/g, " ").trim();
    out.push({ value, dec, where, snippet });
    if (pct && percentAsFraction) out.push({ value: value / 100, dec: dec + 2, where, snippet });
  }
  return out;
}

function decimals(x: number): number {
  const s = String(Math.abs(x));
  if (/e/i.test(s)) return 20;
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Numbers that need no source: small integers, round numbers, powers of two, halves, simple fractions. */
export function simpleNumber(x: number): boolean {
  const a = Math.abs(x);
  if (Number.isInteger(a) && a <= 20) return true;
  if (Number.isInteger(a) && a > 0 && a <= 2 ** 32 && Number.isInteger(Math.log2(a))) return true;
  if (Number.isInteger(a) && ((a <= 100 && a % 5 === 0) || (a <= 10000 && a % 100 === 0) || Number.isInteger(Math.log10(a)))) return true;
  if (a <= 10 && Number.isInteger(a * 2)) return true;
  if (a <= 1) for (let d = 2; d <= 10; d++) if (Math.abs(a * d - Math.round(a * d)) < 0.0015 * d) return true;
  return false;
}

/**
 * x as stated matches printed value s: equal, or s rounded to x's precision (4.9 for a printed 4.91).
 * Not the other way: a stated 4.94 doesn't match a printed 5. A long computed float (> 4 decimals)
 * matches within 0.1 % (percent ↔ fraction is handled by printedNumbers).
 */
function same(x: number, s: number): boolean {
  const a = Math.abs(x);
  const b = Math.abs(s);
  const dx = decimals(x);
  if (dx > 4) return Math.abs(a - b) <= 1e-3 * b;
  return Math.abs(a - b) <= 0.5 * 10 ** -dx + 1e-12;
}

/** Mantissa (1 ≤ m < 10) of a very large or very small number, else null. */
function mantissa(x: number): number | null {
  const a = Math.abs(x);
  if (a === 0 || (a >= 1e-3 && a < 1e5)) return null;
  return a / 10 ** Math.floor(Math.log10(a));
}

export interface Stated {
  value: number;
  /** Where the spec states it, e.g. `expect at 6.2-p4 (bleu)` or `config.rows[2].vars.ppl`. */
  where: string;
  /** Exempt from grounding (an expectation the builder derived and explained in "why"). */
  derived?: boolean;
}

/** Config keys whose numbers are data (from the text) rather than illustration or layout. */
const DATA_KEYS = new Set(["defs", "vars", "rows", "data", "series", "bars", "entries", "limit", "expected", "constants"]);
/** Leaf keys that are layout or formatting even inside data. */
const LAYOUT_KEYS = new Set(["x", "y", "dx", "dy", "x1", "y1", "x2", "y2", "r", "radius", "n", "digits", "color", "width", "height", "size", "highlight", "index", "row", "col", "speed", "seed", "step", "steps"]);
/** Expression strings under these keys may hold data literals. */
const EXPR_KEYS = new Set(["defs", "vars", "constants"]);

/** Numbers a template config states as data (see DATA_KEYS), with their paths. */
export function configNumbers(config: unknown): Stated[] {
  const out: Stated[] = [];
  const walk = (v: unknown, path: string, key: string, data: boolean, expr: boolean) => {
    if (typeof v === "number") {
      if (data && !LAYOUT_KEYS.has(key) && Number.isFinite(v)) out.push({ value: v, where: path });
    } else if (typeof v === "string") {
      // Decimal literals only: integers in expressions are mostly formula constants (ln(19 + sqrt(360)), 65536*b2).
      if (expr && !LAYOUT_KEYS.has(key)) for (const m of v.matchAll(/(?<![\w.])\d+\.\d+(?:e[-+]?\d+)?(?![\w.])/gi)) out.push({ value: Number(m[0]), where: `${path} ("${v.length > 40 ? v.slice(0, 40) + "…" : v}")` });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key, data, expr));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k, data || DATA_KEYS.has(k), expr || EXPR_KEYS.has(k));
  };
  walk(config, "config", "", false, false);
  return out;
}

/**
 * Numbers a spec states as readout claims: its expectations (unless derived and explained). Captions
 * are not checked — their numbers are mostly the demo's own computed values, which can't be told
 * apart from misquotes without the formula.
 */
export function specNumbers(spec: DemoSpec, derived: Set<number> = new Set()): Stated[] {
  return (spec.expect ?? []).map((e, i) => ({ value: e.value, where: `expect at ${spec.beats[e.beat]?.anchor ?? `beat ${e.beat}`} (${e.readout})`, derived: derived.has(i) }));
}

/** The spec's own parameters: preset and beat params, slider bounds, select values. */
function specParams(spec: DemoSpec): number[] {
  const out: number[] = [];
  const add = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    if (Number.isFinite(n)) out.push(n);
  };
  for (const p of spec.presets) Object.values(p.params).forEach(add);
  for (const b of spec.beats) Object.values(b.params ?? {}).forEach(add);
  for (const c of spec.controls) {
    if (c.type === "slider") [c.min, c.max, c.step].forEach(add);
    if (c.type === "select") c.options.forEach((o) => add(o.value));
  }
  return out;
}

export interface GroundingSource {
  /** Every number printed in the unit's text and the given regions. */
  printed: Printed[];
  /** Numbers in the beat paragraphs themselves (operands for simple derivations). */
  local: number[];
}

const unitPrinted = new WeakMap<Ctx, Printed[]>();

/**
 * Source numbers for a demo: the unit's text and every line of its figure/table regions (cached per
 * context; a referenced region is named after its figure, e.g. "Table 3"), plus the numbers of its
 * beat paragraphs as operands for simple derivations.
 */
export function groundingSource(c: Ctx, spec: Pick<DemoSpec, "beats" | "brief">, extraTexts: string[] = []): GroundingSource {
  let base = unitPrinted.get(c);
  if (!base) {
    base = [];
    for (const a of c.unit.anchors) {
      base.push(...printedNumbers(c.text.text[a.id] ?? "", `[${a.id}]`));
      if (a.kind === "figure" || a.kind === "table") {
        const label = figureRefs((c.text.text[a.id] ?? "").slice(0, 40))[0]?.label ?? `[${a.id}]`;
        for (const line of regionLines(c, a).slice(1)) base.push(...printedNumbers(line, label));
      }
    }
    unitPrinted.set(c, base);
  }
  const printed = [...base];
  // Referenced figures that aren't figure/table anchors (scans: captions filed as paragraphs).
  for (const r of referencedRegions(c, [spec.brief ?? "", ...spec.beats.map((b) => b.caption ?? ""), ...extraTexts], spec.beats.map((b) => b.anchor), 8))
    if (r.anchor.kind !== "figure" && r.anchor.kind !== "table") for (const line of r.lines) printed.push(...printedNumbers(line, r.label));
  const local = spec.beats.flatMap((b) => printedNumbers(c.text.text[b.anchor] ?? "", "").map((n) => n.value));
  return { printed, local };
}

/** x follows from one simple step: a ± b, a × b, a ÷ b over the beat paragraphs' numbers and the params. */
function derivable(x: number, pool: number[]): boolean {
  const a = Math.abs(x);
  const dx = decimals(x);
  const tol = dx > 4 ? 1e-3 * a : 0.5 * 10 ** -dx + 1e-12;
  const ns = [...new Set(pool.map(Math.abs))].slice(0, 60);
  for (const p of ns) {
    if (Math.abs(p * 100 - a) <= tol || Math.abs(p / 100 - a) <= tol) return true;
    if (p !== 0 && (Math.abs(1 / p - a) <= tol || Math.abs(Math.sqrt(p) - a) <= tol || Math.abs(p * p - a) <= tol)) return true;
    for (const q of ns) {
      if (Math.abs(p + q - a) <= tol || Math.abs(p - q - a) <= tol || Math.abs(p * q - a) <= tol || (q !== 0 && Math.abs(p / q - a) <= tol)) return true;
    }
  }
  return false;
}

/**
 * Grounding problems for a spec (and its template config): each stated number that is not simple,
 * not one of the spec's own parameters, not printed in the source (unit text + figure/table regions,
 * rounding allowed), and not one simple step from the beat paragraphs' numbers and the params.
 * Each problem names the value, where it is stated, and the closest printed values with their context.
 */
export function groundingProblems(src: GroundingSource, spec: DemoSpec, stated: Stated[]): string[] {
  const params = specParams(spec);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of stated) {
    if (s.derived || !Number.isFinite(s.value) || simpleNumber(s.value)) continue;
    if (params.some((p) => same(s.value, p))) continue;
    if (src.printed.some((p) => same(s.value, p.value))) continue;
    const m = mantissa(s.value);
    if (m !== null && src.printed.some((p) => p.value >= 1 && p.value < 10 && Math.abs(p.value - m) <= Math.max(0.5 * 10 ** -p.dec, 0.005 * m))) continue;
    if (derivable(s.value, [...src.local, ...params])) continue;
    const key = `${s.value}@${s.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const near = src.printed
      .filter((p) => p.value !== 0 && Math.abs(p.value) / Math.abs(s.value) < 2 && Math.abs(s.value) / Math.abs(p.value) < 2)
      .sort((p, q) => Math.abs(Math.log(Math.abs(p.value / s.value))) - Math.abs(Math.log(Math.abs(q.value / s.value))))
      .filter((p, i, xs) => xs.findIndex((y) => y.value === p.value && y.where === p.where) === i)
      .slice(0, 2);
    const hint = near.length ? ` The closest printed values: ${near.map((p) => `${p.value} in ${p.where} ("…${p.snippet}…")`).join("; ")}.` : "";
    problems.push(`value ${s.value} (${s.where}) is not in the source text, its figures/tables or the spec's parameters, and doesn't follow simply from them.${hint}`);
  }
  return problems;
}

/** The grounding correction request (one turn; never a reason to reject a spec). */
export function groundingRequest(problems: string[], ocr: boolean): string {
  return `These numbers are not grounded in the text:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nEvery number a demo states as the text's (template data, "expect" values, numbers in captions) must be printed in the anchored paragraphs or the referenced table/figure (rounding is fine), or follow from them. Copy printed values exactly from the text/table${ocr ? " (the text is OCR: check digits against the page image)" : ""}; for an expect value computed from the text's quantities (a formula at the beat's params), keep it and add "why": "<formula and inputs>" to that expect entry; otherwise drop the number.`;
}
