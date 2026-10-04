// Book configs (books/<slug>/book.json) and the on-disk layout shared by every
// pipeline step. See the layout comment at the top of src/types.ts.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BookConfig, Domain } from "../src/types";

const BOOKS_DIR = path.resolve("books");

/** Every configured book, sorted by slug. */
export function listBooks(): BookConfig[] {
  return fs
    .readdirSync(BOOKS_DIR)
    .filter((d) => fs.existsSync(path.join(BOOKS_DIR, d, "book.json")))
    .sort()
    .map(loadBook);
}

export function loadBook(slug: string): BookConfig {
  const file = path.join(BOOKS_DIR, slug, "book.json");
  if (!fs.existsSync(file)) throw new Error(`unknown book "${slug}" (no ${path.relative(process.cwd(), file)})`);
  const book = JSON.parse(fs.readFileSync(file, "utf8")) as BookConfig;
  if (book.slug !== slug) throw new Error(`${file}: slug "${book.slug}" does not match its directory`);
  return book;
}

export function unitOf(book: BookConfig, id: string): BookConfig["units"][number] {
  const unit = book.units.find((u) => u.id === id);
  if (!unit) throw new Error(`book "${book.slug}" has no unit "${id}" (units: ${book.units.map((u) => u.id).join(", ")})`);
  return unit;
}

/** 1-based PDF page numbers of a unit, in order. */
export function unitPages(book: BookConfig, id: string): number[] {
  const [first, last] = unitOf(book, id).pages;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** Pipeline scratch: work/<slug>/... (git-ignored). */
export function workDir(slug: string, ...parts: string[]): string {
  return path.resolve("work", slug, ...parts);
}

/** Served content: public/books/<slug>/... (git-ignored). */
export function publicBookDir(slug: string, ...parts: string[]): string {
  return path.resolve("public", "books", slug, ...parts);
}

/** File stem for a PDF page: 7 → "p0007". */
export function pageFile(pdfPage: number): string {
  return `p${String(pdfPage).padStart(4, "0")}`;
}

/** 300 dpi render of a PDF page (written by the render step). */
export function pagePng(slug: string, pdfPage: number): string {
  return workDir(slug, "pages", `${pageFile(pdfPage)}.png`);
}

/** Pipeline-only text per anchor (UnitText). */
export function unitTextPath(slug: string, unit: string): string {
  return workDir(slug, "text", `${unit}.json`);
}

/** Anchors with pixel boxes on the 300 dpi renders (RawUnit, written by the anchors step). */
export function rawUnitPath(slug: string, unit: string): string {
  return workDir(slug, "anchors", `${unit}.raw.json`);
}

/** Served Unit JSON. */
export function unitJsonPath(slug: string, unit: string): string {
  return publicBookDir(slug, "units", `${unit}.json`);
}

// --- New books from a bare PDF (used by the CLI) ---------------------------------

/** What a PDF is: page count, best-guess title/author, and whether it has a usable text layer. */
export interface SourceInfo {
  pages: number;
  title: string;
  author?: string;
  kind: "text" | "scanned";
  /** A text layer laid over page scans by OCR (ABBYY, Tesseract, …): words may be misread. */
  ocr: boolean;
}

function pdfinfo(pdf: string): Record<string, string> {
  const out = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  return Object.fromEntries(
    out
      .split("\n")
      .map((l) => /^([^:]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1].trim(), m[2].trim()]),
  );
}

/** Plain text of PDF pages [first, last] (1-based) from the text layer ("" for scans). */
export function pdfText(pdf: string, first: number, last: number): string {
  try {
    return execFileSync("pdftotext", ["-f", String(first), "-l", String(last), "-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  } catch {
    return "";
  }
}

const decodeEntities = (s: string) =>
  s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

/** A line that reads like words (not a formula, an axis label or a figure fragment). */
function wordy(text: string): boolean {
  const chars = text.replace(/\s+/g, "");
  if (chars.length < 4) return false;
  const letters = (chars.match(/\p{L}/gu) ?? []).length;
  const words = text.split(/\s+/).filter((w) => /^\p{L}{2,}/u.test(w)).length;
  return letters / chars.length >= 0.7 && words >= 2 && !/^(fig(ure)?\.?|table|algorithm|equation)\s*\d/i.test(text) && !/%|=|\(\s*[a-z]\s*\)/i.test(text);
}

/**
 * The largest-type wordy line(s) in the top half of page 1, as a fallback title. Formulas, figure
 * labels and captions on page 1 are often set large too (math-heavy papers, a teaser figure), so
 * only text that reads like words is considered.
 */
function firstPageTitle(pdf: string): string | undefined {
  let html: string;
  try {
    html = execFileSync("pdftotext", ["-f", "1", "-l", "1", "-bbox-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 24 });
  } catch {
    return undefined;
  }
  const pageH = Number(/<page width="[\d.]+" height="([\d.]+)"/.exec(html)?.[1] ?? 792);
  const lines = [...html.matchAll(/<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)]
    .map((m) => ({ top: +m[1], h: +m[2] - +m[1], text: decodeEntities([...m[3].matchAll(/>([^<]+)<\/word>/g)].map((w) => w[1]).join(" ").trim()) }))
    .filter((l) => l.text.length > 2 && !/arxiv|preprint|copyright|©|doi|http|proceedings|conference|journal|vol\.|issn/i.test(l.text));
  if (!lines.length) return undefined;
  // A title is set clearly larger than the body text; a page without one (an excerpt, a
  // chapter scan) would otherwise yield body lines, so let the caller fall back to the file name.
  const body = [...lines.map((l) => l.h)].sort((a, b) => a - b)[Math.floor(lines.length / 2)];
  const candidates = lines.filter((l) => l.top < pageH * 0.5 && wordy(l.text));
  if (!candidates.length) return undefined;
  const maxH = Math.max(...candidates.map((l) => l.h));
  if (maxH < 1.2 * body) {
    // Old typesetting and OCR'd scans: the title is often in capitals at body size. Take the first
    // all-caps wordy line(s) near the top (not a running head with a page number).
    const caps = candidates
      .filter((l) => l.top < pageH * 0.4 && l.text === l.text.toUpperCase() && !/\d/.test(l.text))
      .sort((a, b) => a.top - b.top);
    // The first title line has a few words; continuation lines may be short ("THE ENTSCHEIDUNGSPROBLEM").
    const first = caps.findIndex((l) => l.text.split(/\s+/).length >= 3);
    if (first < 0) return undefined;
    caps.splice(0, first);
    const block = [caps[0]];
    for (const l of caps.slice(1)) if (block.length < 3 && l.top - block[block.length - 1].top < l.h * 2.6) block.push(l);
    const t = block.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    return t.length <= 140 ? t.toLowerCase().replace(/(^|[\s:—-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : undefined;
  }
  // The title block: the largest wordy lines, top to bottom, while they stay together.
  const big = candidates.filter((l) => l.h > 0.9 * maxH).sort((a, b) => a.top - b.top);
  const block = [big[0]];
  for (const l of big.slice(1)) if (block.length < 3 && l.top - block[block.length - 1].top < maxH * 2.6) block.push(l);
  const title = block.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
  return title.length <= 140 && !/[.;]\s+\S/.test(title) ? title : undefined;
}

/** PDF metadata titles are often junk: a TeX/Word file name, "untitled", or a bare token. */
function usableMetaTitle(title: string | undefined, pdf: string): string | undefined {
  const t = title?.trim();
  if (!t || t.length <= 3) return undefined;
  if (/^(untitled|microsoft word|title|document|slide|presentation)\b/i.test(t)) return undefined;
  if (/\.(dvi|tex|pdf|docx?|ps|eps|indd|rtf|odt|pages)$/i.test(t)) return undefined;
  if (!/\s/.test(t) && t.toLowerCase() === path.basename(pdf, path.extname(pdf)).toLowerCase()) return undefined;
  if (!/\s/.test(t) && t.length < 20) return undefined; // a single short token is rarely a real title
  return t;
}

const OCR_TOOLS = /abbyy|finereader|\bocr\b|paper capture|tesseract|omnipage|readiris|scansnap|clearscan/i;
const ocrMemo = new Map<string, boolean>();

/**
 * Is the PDF's text layer OCR over page scans (e.g. the Turing paper, an ABBYY FineReader scan)?
 * The producer says so, or most sampled pages are one full-page image with text on top. The text
 * then has misread words ("TUKING", "Gbdel"): the page image is the authority.
 */
export function ocrTextLayer(pdf: string): boolean {
  const memo = ocrMemo.get(pdf);
  if (memo !== undefined) return memo;
  let ocr = false;
  try {
    const info = pdfinfo(pdf);
    if (OCR_TOOLS.test(`${info.Creator ?? ""} ${info.Producer ?? ""}`)) ocr = true;
    else {
      const pages = Number(info.Pages ?? 0);
      const n = Math.min(4, pages);
      const samples = [...new Set(Array.from({ length: n }, (_, i) => 1 + Math.floor(((i + 0.5) * pages) / n)))];
      const scanned = samples.filter((p) => {
        const size = /size:\s*([\d.]+) x ([\d.]+) pts/.exec(execFileSync("pdfinfo", ["-f", String(p), "-l", String(p), pdf], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
        if (!size) return false;
        const [pw, ph] = [+size[1], +size[2]];
        const list = execFileSync("pdfimages", ["-list", "-f", String(p), "-l", String(p), pdf], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const covers = list
          .split("\n")
          .slice(2)
          .map((l) => l.trim().split(/\s+/))
          .some((c) => c.length > 13 && c[2] === "image" && (+c[3] / +c[12]) * 72 > 0.8 * pw && (+c[4] / +c[13]) * 72 > 0.8 * ph);
        return covers && pdfText(pdf, p, p).replace(/\s+/g, "").length >= 200;
      });
      ocr = samples.length > 0 && scanned.length / samples.length >= 0.5;
    }
  } catch {
    ocr = false;
  }
  ocrMemo.set(pdf, ocr);
  return ocr;
}

export function detectSource(pdf: string): SourceInfo {
  const info = pdfinfo(pdf);
  const pages = Number(info.Pages ?? 0);
  // Sample up to 6 pages spread through the document: ≥ 200 chars/page on average means a text layer.
  const samples = [...new Set(Array.from({ length: Math.min(6, pages) }, (_, i) => 1 + Math.floor((i * (pages - 1)) / Math.max(1, Math.min(6, pages) - 1))))];
  // Most sampled pages need a real text layer (≥ 200 chars); one OCR'd preface doesn't make a scanned book "text".
  const withText = samples.filter((p) => pdfText(pdf, p, p).replace(/\s+/g, "").length >= 200).length;
  const kind: SourceInfo["kind"] = samples.length && withText / samples.length >= 0.6 ? "text" : "scanned";
  const metaTitle = usableMetaTitle(info.Title, pdf);
  const title = metaTitle ?? (kind === "text" ? firstPageTitle(pdf) : undefined) ?? path.basename(pdf, path.extname(pdf)).replace(/[-_]+/g, " ");
  const author = kind === "text" ? authorLine(pdf, title, info.Author) : info.Author || undefined;
  return { pages, title, author, kind, ocr: kind === "text" && ocrTextLayer(pdf) };
}

// --- Authors -------------------------------------------------------------------------

const NOT_NAME = /^(abstract|introduction|university|universit[yä]t|institute|institut|inc|research|laboratory|laboratories|labs?|department|google|microsoft|technology|college|school|corporation|stanford|extended|version|published|conference|journal|proceedings|chapter|part|contents|preface)\.?$/i;

/** "Diederik P. Kingma", "A. M. TURING", "F Thomson Leighton": 2–4 name tokens ending in a surname. */
function personName(s: string): string | undefined {
  const t = s
    .replace(/^by\s+/i, "")
    .replace(/[*∗†‡§¶\d]+/g, "")
    .replace(/\.$/, "")
    .trim();
  const tokens = t.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return undefined;
  const ok = tokens.every((w) => /^(?:[A-Z][a-zà-ÿ’'\-]+|[A-Z]\.(?:[A-Z]\.)?|[A-Z]{2,}|[A-Z])$/.test(w) && !NOT_NAME.test(w));
  const last = tokens[tokens.length - 1];
  return ok && /^[A-Z][A-Za-zà-ÿ’'\-]+$/.test(last) && last.length >= 2 ? t : undefined;
}

/** Split an author line or metadata string into names ("A, B and C", wide gaps between columns). */
function namesIn(line: string): string[] | undefined {
  const pieces = line
    .split(/\s{3,}|,\s*|\s+and\s+|\s*&\s*|;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return undefined;
  const names = pieces.map(personName);
  return names.every((n): n is string => !!n) ? names : undefined;
}

/**
 * Author names from page 1: the name lines just under the title ("Leslie Lamport",
 * "By C. E. SHANNON", "Kaiming He   Xiangyu Zhang   Shaoqing Ren").
 */
function pageOneAuthors(pdf: string, title: string): string[] {
  const lines = pdfText(pdf, 1, 1)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const tk = key(title).slice(0, 16);
  let from = tk.length >= 6 ? lines.findIndex((l) => key(l).length >= 4 && (tk.startsWith(key(l).slice(0, 16)) || key(l).startsWith(tk))) : -1;
  if (from < 0) from = 0;
  const names: string[] = [];
  for (const l of lines.slice(from + 1, from + 12)) {
    if (/^(abstract|introduction)\b/i.test(l.replace(/\s/g, "")) || /^a\s?bstract/i.test(l)) break;
    if (key(l).length >= 6 && key(title).includes(key(l))) continue; // the title's second line
    const n = namesIn(l);
    if (n) names.push(...n);
  }
  return names;
}

/** "Lamport", "Kingma & Ba", "He et al.": surnames for a subtitle. */
function shortAuthors(names: string[]): string | undefined {
  const sur = names.map((n) => {
    const s = n.split(/\s+/).pop()!;
    return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
  });
  if (!sur.length) return undefined;
  return sur.length === 1 ? sur[0] : sur.length === 2 ? `${sur[0]} & ${sur[1]}` : `${sur[0]} et al.`;
}

/**
 * A short author line for the book's subtitle: the PDF metadata when it holds real names (not a
 * login like "ongardie"), else the names under the title on page 1.
 */
export function authorLine(pdf: string, title: string, metaAuthor?: string): string | undefined {
  const meta = metaAuthor ? namesIn(metaAuthor) : undefined;
  return shortAuthors(meta ?? pageOneAuthors(pdf, title));
}

interface OutlineNode {
  title: string;
  page: number;
  depth: number;
}

function outline(pdf: string): OutlineNode[] {
  const py = `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
out = []
def walk(items, d):
    for x in items:
        if isinstance(x, list): walk(x, d + 1)
        else:
            try: out.append({"title": str(x.title).strip(), "page": r.get_destination_page_number(x) + 1, "depth": d})
            except Exception: pass
try: walk(r.outline, 0)
except Exception: pass
print(json.dumps(out))`;
  try {
    return JSON.parse(execFileSync("python3", ["-c", py, pdf], { encoding: "utf8", maxBuffer: 1 << 24 })) as OutlineNode[];
  } catch {
    return [];
  }
}

const NOT_CONTENT = /^(contents|table of contents|index|copyright|title page|cover|bibliography|references|about the authors?)$/i;

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Nearly empty page (a blank verso, a part title page): not worth a unit's last page. */
function nearlyBlank(pdf: string, page: number): boolean {
  return pdfText(pdf, page, page).replace(/\s+/g, "").length < 80;
}

/**
 * Top-level section starts in a document without an outline, from the text layer: "PART II: …",
 * "Chapter 3", and numbered headings that count up ("1. T HE D ISCRETE N OISELESS C HANNEL", "2. …").
 */
function sectionStarts(pdf: string, pages: number): { page: number; title: string; part: boolean }[] {
  const text = pdfText(pdf, 1, pages).split("\f");
  const out: { page: number; title: string; part: boolean }[] = [];
  let last = 0;
  text.forEach((pageText, i) => {
    for (const raw of pageText.split("\n")) {
      const line = raw.trim().replace(/\s+/g, " ");
      // Small caps come out split ("T HE D ISCRETE"): rejoin for the title.
      const tidy = (t: string) => t.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, "$1").replace(/\s+([,:])/g, "$1");
      const part = /^(PART|Part)\s+([IVX]+|\d+)\b[.:]?\s*(.{0,80})$/.exec(line);
      if (part && !/[a-z]\.$/.test(line)) {
        out.push({ page: i + 1, title: tidy(line), part: true });
        continue;
      }
      const chap = /^(?:CHAPTER|Chapter)\s+(\d+)\b[.:]?\s*(.{0,80})$/.exec(line);
      const num = chap ?? /^(\d{1,2})\.?\s+([A-Z][^.;]{2,80})$/.exec(line);
      if (!num || +num[1] !== last + 1 || (!chap && !/^[A-Z][A-Za-z]* ?[A-Z]/.test(num[2]))) continue;
      last = +num[1];
      out.push({ page: i + 1, title: tidy(`${num[1]}. ${num[2]}`.trim()), part: false });
    }
  });
  return out;
}

/** "PART II: THE DISCRETE CHANNEL WITH NOISE" → "Part II: The Discrete Channel with Noise". */
function titleCase(t: string): string {
  if (t !== t.toUpperCase()) return t;
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return t
    .toLowerCase()
    .split(" ")
    .map((w, i, ws) => (i > 0 && small.has(w) && !/:$/.test(ws[i - 1]) ? w : /^[ivx]+:?$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Units for a PDF: chapters from the outline (the shallowest outline level
 * whose entries are chapter-sized), else one unit for short documents (papers),
 * else ~20-page parts cut at section starts when the text shows them.
 * A unit ends before the next outline entry at its level or above (a chapter
 * doesn't take in the next part's title page), and trailing blank pages are dropped.
 */
export function suggestUnits(pdf: string): BookConfig["units"] {
  const { pages, title } = detectSource(pdf);
  if (pages <= 40) return [{ id: "paper", title, pages: [1, Math.max(1, pages)] }];
  const trim = (first: number, last: number): [number, number] => {
    while (last > first && nearlyBlank(pdf, last)) last--;
    return [first, last];
  };
  const nodes = outline(pdf);
  for (let depth = 0; depth <= 2; depth++) {
    const level = nodes.filter((n) => n.depth === depth).sort((a, b) => a.page - b.page);
    if (level.length < 2) continue;
    const spans = level.map((n, i) => (level[i + 1]?.page ?? pages + 1) - n.page);
    const med = [...spans].sort((a, b) => a - b)[Math.floor(spans.length / 2)];
    if (med > 60 && depth < 2) continue; // volumes/parts: look one level deeper
    const above = nodes.filter((n) => n.depth < depth).map((n) => n.page);
    const used = new Set<string>();
    return level
      .map((n, i) => {
        const next = Math.min(level[i + 1]?.page ?? pages + 1, ...above.filter((p) => p > n.page));
        const num = /^(?:chapter\s+)?0*(\d+)\b/i.exec(n.title);
        let id = num ? num[1] : slug(n.title) || `part-${i + 1}`;
        for (let k = 2; used.has(id); k++) id = `${num ? num[1] : slug(n.title)}-${k}`;
        used.add(id);
        return { id, title: n.title.replace(/^0*(\d+)\s+/, "$1. "), pages: trim(n.page, Math.max(n.page, next - 1)) };
      })
      .filter((u) => !NOT_CONTENT.test(u.title.replace(/^\d+\.\s*/, "")));
  }
  // No outline: ~20-page parts, each starting where a section (better: a part) starts if one
  // falls 12–30 pages in.
  const starts = sectionStarts(pdf, pages);
  const size = 20;
  const units: BookConfig["units"] = [];
  for (let first = 1; first <= pages; ) {
    let next = Math.min(pages + 1, first + size);
    if (pages + 1 - first > 30) {
      const cands = starts.filter((s) => s.page >= first + 12 && s.page <= first + 30);
      const best = cands.sort((a, b) => Math.abs(a.page - first - size) - (a.part ? 8 : 0) - (Math.abs(b.page - first - size) - (b.part ? 8 : 0)))[0];
      if (best) next = best.page;
    } else next = pages + 1;
    const head = starts.find((s) => s.page === first) ?? starts.find((s) => s.page > first && s.page < next);
    const [a, b] = trim(first, next - 1);
    units.push({ id: `part-${units.length + 1}`, title: head && starts.length >= 3 ? titleCase(head.title) : `Pages ${a}–${b}`, pages: [a, b] });
    first = next;
  }
  return units;
}

/** Title + the first pages' text, trimmed, for cheap classification. */
export function sampleText(pdf: string, maxChars = 6000): string {
  const info = detectSource(pdf);
  return `${info.title}\n\n${pdfText(pdf, 1, Math.min(4, info.pages)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")}`.slice(0, maxChars);
}

/**
 * A local first guess at the domain (keyword counts), used for book.json until the
 * model's answer arrives; good enough to keep if a run stops before then.
 */
export function guessDomain(text: string): Domain {
  const t = text.toLowerCase();
  const count = (words: string[]) => words.reduce((n, w) => n + (t.match(new RegExp(`\\b${w}`, "g"))?.length ?? 0), 0);
  const score: Record<Domain, number> = {
    ml: count(["neural", "training", "model", "attention", "transformer", "gradient", "loss", "learning", "dataset", "embedding"]),
    cs: count(["algorithm", "memory", "program", "compiler", "data structure", "pointer", "hash", "runtime", "complexity", "malloc"]),
    physics: count(["energy", "force", "velocity", "momentum", "particle", "field", "mass", "gravit", "quantum", "motion"]),
    math: count(["theorem", "proof", "lemma", "integral", "matrix", "equation", "function", "probability", "group", "vector"]),
  };
  return (Object.entries(score) as [Domain, number][]).sort((a, b) => b[1] - a[1])[0][0];
}

/** Classify a text into one of the demo domains with one cheap call. */
export async function detectDomain(text: string): Promise<Domain> {
  const { callJson, MODELS } = await import("./lib/claude");
  const { z } = await import("zod");
  const { data } = await callJson(z.object({ domain: z.enum(["math", "cs", "physics", "ml"]) }), {
    model: MODELS.sonnet,
    effort: "low",
    label: "detect-domain",
    maxTokens: 2000,
    cache: false,
    messages: [
      {
        role: "user",
        content: `Which field is this document mainly about? math (pure or applied mathematics, statistics, probability), cs (algorithms, data structures, systems, programming, theory of computation), physics, or ml (machine learning, neural networks). Reply as JSON {"domain": ...}.\n\n---\n${text.slice(0, 6000)}`,
      },
    ],
  });
  return data.domain;
}
