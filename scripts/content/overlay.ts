// QA: draw anchor boxes, ids and reading order onto the 300 dpi renders.
// npx tsx scripts/content/overlay.ts --book <slug> --unit <id> [--pages 3,4]   → work/<slug>/overlay/p<NNNN>.png

import fs from "node:fs";
import sharp from "sharp";
import { loadBook, pagePng, pageFile, rawUnitPath, workDir } from "../books";
import type { RawUnit } from "./raw";

const COLOURS: Record<string, string> = {
  heading: "#d33",
  para: "#1a6fd8",
  equation: "#0a0",
  figure: "#c60",
  table: "#a0a",
  other: "#888",
};

export async function overlay(slug: string, unit: string, onlyPages?: number[]): Promise<string[]> {
  const raw: RawUnit = JSON.parse(fs.readFileSync(rawUnitPath(slug, unit), "utf8"));
  const dir = workDir(slug, "overlay");
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const p of raw.pages) {
    if (onlyPages && !onlyPages.includes(p.pdfPage)) continue;
    const meta = await sharp(pagePng(slug, p.pdfPage)).metadata();
    const items = raw.anchors
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.pdfPage === p.pdfPage)
      .map(({ a, i }) => {
        const c = COLOURS[a.kind] ?? "#000";
        const { l, t, r, b } = a.box;
        return `<rect x="${l}" y="${t}" width="${r - l}" height="${b - t}" fill="none" stroke="${c}" stroke-width="4"/>
          <text x="${l - 8}" y="${t + 26}" font-size="26" font-family="Menlo" fill="${c}" text-anchor="end">${i}</text>
          <text x="${r + 8}" y="${t + 26}" font-size="22" font-family="Menlo" fill="${c}">${a.id}${a.column ? " c1" : ""}</text>`;
      });
    const c = p.crop;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">
      <rect x="${c.left}" y="${c.top}" width="${c.width}" height="${c.height}" fill="none" stroke="#f0f" stroke-dasharray="20 12" stroke-width="3"/>
      ${items.join("\n")}</svg>`;
    const file = `${dir}/${pageFile(p.pdfPage)}.png`;
    const drawn = await sharp(pagePng(slug, p.pdfPage))
      .flatten({ background: "#fff" })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer();
    await sharp(drawn).resize({ width: 1400 }).png().toFile(file);
    out.push(file);
  }
  return out;
}

if (process.argv[1]?.endsWith("overlay.ts")) {
  const args = process.argv.slice(2);
  const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const book = loadBook(arg("--book")!);
  const unit = arg("--unit") ?? book.units[0].id;
  const pages = arg("--pages")?.split(",").map(Number);
  for (const f of await overlay(book.slug, unit, pages)) console.log(f);
}
