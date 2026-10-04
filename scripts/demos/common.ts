// Shared helpers for the demo steps: paths, unit + text loading, page images
// and anchor crops for the model.

import fs from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import type Anthropic from "@anthropic-ai/sdk";
import type { Anchor, BookConfig, DemoPlan, Unit, UnitText } from "../../src/types";
import { publicBookDir, unitJsonPath, unitTextPath, workDir } from "../books";
import { info } from "../lib/report";

/** Book + unit being processed, with everything loaded once. */
export interface Ctx {
  book: BookConfig;
  unit: Unit;
  text: UnitText;
}

/** Short tag for logs and usage labels, e.g. "feynman-1/13". */
export const tag = (slug: string, unit: string) => `${slug}/${unit}`;

export const paths = {
  demoDir: (slug: string, unit: string) => path.resolve("src/demos", slug, unit),
  plan: (slug: string, unit: string) => path.resolve("src/demos", slug, unit, "plan.json"),
  component: (slug: string, unit: string, name: string) => path.resolve("src/demos", slug, unit, `${name}.tsx`),
  convo: (slug: string, unit: string, id: string) => workDir(slug, "demos", unit, `${id}.json`),
  verifyDir: (slug: string, unit: string) => workDir(slug, "verify", unit),
  tscDir: (slug: string) => workDir(slug, "tsc"),
  cache: (slug: string, unit: string) => workDir(slug, "cache", `${unit}.json`),
};

export function loadCtx(book: BookConfig, unitId: string): Ctx {
  const file = unitJsonPath(book.slug, unitId);
  if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(process.cwd(), file)} — run the render, anchors and assemble steps first`);
  const unit = JSON.parse(fs.readFileSync(file, "utf8")) as Unit;
  const tfile = unitTextPath(book.slug, unitId);
  const text: UnitText = fs.existsSync(tfile) ? (JSON.parse(fs.readFileSync(tfile, "utf8")) as UnitText) : { book: book.slug, unit: unitId, text: {} };
  return { book, unit, text };
}

export function loadPlan(slug: string, unit: string): DemoPlan {
  const file = paths.plan(slug, unit);
  if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(process.cwd(), file)} — run the plan step first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as DemoPlan;
}

export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** How the per-anchor text was obtained, for prompt wording. */
export function textSourceNote(book: BookConfig): { name: string; caveat: string } {
  return book.source.kind === "text"
    ? { name: "text from the PDF's text layer", caveat: "The text is accurate, but maths is flattened to plain characters (sub/superscripts and fractions are lost); read equations from the page images." }
    : { name: "noisy OCR text", caveat: "The OCR text is noisy and equations in it are garbage; read equations, figures and wording from the page images, which are authoritative." };
}

/** One anchor as a compact line: `[13-2-p4] (p.13-3, para) text…`. */
export function anchorLine(a: Anchor, text: UnitText, maxChars = 1200): string {
  let t = (text.text[a.id] ?? "").replace(/\s+/g, " ").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars) + " …";
  return `[${a.id}] (p.${a.page}, ${a.kind}${a.column ? ", right column" : ""}) ${t}`;
}

/** Anchor plus neighbours as text, with ">>>" marking the anchor itself. */
export function anchorContext(c: Ctx, id: string, before = 1, after = 1): string {
  const i = c.unit.anchors.findIndex((a) => a.id === id);
  if (i < 0) return `[${id}] (missing)`;
  return c.unit.anchors
    .slice(Math.max(0, i - before), i + after + 1)
    .map((a) => `${a.id === id ? ">>> " : ""}${anchorLine(a, c.text)}`)
    .join("\n");
}

/**
 * The served page image (whose coordinates match the anchors exactly),
 * converted back to dark-on-light for the model: plain inversion for
 * "invert" books; inversion plus a 180° hue turn (which restores the
 * original hues) for "lightness" books.
 */
function pagePipeline(c: Ctx, label: string): Sharp | null {
  const page = c.unit.pages.find((p) => p.label === label);
  if (!page) return null;
  const file = path.resolve("public", page.src);
  if (!fs.existsSync(file)) {
    const alt = publicBookDir(c.book.slug, "pages", c.unit.unit, path.basename(page.src));
    if (!fs.existsSync(alt)) return null;
    return restore(sharp(alt), c.book);
  }
  return restore(sharp(file), c.book);
}

function restore(img: Sharp, book: BookConfig): Sharp {
  const neg = img.flatten({ background: "#0a0a0a" }).negate({ alpha: false });
  return book.recolor === "lightness" ? neg.modulate({ hue: 180 }) : neg;
}

/** A whole page (long side ≤ `max` px) as a PNG buffer. */
export async function pageImage(c: Ctx, label: string, max = 1568): Promise<Buffer | null> {
  const img = pagePipeline(c, label);
  if (!img) return null;
  return img.resize({ width: max, height: max, fit: "inside" }).png().toBuffer();
}

/** Crop of the page region an anchor covers (full text-column width, a little padding). */
export async function anchorCrop(c: Ctx, a: Anchor, pad = 0.012): Promise<Buffer | null> {
  const img = pagePipeline(c, a.page);
  if (!img) return null;
  const buf = await img.png().toBuffer();
  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  // Widen to the anchor's column so the crop reads naturally.
  const colL = a.column === 1 ? Math.min(a.x, 0.5) : Math.min(a.x, 0.06);
  const colR = a.column === 0 && a.x1 < 0.55 ? Math.max(a.x1, 0.5) : Math.max(a.x1, 0.94);
  const left = Math.max(0, Math.floor((colL - pad) * width));
  const right = Math.min(width, Math.ceil((colR + pad) * width));
  const top = Math.max(0, Math.floor((a.y - pad) * height));
  const bottom = Math.min(height, Math.ceil((a.y1 + pad) * height));
  if (right - left < 10 || bottom - top < 10) return null;
  return sharp(buf)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 1200, withoutEnlargement: true })
    .png()
    .toBuffer();
}

export function pngBlock(buf: Buffer): Anthropic.Beta.BetaImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } };
}

/** Extract the first top-level JSON object from a model reply. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in reply");
  return JSON.parse(body.slice(start, end + 1));
}

/** Info line through the event sink (the CLI decides how to show it). */
export const log = (...args: unknown[]) => info(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
