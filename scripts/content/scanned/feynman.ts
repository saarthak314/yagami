// Scanned-book adapter, layout "feynman": local OCR → paragraph anchors. No model calls.
//
// For each rendered page we run tesseract (TSV), rebuild physical lines, find
// the main text column, and walk the column lines top to bottom grouping them
// into anchors: section headings, prose paragraphs (new one at each indented
// line), display equations (centred / low-confidence lines) and figures (large
// ink regions inside the column). Margin content (section list, figure
// captions, margin figures) is ignored.
//
// Tuned to the Basic Books 1963 edition: chapter-numbered sections ("13-2"), the
// section list printed in the margin of a chapter's first page, and a sidebar
// column that alternates sides (right on odd pages, left on even).
//
// Output (pipeline-only, never served):
//   work/<slug>/anchors/<unit>.raw.json — RawUnit: anchors with pixel boxes + page crops
//   work/<slug>/text/<unit>.json        — UnitText: OCR text per anchor id

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { BookConfig, UnitText } from "../../../src/types";
import { pagePng as pagePngOf, rawUnitPath, unitOf, unitPages, unitTextPath } from "../../books";
import { pool } from "../../lib/claude";
import type { RawPage, RawUnit } from "../raw";
import { readWords as readWordsOf, tesseractPage, type Word } from "./tesseract";
import { info } from "../../lib/report";

// Book being processed (set by feynmanAnchors; the helpers below read it).
let slug = "";
const pagePng = (p: number) => pagePngOf(slug, p);
const readWords = (p: number) => readWordsOf(slug, p);

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface Line extends Box {
  conf: number;
  text: string;
}

interface PageInfo {
  pdfPage: number;
  label: string;
  /** 1-based page number within the chapter (odd pages have the sidebar on the right). */
  index: number;
  width: number;
  height: number;
  colL: number;
  colR: number;
  /** Top of the first and bottom of the last line inside the crop area. */
  top: number;
  bottom: number;
}

type AnchorKind = "para" | "heading" | "equation" | "figure" | "other";

interface OcrAnchor {
  id: string;
  section: string;
  pdfPage: number;
  kind: AnchorKind;
  box: Box;
  text: string;
}

const PAD = 50; // px at 300dpi around the content box
const SIDEBAR = 0.6; // sidebar width as a fraction of the text column width

/**
 * Same crop size across a chapter: the main text column plus the sidebar on the
 * side the book prints it (right on odd pages, left on even), so pages line up.
 */
function crops(pages: PageInfo[]): Map<number, RawPage["crop"]> {
  const colWs = pages.map((p) => p.colR - p.colL).sort((a, b) => a - b);
  const colW = colWs[Math.floor(colWs.length / 2)];
  const width = Math.round(colW + SIDEBAR * colW + 2 * PAD);
  const height = Math.round(Math.max(...pages.map((p) => p.bottom - p.top)) + 2 * PAD);
  const out = new Map<number, RawPage["crop"]>();
  for (const p of pages) {
    const left = p.index % 2 ? p.colL - PAD : p.colR + PAD - width;
    out.set(p.pdfPage, { left: Math.round(left), top: Math.round(p.top - PAD), width, height });
  }
  return out;
}

// --- line reconstruction ----------------------------------------------------

function pageLines(p: number, keep: (w: Word) => boolean = () => true): Line[] {
  const groups = new Map<string, Word[]>();
  for (const w of readWords(p).filter(keep)) {
    const k = `${w.block}.${w.par}.${w.line}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(w);
  }
  return [...groups.values()]
    .map((ws) => {
      ws.sort((a, b) => a.left - b.left);
      return {
        l: Math.min(...ws.map((w) => w.left)),
        t: Math.min(...ws.map((w) => w.top)),
        r: Math.max(...ws.map((w) => w.left + w.width)),
        b: Math.max(...ws.map((w) => w.top + w.height)),
        conf: ws.reduce((s, w) => s + w.conf, 0) / ws.length,
        text: ws.map((w) => w.text).join(" "),
      };
    })
    .sort((a, b) => a.t - b.t);
}

function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/** Merge column lines that sit on the same baseline (tesseract splits lines around inline math). */
function mergeSameRow(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const ln of lines) {
    const prev = out.find((o) => {
      const overlap = Math.min(o.b, ln.b) - Math.max(o.t, ln.t);
      return overlap > 0.5 * Math.min(o.b - o.t, ln.b - ln.t);
    });
    if (prev) {
      const left = prev.l <= ln.l ? prev : ln;
      const right = prev.l <= ln.l ? ln : prev;
      prev.text = `${left.text} ${right.text}`;
      prev.conf = (prev.conf + ln.conf) / 2;
      prev.l = Math.min(prev.l, ln.l);
      prev.r = Math.max(prev.r, ln.r);
      prev.t = Math.min(prev.t, ln.t);
      prev.b = Math.max(prev.b, ln.b);
    } else out.push({ ...ln });
  }
  return out.sort((a, b) => a.t - b.t);
}

const alphaRatio = (s: string) => {
  const chars = s.replace(/\s/g, "");
  if (!chars) return 0;
  return (chars.match(/[A-Za-z]/g)?.length ?? 0) / chars.length;
};

// --- page ink (for figures with little or no OCR text) ----------------------

async function inkStats(p: number, box: Box, rowMin = 2): Promise<{ fraction: number; rows: number; first: number; last: number }> {
  const meta = await sharp(pagePng(p)).metadata();
  const left = Math.max(0, Math.round(box.l));
  const top = Math.max(0, Math.round(box.t));
  const width = Math.min(meta.width! - left, Math.round(box.r - box.l));
  const height = Math.min(meta.height! - top, Math.round(box.b - box.t));
  if (width < 4 || height < 4) return { fraction: 0, rows: 0, first: 0, last: 0 };
  const { data } = await sharp(pagePng(p)).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  let rows = 0;
  let first = -1;
  let last = -1;
  for (let y = 0; y < height; y++) {
    let r = 0;
    for (let x = 0; x < width; x++) if (data[y * width + x] < 128) r++;
    ink += r;
    if (r > rowMin) {
      rows++;
      if (first < 0) first = y;
      last = y;
    }
  }
  return { fraction: ink / data.length, rows, first: top + first, last: top + last };
}

// --- main -------------------------------------------------------------------

type Cls = "heading" | "body" | "display" | "footnote";

interface Draft {
  kind: AnchorKind;
  pdfPage: number;
  box: Box;
  lines: string[];
  confs: number[];
  section?: string;
  title?: string;
}

export async function feynmanAnchors(book: BookConfig, unitId: string): Promise<void> {
  slug = book.slug;
  const cfg = unitOf(book, unitId);
  const chapter = Number(unitId);
  const pdfPages = unitPages(book, unitId);
  await pool(pdfPages, 8, (p) => tesseractPage(slug, p));

  const headingRe = new RegExp(`^${chapter}\\s?[-–—~=]\\s?(\\d{1,2})[.,]?\\s+(\\S.*)$`);
  const pages: PageInfo[] = [];
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  // Read through a function so TS doesn't narrow `cur` across the closures that reassign it.
  const now = (): Draft | null => cur;
  let titleSeen = false;
  let canon: { n: number; title: string }[] = [];
  let lastSection = 0;
  /** Section number if this column line is a section heading. */
  const headingOf = (l: Line, colW: number): { n: number; title: string } | null => {
    if (l.r - l.l > 0.85 * colW || l.conf < 40) return null;
    const m = /^(\S{1,6})\s+(\S.*)$/.exec(l.text.trim());
    if (m && canon.length) {
      let best: { n: number; title: string } | null = null;
      let score = 0;
      for (const c of canon) {
        const sc = similarity(norm(m[2]), norm(c.title));
        if (sc > score) [best, score] = [c, sc];
      }
      if (best && score >= 0.75 && best.n > lastSection) {
        const own = cleanTitle(m[2]);
        return { n: best.n, title: wordScore(own) >= wordScore(best.title) ? own : best.title };
      }
    }
    const r = headingRe.exec(l.text.trim());
    if (r && Number(r[1]) === lastSection + 1) return { n: Number(r[1]), title: cleanTitle(r[2]) };
    return null;
  };

  for (const [i, p] of pdfPages.entries()) {
    const meta = await sharp(pagePng(p)).metadata();
    const all = pageLines(p);

    // Main column from wide, confident lines.
    const wide = all.filter((l) => l.r - l.l > 900 && l.conf > 60);
    const colL = quantile(wide.map((l) => l.l), 0.25);
    const colR = quantile(wide.map((l) => l.r), 0.5);
    const colW = colR - colL;
    const index = i + 1;

    // Crop-relevant vertical extent: confident lines in column + sidebar on this page's side.
    const sideL = index % 2 ? colL - 60 : colL - 0.6 * colW;
    const sideR = index % 2 ? colR + 0.6 * colW : colR + 60;
    const inCrop = all.filter(
      (l) => l.l >= sideL && l.r <= sideR && (l.conf > 50 || l.r - l.l > 200 || (i === 0 && /^\d{1,2}$/.test(l.text.trim()))),
    );

    if (i === 0) canon = marginSections(chapter, all, colR);

    // Column lines rebuilt from the words inside the column (tesseract sometimes joins a body
    // line with the margin text beside it).
    let col = mergeSameRow(
      pageLines(p, (w) => w.left >= colL - 50 && w.left + w.width <= colR + 60).filter((l) => l.r - l.l > 8),
    );

    // Drop the printed page number / footer and stray specks.
    col = col.filter((l, k) => {
      const isFooter = k >= col.length - 2 && /^[\dIl|]{1,2}\s?[-–—~]?\s?[\dIl|]{1,2}$/.test(l.text.trim()) && l.t > meta.height! * 0.85;
      return !isFooter;
    });

    pages.push({
      pdfPage: p,
      label: `${chapter}-${index}`,
      index,
      width: meta.width!,
      height: meta.height!,
      colL,
      colR,
      // Text top, or higher if a figure/photo sits above the first line (skip the scan's edge).
      top: Math.min(...inCrop.map((l) => l.t), (await inkStats(p, { l: sideL, t: 110, r: sideR, b: meta.height! - 110 }, 8)).first || Infinity),
      bottom: Math.max(...inCrop.map((l) => l.b)),
    });

    const classify = (l: Line, k: number): Cls => {
      const indent = l.l - colL;
      if (headingOf(l, colW)) return "heading";
      if (/^[*†‡§]/.test(l.text) && l.t > meta.height! * 0.7 && k > 0 && l.t - col[k - 1].b > 40) return "footnote";
      if (indent <= 130 && (l.conf >= 60 || alphaRatio(l.text) >= 0.7)) return "body";
      return "display";
    };

    const close = () => {
      if (cur) drafts.push(cur);
      cur = null;
    };
    const start = (kind: AnchorKind, l: Line, extra: Partial<Draft> = {}) => {
      close();
      cur = { kind, pdfPage: p, box: { l: l.l, t: l.t, r: l.r, b: l.b }, lines: [l.text], confs: [l.conf], ...extra };
    };
    const extend = (l: Line, samePage: boolean) => {
      const c = cur!;
      c.lines.push(l.text);
      c.confs.push(l.conf);
      if (samePage) {
        c.box.l = Math.min(c.box.l, l.l);
        c.box.r = Math.max(c.box.r, l.r);
        c.box.b = Math.max(c.box.b, l.b);
      }
    };

    let prevLine: Line | null = null;
    let continuing = false;
    let inTable = false;
    for (const [k, l] of col.entries()) {
      // Chapter opening page: the chapter number and title above the first section.
      if (i === 0 && !titleSeen) {
        if (l.text.trim().length >= 4 && alphaRatio(l.text) > 0.6 && l.conf > 80 && !headingOf(l, colW)) {
          start("heading", l, { section: `${chapter}-0`, title: cfg.title });
          titleSeen = true;
          close();
          prevLine = l;
          continue;
        }
        if (!headingOf(l, colW)) continue;
        titleSeen = true;
      }

      // Figure hiding in a large gap with ink but no OCR lines.
      if (prevLine && l.t - prevLine.b > 120) {
        const gap = { l: colL, t: prevLine.b + 8, r: colR, b: l.t - 8 };
        const ink = await inkStats(p, gap);
        if (ink.fraction > 0.004 && ink.rows > 40) {
          const box = { l: colL, t: ink.first, r: colR, b: ink.last };
          const c = now();
          if (ink.last - ink.first < 400 && c?.kind === "equation" && c.pdfPage === p && ink.first - c.box.b < 80) {
            // An equation line tesseract could not read, continuing the current equation.
            c.box.b = Math.max(c.box.b, box.b);
          } else if (c && (c.kind === "equation" || c.kind === "figure") && c.pdfPage === p && ink.first - c.box.b < 150) {
            // Unreadable lines continuing the current equation, or a drawing below its OCR'd labels.
            if (ink.last - ink.first >= 400) c.kind = "figure";
            c.box.b = Math.max(c.box.b, box.b);
          } else {
            close();
            cur = { kind: ink.last - ink.first < 400 ? "equation" : "figure", pdfPage: p, box, lines: [], confs: [] };
          }
        }
      }

      // A table in the column ("Table 9-2" centred above it): one anchor until prose resumes.
      if (/^Table\s*\d/.test(l.text.trim()) && l.l - colL > 100) {
        start("figure", l);
        now()!.box.l = colL;
        now()!.box.r = colR;
        inTable = true;
        prevLine = l;
        continue;
      }
      if (inTable) {
        const words = l.text.match(/[A-Za-z]+/g) ?? [];
        const avgWord = words.reduce((n, w) => n + w.length, 0) / Math.max(1, words.length);
        const prose = l.l - colL > 40 && l.l - colL <= 130 && alphaRatio(l.text) > 0.7 && l.r - l.l > 0.6 * colW && avgWord >= 3.2;
        if (!prose && !headingOf(l, colW)) {
          extend(l, true);
          prevLine = l;
          continue;
        }
        inTable = false;
      }

      // A figure caption printed in the column ("Fig. 7-6. ..."): one figure anchor with the drawing above it.
      if (/^Fig[.,]?\s*\d/.test(l.text.trim()) && l.l - colL > 100) {
        const c = now();
        if (c && (c.kind === "figure" || c.kind === "equation") && c.pdfPage === p && l.t - c.box.b < 100) {
          c.kind = "figure";
          extend(l, true);
        } else {
          const above = { l: colL, t: prevLine ? prevLine.b + 8 : 110, r: colR, b: l.t - 8 };
          const ink = await inkStats(p, above, 8);
          start("figure", l);
          if (ink.rows > 40) now()!.box.t = ink.first;
        }
        now()!.box.l = colL;
        now()!.box.r = colR;
        prevLine = l;
        continue;
      }

      const cls = classify(l, k);
      const samePage = now()?.pdfPage === p;
      const indented = l.l - colL > 40;
      const gapPrev = prevLine ? l.t - prevLine.b : Infinity;

      if (cls === "heading") {
        const h = headingOf(l, colW)!;
        lastSection = h.n;
        start("heading", l, { section: `${chapter}-${h.n}`, title: h.title });
        close();
      } else if (cls === "footnote") {
        start("other", l);
      } else if (cls === "display") {
        const next = col[k + 1];
        const inlineBit =
          now()?.kind === "para" && l.r - l.l < 0.35 * colW && gapPrev < 15 && !!next && classify(next, k + 1) === "body" && next.t - l.b < 15;
        if (inlineBit) extend(l, samePage);
        else if (now()?.kind === "equation" && samePage && l.t - now()!.box.b < 80) extend(l, true);
        else if (now()?.kind === "figure" && samePage && l.t - now()!.box.b < 200) extend(l, true);
        else if (now()?.kind === "other" && samePage && gapPrev < 30) extend(l, true);
        else start("equation", l);
      } else {
        // body text
        const next = col[k + 1];
        const isConnector = l.r - l.l < 0.3 * colW && !indented && next && classify(next, k + 1) === "display" && next.t - l.b < 80;
        if (now()?.kind === "other" && samePage && gapPrev < 30) extend(l, true);
        else if (isConnector && !(now()?.kind === "para" && samePage && gapPrev < 30)) start("equation", l);
        else if (now()?.kind === "para" && !indented && samePage && gapPrev < 90) extend(l, true);
        else if (now()?.kind === "para" && !samePage && !indented && (k === 0 || (continuing && gapPrev < 90))) {
          extend(l, false);
          continuing = true;
        } else start("para", l);
      }
      prevLine = l;
    }
    // A paragraph may continue on the next page; equations/figures/footnotes may not.
    if (now() && now()!.kind !== "para") close();
  }
  const last = now();
  if (last) drafts.push(last);

  // Equations and figures span the text column (OCR often misses parts of them).
  for (const d of drafts) {
    if (d.kind !== "equation" && d.kind !== "figure") continue;
    const pg = pages.find((x) => x.pdfPage === d.pdfPage)!;
    d.box.l = Math.min(d.box.l, pg.colL);
    d.box.r = Math.max(d.box.r, pg.colR);
  }

  // Ids: headings "<section>-h", everything else "<section>-p<n>".
  let section = `${chapter}-0`;
  let n = 0;
  const anchors: OcrAnchor[] = [];
  const sections: RawUnit["sections"] = [];
  for (const d of drafts) {
    if (d.kind === "heading") {
      section = d.section!;
      n = 0;
      if (section !== `${chapter}-0`) sections.push({ id: section, title: cleanTitle(d.title!), pdfPage: d.pdfPage, top: d.box.t });
      anchors.push({ id: `${section}-h`, section, pdfPage: d.pdfPage, kind: "heading", box: d.box, text: d.lines.join(" ") });
      continue;
    }
    n += 1;
    anchors.push({ id: `${section}-p${n}`, section, pdfPage: d.pdfPage, kind: d.kind, box: d.box, text: joinLines(d.lines) });
  }

  const boxes = crops(pages);
  const pageOrder = new Map(pages.map((p, i) => [p.pdfPage, i]));
  const raw: RawUnit = {
    book: slug,
    unit: unitId,
    title: cfg.title,
    pages: pages.map((p) => ({ pdfPage: p.pdfPage, label: p.label, width: p.width, height: p.height, crop: boxes.get(p.pdfPage)! })),
    sections,
    anchors: [...anchors]
      .sort((a, b) => pageOrder.get(a.pdfPage)! - pageOrder.get(b.pdfPage)! || a.box.t - b.box.t)
      .map((a) => ({ ...a, column: 0 as const })),
  };
  const text: UnitText = { book: slug, unit: unitId, text: Object.fromEntries(anchors.map((a) => [a.id, a.text])) };
  for (const [file, data] of [[rawUnitPath(slug, unitId), raw], [unitTextPath(slug, unitId), text]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  const counts = anchors.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  info(`ocr: ch${chapter} ${anchors.length} anchors ${JSON.stringify(counts)} sections ${sections.map((s) => s.id).join(",")}`);
}

let dict: Set<string> | null = null;
/** Fraction of words in a title that are dictionary words (to pick the cleaner OCR reading). */
function wordScore(title: string): number {
  dict ??= new Set(fs.readFileSync("/usr/share/dict/words", "utf8").toLowerCase().split("\n"));
  const words = title.toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z]+/).filter(Boolean);
  return words.length ? words.filter((w) => dict!.has(w)).length / words.length : 0;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

/**
 * The margin list of section titles printed beside the start of a chapter,
 * e.g. "13-1 Energy of a falling body" (OCR often drops the dash: "42 Kinetic …").
 */
function marginSections(chapter: number, lines: Line[], colR: number): { n: number; title: string }[] {
  const out: { n: number; title: string; b: number }[] = [];
  const re = new RegExp(`^${chapter}\\s?[-–—~=]?\\s?(\\d{1,2}|[TIl|])[.,]?\\s+(\\S.*)$`);
  const digit = (d: string) => (d === "T" ? 7 : /[Il|]/.test(d) ? 1 : Number(d));
  for (const l of lines.filter((x) => x.l > colR + 40).sort((a, b) => a.t - b.t)) {
    const m = re.exec(l.text.trim());
    if (m) out.push({ n: digit(m[1]), title: m[2], b: l.b });
    else if (out.length && l.t - out[out.length - 1].b < 25) {
      out[out.length - 1].title += ` ${l.text.trim()}`;
      out[out.length - 1].b = l.b;
    }
  }
  return out.map(({ n, title }) => ({ n, title: cleanTitle(title) }));
}

/** Join OCR lines, undoing end-of-line hyphenation. */
function joinLines(lines: string[]): string {
  return lines.reduce((acc, l) => (acc.endsWith("-") && /^[a-z]/.test(l) ? acc.slice(0, -1) + l : acc ? `${acc} ${l}` : l), "");
}

function cleanTitle(s: string): string {
  return s
    .replace(/[|_~]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:'"`’-]+$/, "")
    .trim();
}
