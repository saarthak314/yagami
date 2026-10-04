// Text-layer adapter (BookConfig.source.kind "text"): paragraph anchors for
// born-digital PDFs, from `pdftotext -bbox-layout` word boxes. No OCR, no model.
//
// Per page:
//   1. Lines from the text layer; drop rotated text (arXiv watermark), page numbers.
//   2. Columns: two-column when most body lines sit wholly in the left or right
//      half. Full-width lines (title, wide captions) split the page into bands;
//      reading order is band by band, left column then right within a band.
//   3. Figures/tables: a "Figure N:" / "Table N:" caption claims the graphics
//      region next to it (lines that aren't prose, refined with the page's ink).
//   4. The remaining lines become headings (numbered, checked against the running
//      section number; or unnumbered like Abstract/References in a larger font),
//      display equations (centred, or with an "(n)" tag at the right edge),
//      footnotes (small type at the foot of the page) and prose paragraphs
//      (split on extra vertical space or a first-line indent).
//
// Output (pipeline-only): work/<slug>/anchors/<unit>.raw.json, work/<slug>/text/<unit>.json

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Anchor, BookConfig, UnitText } from "../../src/types";
import { pagePng, rawUnitPath, unitOf, unitPages, unitTextPath } from "../books";
import { DPI, type Box, type RawAnchor, type RawPage, type RawUnit } from "./raw";
import { info } from "../lib/report";

const PX = DPI / 72; // pt → render px

interface Word extends Box {
  text: string;
}

interface Line extends Box {
  words: Word[];
  text: string;
  /** Median word height (≈ font size). */
  fh: number;
  /** Largest gap between consecutive words, pt. */
  maxGap: number;
  column: 0 | 1;
  /** Index of the column segment this line belongs to (reading order). */
  seg: number;
}

interface PageText {
  pdfPage: number;
  width: number;
  height: number;
  lines: Line[];
}

// --- parsing --------------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function parsePages(pdf: string, first: number, last: number): { width: number; height: number; lines: Word[][] }[] {
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-f", String(first), "-l", String(last), pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const pages: { width: number; height: number; lines: Word[][] }[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const lineRe = /<line [^>]*>([\s\S]*?)<\/line>/g;
  const wordRe = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
  for (const pm of xml.matchAll(pageRe)) {
    const lines: Word[][] = [];
    for (const lm of pm[3].matchAll(lineRe)) {
      const words = [...lm[1].matchAll(wordRe)]
        .map((w) => ({ l: +w[1], t: +w[2], r: +w[3], b: +w[4], text: decode(w[5]) }))
        // Rotated text (axis labels, token strips in figures, the arXiv watermark) reads as tall narrow words.
        .filter((w) => !(w.text.length >= 3 && w.b - w.t > 1.5 * (w.r - w.l)));
      if (words.length) lines.push(words);
    }
    pages.push({ width: +pm[1], height: +pm[2], lines });
  }
  return pages;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

function makeLine(words: Word[]): Omit<Line, "column" | "seg"> {
  words.sort((a, b) => a.l - b.l);
  let maxGap = 0;
  for (let i = 1; i < words.length; i++) maxGap = Math.max(maxGap, words[i].l - words[i - 1].r);
  return {
    words,
    l: Math.min(...words.map((w) => w.l)),
    // Vertical extent from the typical word: inline-math glyphs have tall boxes that would
    // otherwise make the line overlap its neighbours.
    t: median(words.map((w) => w.t)),
    r: Math.max(...words.map((w) => w.r)),
    b: median(words.map((w) => w.b)),
    text: words.map((w) => w.text).join(" "),
    fh: median(words.map((w) => w.b - w.t)),
    maxGap,
  };
}

// --- layout -----------------------------------------------------------------------

interface Layout {
  twoCol: boolean;
  mid: number;
  cols: { l: number; r: number }[];
  bodyFh: number;
}

function detectLayout(lines: Omit<Line, "column" | "seg">[], width: number): Layout {
  const body = lines.filter((l) => l.words.length >= 4 && l.r - l.l > 0.15 * width);
  const bodyFh = median(body.map((l) => l.fh)) || 10;
  const half = width / 2;
  const left = body.filter((l) => l.r < half + 6);
  const right = body.filter((l) => l.l > half - 6);
  const twoCol = left.length >= 5 && right.length >= 5 && (left.length + right.length) / Math.max(1, body.length) > 0.6;
  if (!twoCol) {
    return { twoCol, mid: half, cols: [{ l: quantile(body.map((l) => l.l), 0.1), r: quantile(body.map((l) => l.r), 0.9) }], bodyFh };
  }
  const lR = quantile(left.map((l) => l.r), 0.9);
  const rL = quantile(right.map((l) => l.l), 0.1);
  return {
    twoCol,
    mid: (lR + rL) / 2,
    cols: [
      { l: quantile(left.map((l) => l.l), 0.1), r: lR },
      { l: rL, r: quantile(right.map((l) => l.r), 0.9) },
    ],
    bodyFh,
  };
}

/** Merge line fragments on the same row (e.g. "3.1" + "Encoder and Decoder Stacks", an equation and its "(1)"). */
function mergeRows(lines: Omit<Line, "column" | "seg">[], layout: Layout, width: number) {
  const sorted = [...lines].sort((a, b) => a.t - b.t || a.l - b.l);
  const out: Omit<Line, "column" | "seg">[] = [];
  for (const ln of sorted) {
    const prev = out.find((o) => {
      const overlap = Math.min(o.b, ln.b) - Math.max(o.t, ln.t);
      // Tiny fragments (sub/superscripts split off by the text layer) join a neighbouring line they touch.
      const tiny = ln.text.replace(/\s/g, "").length <= 6 && ln.fh < 0.75 * o.fh && ln.l >= o.l - 2 && ln.r <= o.r + 0.05 * width;
      if (tiny && overlap > -0.3 * o.fh) return true;
      if (overlap < 0.6 * Math.min(o.b - o.t, ln.b - ln.t)) return false;
      if (Math.max(o.fh, ln.fh) > 1.4 * Math.min(o.fh, ln.fh) && ln.words.length > 1 && o.words.length > 1) return false;
      if (layout.twoCol && (o.r < layout.mid) !== (ln.r < layout.mid) && (o.l > layout.mid) !== (ln.l > layout.mid)) return false;
      const gap = Math.max(ln.l - o.r, o.l - ln.r);
      return gap < 0.3 * width;
    });
    if (prev) Object.assign(prev, makeLine([...prev.words, ...ln.words]));
    else out.push({ ...ln });
  }
  return out;
}

// --- page reading order -------------------------------------------------------------

export function readPage(page: { width: number; height: number; lines: Word[][] }, pdfPage: number): { text: PageText; layout: Layout } {
  // Drop rotated / margin text (arXiv watermark) and empty lines.
  let raw = page.lines
    .map(makeLine)
    .filter((l) => !(l.b - l.t > 40 && l.r - l.l < 40) && l.r > 0.08 * page.width && l.text.trim());
  const layout0 = detectLayout(raw, page.width);
  raw = mergeRows(raw, layout0, page.width);
  const layout = detectLayout(raw, page.width);
  // Page numbers / running footers, and running headers in the top margin (e.g. ACM "Paper Session: …").
  raw = raw.filter((l) => !(/^\d{1,3}$/.test(l.text.trim()) && (l.t > 0.9 * page.height || l.b < 0.08 * page.height)));
  raw = raw.filter((l) => l.b > 0.07 * page.height);

  const lines: Line[] = [];
  if (!layout.twoCol) {
    for (const l of raw.sort((a, b) => a.t - b.t)) lines.push({ ...l, column: 0, seg: 0 });
  } else {
    // Bands separated by full-width lines; within a band, left column then right.
    const spans = (l: Omit<Line, "column" | "seg">) => l.l < layout.mid - 8 && l.r > layout.mid + 8;
    const sorted = raw.sort((a, b) => a.t - b.t);
    let seg = 0;
    let band: Omit<Line, "column" | "seg">[] = [];
    const flush = () => {
      const left = band.filter((l) => (l.l + l.r) / 2 < layout.mid);
      const right = band.filter((l) => (l.l + l.r) / 2 >= layout.mid);
      if (left.length) {
        for (const l of left) lines.push({ ...l, column: 0, seg });
        seg++;
      }
      if (right.length) {
        for (const l of right) lines.push({ ...l, column: 1, seg });
        seg++;
      }
      band = [];
    };
    for (const l of sorted) {
      if (spans(l)) {
        flush();
        lines.push({ ...l, column: 0, seg });
        // Consecutive spanning lines share a segment.
        const next = sorted[sorted.indexOf(l) + 1];
        if (!next || !spans(next)) seg++;
      } else band.push(l);
    }
    flush();
  }
  return { text: { pdfPage, width: page.width, height: page.height, lines }, layout };
}

// --- ink (refines figure/table regions and the crop) ----------------------------------

interface Ink {
  w: number;
  h: number;
  data: Buffer;
}

async function loadInk(slug: string, pdfPage: number): Promise<Ink> {
  const { data, info } = await sharp(pagePng(slug, pdfPage)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data };
}

/** First/last rows (pt) with ink in a pt box, or null. */
function inkRows(ink: Ink, box: Box): { t: number; b: number; l: number; r: number } | null {
  const x0 = Math.max(0, Math.floor(box.l * PX));
  const x1 = Math.min(ink.w, Math.ceil(box.r * PX));
  const y0 = Math.max(0, Math.floor(box.t * PX));
  const y1 = Math.min(ink.h, Math.ceil(box.b * PX));
  let t = -1;
  let b = -1;
  let l = Infinity;
  let r = -Infinity;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++)
      if (ink.data[y * ink.w + x] < 200) {
        n++;
        if (x < l) l = x;
        if (x > r) r = x;
      }
    if (n > 1) {
      if (t < 0) t = y;
      b = y;
    }
  }
  return t < 0 ? null : { t: t / PX, b: b / PX, l: l / PX, r: r / PX };
}

/** Fraction of inked pixels in a pt box. */
function inkDensity(ink: Ink, box: Box): number {
  const x0 = Math.max(0, Math.floor(box.l * PX));
  const x1 = Math.min(ink.w, Math.ceil(box.r * PX));
  const y0 = Math.max(0, Math.floor(box.t * PX));
  const y1 = Math.min(ink.h, Math.ceil(box.b * PX));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink.data[y * ink.w + x] < 200) n++;
  return n / Math.max(1, (x1 - x0) * (y1 - y0));
}

// --- anchors ---------------------------------------------------------------------------

type Kind = Anchor["kind"];

interface Draft {
  kind: Kind;
  pdfPage: number;
  column: 0 | 1;
  box: Box;
  lines: string[];
  /** Section id (headings). */
  section?: string;
  title?: string;
}

const HEADING_WORDS = /^(abstract|references|bibliography|acknowledge?ments?|appendix|appendices|conclusions?|introduction)$/i;
const CAPTION = /^(Figure|Fig\.|Table)\s*([A-Z]?\d+)[:.]/;

/** "Attention Visualizations", "A Proof of Theorem 1": short Title Case line (appendix headings are often unnumbered). */
const TITLE_CASE = /^(?:[A-Z][A-Za-z\-]*|[A-Z]\d*|of|and|the|for|in|on|a|an|to|with|vs\.?)(?:\s+(?:[A-Z][A-Za-z\-]*|\d+|of|and|the|for|in|on|a|an|to|with|vs\.?)){0,7}$/;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** Is `c` a plausible next section number after `last` (e.g. 3.2.1 → 3.2.2, 3.3, 4, 3.2.1.1)? */
function successor(last: number[], c: number[]): boolean {
  if (!last.length) return c.length === 1;
  if (c.length === last.length + 1) return c.slice(0, -1).every((v, i) => v === last[i]) && c[c.length - 1] === 1;
  if (c.length > last.length) return false;
  const k = c.length;
  return c.slice(0, k - 1).every((v, i) => v === last[i]) && c[k - 1] === last[k - 1] + 1;
}

function joinText(lines: string[]): string {
  return lines.reduce((acc, l) => {
    if (!acc) return l;
    if (/[a-z]-$/.test(acc) && /^[a-z]/.test(l)) return acc.slice(0, -1) + l;
    return `${acc} ${l}`;
  }, "");
}

const unionBox = (a: Box, b: Box): Box => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });

export async function textAnchors(book: BookConfig, unitId: string): Promise<void> {
  const unit = unitOf(book, unitId);
  const pdfPages = unitPages(book, unitId);
  const parsed = parsePages(book.source.pdf, pdfPages[0], pdfPages[pdfPages.length - 1]);
  if (parsed.length !== pdfPages.length) throw new Error(`${book.slug}/${unitId}: expected ${pdfPages.length} pages, got ${parsed.length}`);

  const drafts: Draft[] = [];
  const pagesOut: { pdfPage: number; width: number; height: number; content: Box | null }[] = [];
  let lastNum: number[] = [];
  let seenHeading = false;
  /** Past the References heading: unnumbered Title Case lines are appendix headings. */
  let afterRefs = false;
  let bodyFhUnit = 0;

  for (const [pi, pdfPage] of pdfPages.entries()) {
    const pageStart = drafts.length;
    const { text: page, layout } = readPage(parsed[pi], pdfPage);
    const ink = await loadInk(book.slug, pdfPage);
    // Hidden text (invisible labels, text under images): no ink under it, or it overlaps a
    // visible line whose ink is denser.
    page.lines = page.lines.filter((l) => inkRows(ink, l) !== null);
    const hidden = new Set<Line>();
    for (const a of page.lines)
      for (const b of page.lines) {
        if (a === b || hidden.has(a) || hidden.has(b)) continue;
        const ow = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const oh = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        if (ow <= 0 || oh <= 0) continue;
        const small = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
        const sizeRatio = Math.max(a.fh, b.fh) / Math.min(a.fh, b.fh);
        if (ow * oh < (sizeRatio > 1.3 ? 0.3 : 0.8) * small) continue;
        hidden.add(inkDensity(ink, a) < inkDensity(ink, b) ? a : b);
      }
    page.lines = page.lines.filter((l) => !hidden.has(l));
    bodyFhUnit ||= layout.bodyFh;
    const fh = layout.bodyFh || bodyFhUnit;
    const colOf = (l: Line) => (layout.twoCol ? layout.cols[l.column] : layout.cols[0]);
    const isSpanning = (l: Line) => layout.twoCol && l.l < layout.mid - 8 && l.r > layout.mid + 8;
    const extent = (l: Line) => (isSpanning(l) ? { l: layout.cols[0].l, r: layout.cols[layout.cols.length - 1].r } : colOf(l));
    const proseLike = (l: Line) => {
      const c = extent(l);
      const w = c.r - c.l;
      return l.r - l.l > 0.6 * w && l.l < c.l + 0.06 * w && l.maxGap < 1.2 * fh && l.fh < 1.25 * fh;
    };

    // Typical baseline-to-baseline pitch of body text on this page (paragraph breaks add space on top).
    const pitches: number[] = [];
    for (let k = 1; k < page.lines.length; k++) {
      const [a, b] = [page.lines[k - 1], page.lines[k]];
      const d = b.b - a.b;
      if (a.seg === b.seg && d > 0.8 * fh && d < 1.6 * fh && a.words.length > 5 && b.words.length > 5) pitches.push(d);
    }
    const pitch = median(pitches) || 1.2 * fh;

    const headingLike = (l: Line) => {
      const t = l.text.trim();
      return (
        /^((?:\d+\.)*\d+)\.?\s+[A-Z]/.test(t) ||
        HEADING_WORDS.test(t) ||
        (afterRefs && TITLE_CASE.test(t)) ||
        (l.fh > 1.12 * fh && l.words.length <= 8 && /^[A-Z]/.test(t) && !/[.,;:]$/.test(t) && /^[A-Za-z][A-Za-z\s\-:]*$/.test(t))
      );
    };

    // Group lines by segment (a column within a band) in reading order.
    const segs = new Map<number, Line[]>();
    for (const l of page.lines) {
      if (!segs.has(l.seg)) segs.set(l.seg, []);
      segs.get(l.seg)!.push(l);
    }

    const consumed = new Set<Line>();
    const zoneDrafts = new Map<Line, Draft>(); // first line of zone → draft (inserted in order)

    // 1. Figure and table zones.
    for (const seg of segs.values()) {
      for (let i = 0; i < seg.length; i++) {
        const cap = seg[i];
        const m = CAPTION.exec(cap.text.trim());
        if (!m || consumed.has(cap)) continue;
        const isTable = m[1] === "Table";
        // Caption block: following lines with tight spacing.
        let j = i;
        while (j + 1 < seg.length && seg[j + 1].t - seg[j].b < 0.45 * fh && !CAPTION.test(seg[j + 1].text)) j++;
        const caption = seg.slice(i, j + 1);
        const ext = extent(cap);
        let zone = caption.reduce<Box>((bx, l) => unionBox(bx, l), caption[0]);
        const members = [...caption];
        // Graphics above the caption (figures; tables whose caption sits below them).
        const above: Line[] = [];
        for (let k = i - 1; k >= 0 && !consumed.has(seg[k]); k--) {
          const l = seg[k];
          if (proseLike(l) || CAPTION.test(l.text) || headingLike(l)) break;
          above.push(l);
        }
        // Table body below the caption (captions above tables).
        const below: Line[] = [];
        if (isTable) {
          for (let k = j + 1; k < seg.length; k++) {
            const l = seg[k];
            if (CAPTION.test(l.text) || headingLike(l) || (proseLike(l) && l.maxGap < 1.2 * fh)) break;
            below.push(l);
          }
        }
        const useBelow = isTable && below.length > 0 && (above.length === 0 || below.length >= above.length);
        if (useBelow) members.push(...below);
        else members.push(...above);
        for (const l of members) zone = unionBox(zone, l);
        // Refine with ink: extend to the graphics between the neighbouring prose lines.
        // Nearest text above/below that overlaps this column horizontally (any segment: a full-width
        // title above a right-column figure bounds it too).
        const overlapsX = (l: Line) => Math.min(l.r, ext.r) - Math.max(l.l, ext.l) > 10;
        const others = page.lines.filter((l) => !members.includes(l) && overlapsX(l) && !consumed.has(l));
        const prev = others.filter((l) => l.b <= zone.t + 1).sort((a, b) => b.b - a.b)[0];
        const next = others.filter((l) => l.t >= zone.b - 1).sort((a, b) => a.t - b.t)[0];
        if (!useBelow) {
          const top = prev ? prev.b + 1 : 0.06 * page.height;
          const r = inkRows(ink, { l: ext.l - 4, r: ext.r + 4, t: top, b: zone.t });
          if (r) zone = unionBox(zone, { l: Math.max(ext.l - 4, r.l), r: Math.min(ext.r + 4, r.r), t: r.t, b: zone.b });
        } else {
          const bottom = next ? next.t - 1 : 0.94 * page.height;
          const r = inkRows(ink, { l: ext.l - 4, r: ext.r + 4, t: zone.b, b: bottom });
          if (r) zone = unionBox(zone, { l: Math.max(ext.l - 4, r.l), r: Math.min(ext.r + 4, r.r), t: zone.t, b: r.b });
        }
        // Lines that the refined zone swallowed (labels inside a raster figure etc.).
        for (const l of seg) if (l.t >= zone.t - 1 && l.b <= zone.b + 1 && !proseLike(l)) members.push(l);
        for (const l of members) consumed.add(l);
        const first = members.reduce((a, b) => (seg.indexOf(a) < seg.indexOf(b) ? a : b));
        zoneDrafts.set(first, {
          kind: isTable ? "table" : "figure",
          pdfPage,
          column: cap.column,
          box: zone,
          lines: caption.map((l) => l.text),
        });
      }
    }

    // 2. Everything else, in reading order.
    let cur: Draft | null = null;
    /** An earlier paragraph (previous column/page) that the current lines continue. */
    let cont: Draft | null = null;
    let prevLine: Line | null = null;
    const close = () => {
      if (cur) drafts.push(cur);
      cur = null;
    };
    const start = (kind: Kind, l: Line, extra: Partial<Draft> = {}) => {
      close();
      cont = null;
      cur = { kind, pdfPage, column: l.column, box: { l: l.l, t: l.t, r: l.r, b: l.b }, lines: [l.text], ...extra };
    };
    const add = (l: Line) => {
      cur!.box = unionBox(cur!.box, l);
      cur!.lines.push(l.text);
    };
    // Read through functions so TS doesn't narrow `cur` across the closures that reassign it.
    const now = (): Draft | null => cur;
    const curKind = (): Kind | null => now()?.kind ?? null;

    for (const l of page.lines) {
      if (prevLine && prevLine.seg !== l.seg) close();
      if (zoneDrafts.has(l)) {
        close();
        cont = null;
        drafts.push(zoneDrafts.get(l)!);
        prevLine = null;
        continue;
      }
      if (consumed.has(l)) continue;
      const c = extent(l);
      const colW = c.r - c.l;
      const centre = (l.l + l.r) / 2;
      const centred = Math.abs(centre - (c.l + c.r) / 2) < 0.12 * colW && l.r - l.l < 0.8 * colW;
      const samePrev = prevLine && prevLine.seg === l.seg ? prevLine : null;
      const gapAbove = samePrev ? l.t - samePrev.b : Infinity;
      const txt = l.text.trim();
      prevLine = l;

      // Headings.
      const numM = /^((?:\d+\.)*\d+)\.?\s+([A-Z0-9].{0,90})$/.exec(txt);
      // Reject chart axis tick rows ("1 2 3 4 …", "0.00024 0.00011"): a heading title needs words.
      const titleHasWords = (t: string) => {
        const chars = t.replace(/\s/g, "");
        const letters = (chars.match(/[A-Za-z]/g) ?? []).length;
        return /[A-Za-z]{3,}/.test(t) && letters >= 0.5 * chars.length;
      };
      const num = numM && titleHasWords(numM[2]) ? numM : null;
      // Numbered headings can run nearly the full column width ("3 MALLOC PROGRAMMING LAB OVERVIEW").
      const short = (l.r - l.l < 0.85 * colW || (num !== null && txt.length <= 70)) && !/[.,;]$/.test(txt);
      let heading: { id: string; title: string } | null = null;
      if (num && short && gapAbove > 0.3 * fh) {
        const parts = num[1].split(".").map(Number);
        if (successor(lastNum, parts)) {
          heading = { id: num[1], title: num[2].trim() };
          lastNum = parts;
        }
      }
      if (!heading && short && txt.length < 60 && afterRefs && !/^\[\d/.test(txt) && TITLE_CASE.test(txt) && gapAbove > 0.5 * fh) {
        heading = { id: slugify(txt), title: txt };
      }
      if (!heading && short && txt.length < 60 && (HEADING_WORDS.test(txt) || (l.fh > 1.12 * fh && seenHeading && gapAbove > 0.5 * fh && /^[A-Z][A-Za-z\s\-:]*$/.test(txt)))) {
        heading = { id: slugify(txt), title: txt };
      }
      if (heading) {
        seenHeading = true;
        if (heading.id === "references" || heading.id === "bibliography") afterRefs = true;
        start("heading", l, { section: heading.id, title: heading.title });
        close();
        continue;
      }

      // Front matter: everything before the first heading (title, authors, notices).
      if (!seenHeading) {
        if (curKind() === "other" && gapAbove < 1.6 * fh) add(l);
        else start("other", l);
        continue;
      }

      // Footnotes: small type in the lower part of the page.
      // A footnote starts after a gap (the rule above it) with a marker or in clearly smaller type;
      // following small lines continue it.
      const small = l.fh < 0.94 * fh && l.t > 0.55 * page.height;
      if (small && curKind() === "other" && gapAbove < 0.6 * fh) {
        add(l);
        continue;
      }
      if (small && gapAbove > 0.6 * fh && (/^[\d∗†‡§*]/.test(txt) || l.fh < 0.88 * fh)) {
        start("other", l);
        continue;
      }

      // Display equations: an "(n)" tag at the right edge, or a centred short line that isn't prose.
      const tagged = /\(\d+[a-z]?\)$/.test(txt) && l.r > c.r - 0.06 * colW && l.maxGap > 1.5 * fh;
      const wordy = l.words.filter((w) => /^[a-z]{3,}[,.;:]?$/.test(w.text)).length / l.words.length;
      if (tagged || (centred && !proseLike(l) && l.words.length < 14 && wordy < 0.5)) {
        if (curKind() === "equation" && gapAbove < 1.2 * fh) add(l);
        else start("equation", l);
        continue;
      }

      // Prose: a new paragraph on extra vertical space, a first-line indent after a short line,
      // or a new reference entry.
      // Indent relative to the line above (handles indented blocks like the abstract); "short" relative
      // to the paragraph's own right edge.
      const curPara = curKind() === "para" ? now() : null;
      const indent = samePrev ? l.l - samePrev.l > 0.8 * fh : l.l - c.l > 0.8 * fh;
      const paraR = curPara ? curPara.box.r : c.r;
      const prevShort = samePrev ? samePrev.r < Math.min(paraR, c.r) - 1.5 * fh : false;
      const inRefs = drafts.some((d) => d.kind === "heading" && d.section === "references");
      const isRef = /^\[\d+\]/.test(txt);
      const linePitch = samePrev ? l.b - samePrev.b : Infinity;
      const breaks = !samePrev || linePitch > 1.3 * pitch || (isRef && inRefs) || (!inRefs && indent && (prevShort || gapAbove > 0.25 * fh));
      if (!breaks && curKind() === "para") add(l);
      else if (!breaks && cont) cont.lines.push(l.text);
      else if (!samePrev && !cur && !indent && !isRef && openPara(drafts)) {
        // Top of a new column/page continuing the previous paragraph: the text joins it,
        // the anchor stays where the paragraph began.
        cont = openPara(drafts);
        cont!.lines.push(l.text);
      } else start("para", l);
    }
    close();
    foldFractions(drafts, pageStart, fh, layout.cols[0].r - layout.cols[0].l);

    // Content extent for the crop: ink inside the page minus margins/watermark/page numbers.
    const kept = page.lines;
    const textBox = kept.reduce<Box | null>((bx, l) => (bx ? unionBox(bx, l) : { l: l.l, t: l.t, r: l.r, b: l.b }), null);
    const inkBox = inkRows(ink, { l: 0.08 * page.width, r: 0.97 * page.width, t: 0.03 * page.height, b: 0.94 * page.height });
    const content = textBox && inkBox ? unionBox(textBox, { l: inkBox.l, r: inkBox.r, t: inkBox.t, b: inkBox.b }) : textBox;
    pagesOut.push({ pdfPage, width: page.width, height: page.height, content });
  }

  // Assign ids in reading order.
  const unitSection0 = `${unitId}-0`;
  let section = unitSection0;
  let n = 0;
  const anchors: RawAnchor[] = [];
  const sections: RawUnit["sections"] = [];
  const used = new Set<string>();
  const toPx = (b: Box): Box => ({ l: b.l * PX, t: b.t * PX, r: b.r * PX, b: b.b * PX });
  for (const d of drafts) {
    if (d.kind === "heading") {
      let id = d.section!;
      for (let k = 2; used.has(`${id}-h`); k++) id = `${d.section}-${k}`;
      section = id;
      n = 0;
      sections.push({ id, title: d.title!, pdfPage: d.pdfPage, top: d.box.t * PX });
      anchors.push({ id: `${id}-h`, section, pdfPage: d.pdfPage, kind: "heading", column: d.column, box: toPx(d.box), text: d.lines.join(" ") });
      used.add(`${id}-h`);
      continue;
    }
    n += 1;
    anchors.push({ id: `${section}-p${n}`, section, pdfPage: d.pdfPage, kind: d.kind, column: d.column, box: toPx(d.box), text: joinText(d.lines) });
  }

  // One crop for every page of the unit (pages line up when stacked).
  const PAD = 14; // pt
  const boxes = pagesOut.map((p) => p.content).filter((b): b is Box => !!b);
  const all = boxes.reduce(unionBox);
  const crop = {
    left: Math.round((all.l - PAD) * PX),
    top: Math.round((all.t - PAD) * PX),
    width: Math.round((all.r - all.l + 2 * PAD) * PX),
    height: Math.round((all.b - all.t + 2 * PAD) * PX),
  };
  const pages: RawPage[] = pagesOut.map((p, i) => ({
    pdfPage: p.pdfPage,
    label: String(i + 1),
    width: Math.round(p.width * PX),
    height: Math.round(p.height * PX),
    crop,
  }));

  const raw: RawUnit = { book: book.slug, unit: unitId, title: unit.title, pages, sections, anchors };
  const text: UnitText = { book: book.slug, unit: unitId, text: Object.fromEntries(anchors.map((a) => [a.id, a.text])) };
  for (const [file, data] of [[rawUnitPath(book.slug, unitId), raw], [unitTextPath(book.slug, unitId), text]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  const counts = anchors.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  info(`anchors: ${book.slug}/${unitId} ${anchors.length} ${JSON.stringify(counts)} sections ${sections.map((s) => s.id).join(",")}`);
}

/** The last draft if it is a paragraph whose text doesn't end a sentence (it may continue). */
function openPara(drafts: Draft[]): Draft | null {
  for (let i = drafts.length - 1; i >= 0; i--) {
    const d = drafts[i];
    if (d.kind === "figure" || d.kind === "table" || d.kind === "other") continue; // floats and footnotes interrupt
    if (d.kind !== "para") return null;
    return /[.:?!)\]]$/.test((d.lines[d.lines.length - 1] ?? "").trim()) ? null : d;
  }
  return null;
}

/**
 * Display equations whose fraction parts (numerator / denominator) came out as
 * their own short lines: fold single-line, narrow paragraphs touching an equation into it.
 */
function foldFractions(drafts: Draft[], from: number, fh: number, colW: number) {
  for (let i = drafts.length - 1; i >= from; i--) {
    const d = drafts[i];
    if (d.kind !== "para" || d.lines.length !== 1 || d.box.r - d.box.l > 0.3 * colW) continue;
    const near = (e: Draft | undefined) =>
      e && e.kind === "equation" && e.pdfPage === d.pdfPage && Math.max(e.box.t - d.box.b, d.box.t - e.box.b) < 1.0 * fh;
    const target = near(drafts[i + 1]) ? drafts[i + 1] : near(drafts[i - 1]) ? drafts[i - 1] : null;
    if (!target) continue;
    target.box = unionBox(target.box, d.box);
    if (d.box.t < target.box.t + 1) target.lines.unshift(d.lines[0]);
    else target.lines.push(d.lines[0]);
    drafts.splice(i, 1);
  }
}
