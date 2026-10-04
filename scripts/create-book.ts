// Turning a PDF into a book config, shared by the CLI and the web upload API.
//
// `draftBook` is fast and local (no model calls, no writes): it reuses the book
// made from the same PDF, or proposes a new one (title, slug, units).
// `finalizeBook` does the slow part for a new book (asks a model for the
// subject), then copies the PDF and writes books/<slug>/book.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BookConfig } from "../src/types";
import * as books from "./books";

/** Every book, with a missing books/ folder (fresh clone) treated as an empty library. */
export function listBooks(): BookConfig[] {
  return fs.existsSync("books") ? books.listBooks() : [];
}

const sha1 = (file: string) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

/** The book already made from this exact PDF (sizes compared first; hashing only for candidates). */
export function findExisting(pdf: string): BookConfig | undefined {
  const size = fs.statSync(pdf).size;
  const candidates = listBooks().filter((b) => fs.existsSync(b.source.pdf) && fs.statSync(b.source.pdf).size === size);
  if (!candidates.length) return undefined;
  const hash = sha1(pdf);
  return candidates.find((b) => sha1(b.source.pdf) === hash);
}

export function slugify(s: string): string {
  const stop = new Set(["a", "an", "the", "of", "on", "for", "and", "in", "to", "with"]);
  const words = s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").split(/[\s_-]+/).filter(Boolean);
  return (words.filter((w) => !stop.has(w)).slice(0, 5).join("-") || "book").slice(0, 48);
}

export function shortTitle(title: string, max = 34) {
  if (title.length <= max) return title;
  return title.slice(0, max).replace(/\s+\S*$/, "").replace(/[:,;\s-]+$/, "") + "…";
}

/** A slug not used by any book folder nor in `taken` (e.g. slugs reserved by queued uploads). */
export function freeSlug(title: string, taken: Set<string> = new Set()): string {
  const base = slugify(title);
  let slug = base;
  for (let n = 2; fs.existsSync(path.join("books", slug)) || taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export interface Draft {
  book: BookConfig;
  pages: number;
  /** A new book (nothing written yet); false when the PDF is already a book. */
  fresh: boolean;
}

/** Fast, local, no writes: the existing book for this PDF, or a proposed new one. */
export function draftBook(pdf: string, opts: { slug?: string; taken?: Set<string> } = {}): Draft {
  const existing = findExisting(pdf);
  if (existing) return { book: existing, pages: Math.max(...existing.units.map((u) => u.pages[1])), fresh: false };
  const src = books.detectSource(pdf);
  const slug = opts.slug ?? freeSlug(src.title, opts.taken);
  const dir = path.join("books", slug);
  return {
    book: {
      slug,
      title: src.title,
      short: shortTitle(src.title),
      ...(src.author ? { subtitle: src.author } : {}),
      source: { pdf: path.join(dir, "source.pdf"), kind: src.kind },
      domain: "cs", // replaced by finalizeBook
      recolor: src.kind === "text" ? "lightness" : "invert",
      units: books.suggestUnits(pdf).map((u) => ({ ...u, title: u.title || src.title })),
    },
    pages: src.pages,
    fresh: true,
  };
}

/** For a fresh draft: detect the subject (one cheap model call), copy the PDF and write book.json. */
export async function finalizeBook(pdf: string, book: BookConfig): Promise<BookConfig> {
  book.domain = await books.detectDomain(books.sampleText(pdf));
  const dir = path.join("books", book.slug);
  fs.mkdirSync(dir, { recursive: true });
  if (path.resolve(pdf) !== path.resolve(book.source.pdf)) fs.copyFileSync(pdf, book.source.pdf);
  fs.writeFileSync(path.join(dir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  return book;
}

/**
 * For a fresh draft, without waiting: copy the PDF and write book.json now (with a local
 * guess at the subject) so the content steps can start, and ask the model for the subject
 * in the background. `domain` resolves to the answer (book.json is updated when it does;
 * on any error the guess stands). Pass it to runBook so planning waits for it.
 */
export function startBook(pdf: string, book: BookConfig): { book: BookConfig; domain: Promise<BookConfig["domain"]> } {
  const sample = books.sampleText(pdf);
  book.domain = books.guessDomain(sample);
  const dir = path.join("books", book.slug);
  const write = () => fs.writeFileSync(path.join(dir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  fs.mkdirSync(dir, { recursive: true });
  if (path.resolve(pdf) !== path.resolve(book.source.pdf)) fs.copyFileSync(pdf, book.source.pdf);
  write();
  const domain = books
    .detectDomain(sample)
    .then((d) => {
      if (d !== book.domain) {
        book.domain = d;
        write();
      }
      return d;
    })
    .catch(() => book.domain);
  return { book, domain };
}

/** Units that already have demos (a plan). */
export function builtUnits(book: BookConfig): Set<string> {
  return new Set(book.units.filter((u) => fs.existsSync(path.join("src/demos", book.slug, u.id, "plan.json"))).map((u) => u.id));
}

/** Chapters to build when none were chosen: the ones built before, else the first three of a long book, else all. */
/** Front and back matter that shouldn't be built by default. */
const MATTER = /^(preface|foreword|prologue|contents|table of contents|acknowledg|dedication|about|copyright|notation|index|bibliography|references|notes|glossary|epilogue)/i;

/** Long books: the chapters already built, else the first three real chapters (numbered ones first). */
export function defaultUnits(book: BookConfig): string[] {
  if (book.units.length <= 6) return book.units.map((u) => u.id);
  const built = builtUnits(book);
  if (built.size) return [...built];
  const body = book.units.filter((u) => !MATTER.test(u.title.replace(/^[\d.\s]+/, "")));
  const numbered = body.filter((u) => /^\d/.test(u.id) || /^(\d|chapter\b)/i.test(u.title));
  return (numbered.length ? numbered : body.length ? body : book.units).slice(0, 3).map((u) => u.id);
}

export interface PdfInfo {
  title: string;
  author?: string;
  pages: number;
  kind: "text" | "scanned";
  units: { id: string; title: string; pages: [number, number]; built: boolean }[];
  /** Slug of the book already made from this PDF. */
  existing?: string;
}

/** What the upload screen shows about a PDF (fast: no model calls, no writes). */
export function inspectPdf(pdf: string, opts: { taken?: Set<string> } = {}): { info: PdfInfo; draft: Draft } {
  const draft = draftBook(pdf, opts);
  const built = draft.fresh ? new Set<string>() : builtUnits(draft.book);
  const info: PdfInfo = {
    title: draft.book.title,
    ...(draft.book.subtitle ? { author: draft.book.subtitle } : {}),
    pages: draft.pages,
    kind: draft.book.source.kind,
    units: draft.book.units.map((u) => ({ id: u.id, title: u.title, pages: u.pages, built: built.has(u.id) })),
    ...(draft.fresh ? {} : { existing: draft.book.slug }),
  };
  return { info, draft };
}

/** Draft + finalize in one go (the existing book is returned unchanged). */
export async function createBook(pdf: string, opts: { slug?: string } = {}): Promise<BookConfig> {
  const draft = draftBook(pdf, opts);
  return draft.fresh ? finalizeBook(pdf, draft.book) : draft.book;
}
