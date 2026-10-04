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

/** The largest-type line(s) near the top of page 1, as a fallback title. */
function firstPageTitle(pdf: string): string | undefined {
  let html: string;
  try {
    html = execFileSync("pdftotext", ["-f", "1", "-l", "1", "-bbox-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 24 });
  } catch {
    return undefined;
  }
  const lines = [...html.matchAll(/<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)]
    .map((m) => ({ top: +m[1], h: +m[2] - +m[1], text: decodeEntities([...m[3].matchAll(/>([^<]+)<\/word>/g)].map((w) => w[1]).join(" ").trim()) }))
    .filter((l) => l.text.length > 2 && !/arxiv|preprint|copyright|©|doi|http/i.test(l.text));
  if (!lines.length) return undefined;
  const maxH = Math.max(...lines.map((l) => l.h));
  // A title is set clearly larger than the body text; a page without one (an excerpt, a
  // chapter scan) would otherwise yield body lines, so let the caller fall back to the file name.
  const body = [...lines.map((l) => l.h)].sort((a, b) => a - b)[Math.floor(lines.length / 2)];
  if (maxH < 1.2 * body) return undefined;
  const title = lines
    .filter((l) => l.h > 0.9 * maxH)
    .sort((a, b) => a.top - b.top)
    .slice(0, 3)
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length <= 120 && !/[.;]\s+\S/.test(title) ? title : undefined;
}

export function detectSource(pdf: string): SourceInfo {
  const info = pdfinfo(pdf);
  const pages = Number(info.Pages ?? 0);
  // Sample up to 6 pages spread through the document: ≥ 200 chars/page on average means a text layer.
  const samples = [...new Set(Array.from({ length: Math.min(6, pages) }, (_, i) => 1 + Math.floor((i * (pages - 1)) / Math.max(1, Math.min(6, pages) - 1))))];
  // Most sampled pages need a real text layer (≥ 200 chars); one OCR'd preface doesn't make a scanned book "text".
  const withText = samples.filter((p) => pdfText(pdf, p, p).replace(/\s+/g, "").length >= 200).length;
  const kind: SourceInfo["kind"] = samples.length && withText / samples.length >= 0.6 ? "text" : "scanned";
  const metaTitle = info.Title && !/^(untitled|microsoft word|\s*$)/i.test(info.Title) && info.Title.length > 3 ? info.Title : undefined;
  const title = metaTitle ?? (kind === "text" ? firstPageTitle(pdf) : undefined) ?? path.basename(pdf, path.extname(pdf)).replace(/[-_]+/g, " ");
  return { pages, title, author: info.Author || undefined, kind };
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

/**
 * Units for a PDF: chapters from the outline (the shallowest outline level
 * whose entries are chapter-sized), else one unit for short documents (papers),
 * else fixed chunks of ~20 pages.
 */
export function suggestUnits(pdf: string): BookConfig["units"] {
  const { pages, title } = detectSource(pdf);
  if (pages <= 40) return [{ id: "paper", title, pages: [1, Math.max(1, pages)] }];
  const nodes = outline(pdf);
  for (let depth = 0; depth <= 2; depth++) {
    const level = nodes.filter((n) => n.depth === depth).sort((a, b) => a.page - b.page);
    if (level.length < 2) continue;
    const spans = level.map((n, i) => (level[i + 1]?.page ?? pages + 1) - n.page);
    const med = [...spans].sort((a, b) => a - b)[Math.floor(spans.length / 2)];
    if (med > 60 && depth < 2) continue; // volumes/parts: look one level deeper
    const used = new Set<string>();
    return level
      .map((n, i) => {
        const last = Math.max(n.page, (level[i + 1]?.page ?? pages + 1) - 1);
        const num = /^(?:chapter\s+)?0*(\d+)\b/i.exec(n.title);
        let id = num ? num[1] : slug(n.title) || `part-${i + 1}`;
        for (let k = 2; used.has(id); k++) id = `${num ? num[1] : slug(n.title)}-${k}`;
        used.add(id);
        return { id, title: n.title.replace(/^0*(\d+)\s+/, "$1. "), pages: [n.page, last] as [number, number] };
      })
      .filter((u) => !NOT_CONTENT.test(u.title.replace(/^\d+\.\s*/, "")));
  }
  const size = 20;
  return Array.from({ length: Math.ceil(pages / size) }, (_, i) => ({
    id: `part-${i + 1}`,
    title: `Pages ${i * size + 1}–${Math.min(pages, (i + 1) * size)}`,
    pages: [i * size + 1, Math.min(pages, (i + 1) * size)] as [number, number],
  }));
}

/** Title + the first pages' text, trimmed, for cheap classification. */
export function sampleText(pdf: string, maxChars = 6000): string {
  const info = detectSource(pdf);
  return `${info.title}\n\n${pdfText(pdf, 1, Math.min(4, info.pages)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")}`.slice(0, maxChars);
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
    messages: [
      {
        role: "user",
        content: `Which field is this document mainly about? math (pure or applied mathematics, statistics, probability), cs (algorithms, data structures, systems, programming, theory of computation), physics, or ml (machine learning, neural networks). Reply as JSON {"domain": ...}.\n\n---\n${text.slice(0, 6000)}`,
      },
    ],
  });
  return data.domain;
}
