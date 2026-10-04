// Generic scanned adapter (source.kind "scanned" with no layout profile):
// Tesseract paragraph boxes become anchors; numbered lines ("3", "3.2", "Chapter 3")
// become headings. No book-specific rules — books that need them get a layout
// profile (see feynman.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { BookConfig, UnitText } from "../../../src/types";
import { pagePng, rawUnitPath, unitOf, unitPages, unitTextPath } from "../../books";
import { pool } from "../../lib/claude";
import { emit, info } from "../../lib/report";
import type { Box, RawAnchor, RawPage, RawUnit } from "../raw";
import { readWords, tesseractPage, type Word } from "./tesseract";

interface Para {
  pdfPage: number;
  box: Box;
  lines: string[];
  lineH: number;
  conf: number;
  words: number;
  column: 0 | 1;
}

const union = (a: Box, b: Box): Box => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function paragraphs(words: Word[], pdfPage: number, width: number, height: number): Para[] {
  const groups = new Map<string, Word[]>();
  for (const w of words) {
    // Drop margins: running heads / page numbers in the top and bottom 5%.
    if (w.top < 0.05 * height || w.top + w.height > 0.95 * height) continue;
    const k = `${w.block}.${w.par}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(w);
  }
  const out: Para[] = [];
  for (const ws of groups.values()) {
    const lines = new Map<number, Word[]>();
    for (const w of ws) {
      if (!lines.has(w.line)) lines.set(w.line, []);
      lines.get(w.line)!.push(w);
    }
    const text = [...lines.values()].map((l) => l.sort((a, b) => a.left - b.left).map((w) => w.text).join(" "));
    const box = ws.map((w) => ({ l: w.left, t: w.top, r: w.left + w.width, b: w.top + w.height })).reduce(union);
    if (text.join(" ").replace(/\W/g, "").length < 2) continue;
    out.push({ pdfPage, box, lines: text, lineH: median(ws.map((w) => w.height)), conf: ws.reduce((s, w) => s + w.conf, 0) / ws.length, words: ws.length, column: 0 });
  }
  // Two columns when most paragraphs sit wholly in one half.
  const mid = width / 2;
  const sided = out.filter((p) => p.box.r < mid + 0.02 * width || p.box.l > mid - 0.02 * width);
  const twoCol = out.length >= 4 && sided.length / out.length > 0.7 && out.some((p) => p.box.l > mid - 0.02 * width);
  for (const p of out) p.column = twoCol && p.box.l > mid - 0.02 * width ? 1 : 0;
  return out.sort((a, b) => a.column - b.column || a.box.t - b.box.t);
}

function joinLines(lines: string[]): string {
  return lines.reduce((acc, l) => (acc.endsWith("-") && /^[a-z]/.test(l) ? acc.slice(0, -1) + l : acc ? `${acc} ${l}` : l), "");
}

export async function genericScannedAnchors(book: BookConfig, unitId: string): Promise<void> {
  const unit = unitOf(book, unitId);
  const pdfPages = unitPages(book, unitId);
  let done = 0;
  await pool(pdfPages, Math.max(2, Math.min(8, os.cpus().length)), async (p) => {
    await tesseractPage(book.slug, p);
    emit({ type: "progress", unit: unitId, stage: "anchors", done: ++done, total: pdfPages.length, label: "pages (OCR)" });
  });

  const paras: Para[] = [];
  const sizes: { width: number; height: number }[] = [];
  for (const p of pdfPages) {
    const meta = await sharp(pagePng(book.slug, p)).metadata();
    const width = meta.width ?? 2550;
    const height = meta.height ?? 3300;
    sizes.push({ width, height });
    paras.push(...paragraphs(readWords(book.slug, p), p, width, height));
  }
  const bodyH = median(paras.map((p) => p.lineH));

  // Classify and assign ids in reading order.
  let section = `${unitId}-0`;
  let n = 0;
  const used = new Set<string>();
  const anchors: RawAnchor[] = [];
  const sections: RawUnit["sections"] = [];
  for (const p of paras) {
    const text = joinLines(p.lines).trim();
    const num = /^(?:(?:chapter|section)\s+)?((?:\d+\.)*\d+)\.?\s+(\S.{0,80})$/i.exec(text);
    const isHeading = p.lines.length <= 2 && text.length <= 90 && !/[.,;:]$/.test(text) && (num !== null || (p.lineH > 1.25 * bodyH && /^[A-Z]/.test(text)));
    if (isHeading) {
      let id = num ? num[1] : text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "section";
      const base = id;
      for (let k = 2; used.has(`${id}-h`); k++) id = `${base}-${k}`;
      used.add(`${id}-h`);
      section = id;
      n = 0;
      sections.push({ id, title: num ? num[2] : text, pdfPage: p.pdfPage, top: p.box.t });
      anchors.push({ id: `${id}-h`, section, pdfPage: p.pdfPage, kind: "heading", column: p.column, box: p.box, text });
      continue;
    }
    // Low-confidence, mostly non-word blocks: display maths or figures.
    const h = p.box.b - p.box.t;
    const kind: RawAnchor["kind"] = p.conf < 45 ? (h > 4 * bodyH ? "figure" : "equation") : /^(fig(ure)?|table)\s*\d/i.test(text) ? (/^table/i.test(text) ? "table" : "figure") : "para";
    n += 1;
    anchors.push({ id: `${section}-p${n}`, section, pdfPage: p.pdfPage, kind, column: p.column, box: p.box, text });
  }

  // One crop for the whole unit so stacked pages line up.
  const PAD = 40;
  const all = paras.map((p) => p.box).reduce(union, { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  const crop = Number.isFinite(all.l)
    ? { left: Math.max(0, Math.round(all.l - PAD)), top: Math.max(0, Math.round(all.t - PAD)), width: Math.round(all.r - all.l + 2 * PAD), height: Math.round(all.b - all.t + 2 * PAD) }
    : { left: 0, top: 0, width: sizes[0]?.width ?? 2550, height: sizes[0]?.height ?? 3300 };
  const pages: RawPage[] = pdfPages.map((p, i) => ({ pdfPage: p, label: String(i + 1), width: sizes[i].width, height: sizes[i].height, crop }));

  const raw: RawUnit = { book: book.slug, unit: unitId, title: unit.title, pages, sections, anchors };
  const text: UnitText = { book: book.slug, unit: unitId, text: Object.fromEntries(anchors.map((a) => [a.id, a.text])) };
  for (const [file, data] of [[rawUnitPath(book.slug, unitId), raw], [unitTextPath(book.slug, unitId), text]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  info(`anchors (OCR): ${book.slug}/${unitId} ${anchors.length} anchors, sections ${sections.map((s) => s.id).join(",") || "(none)"}`);
}
