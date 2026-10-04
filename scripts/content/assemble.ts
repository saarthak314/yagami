// Page images for dark mode + the served Unit JSON + the Library index.
//
// Each page is cut to its crop box (chosen by the anchors adapter so pages line
// up when stacked), recoloured for the dark reader and saved as webp at ~2x the
// CSS display size, with 3x/4x variants for zoom and high-DPI screens. Anchor
// boxes are normalised to the cropped page.
//
// Recolouring (BookConfig.recolor):
//   "invert"    — greyscale scans: paper → #0a0a0a, ink → #ededed; dense photos keep their tones.
//   "lightness" — born-digital colour pages: lightness is inverted in OKLab while hue and
//                 chroma are kept, so coloured figure boxes stay recognisable on dark.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Anchor, BookConfig, Library, PageImage, Unit } from "../../src/types";
import { listBooks, pageFile, pagePng, publicBookDir, rawUnitPath, unitJsonPath, workDir } from "../books";
import { pool } from "../lib/claude";
import { DPI, type RawPage, type RawUnit } from "./raw";
import { info } from "../lib/report";

/**
 * Render px → image px. Scans: 300dpi → ~200dpi (pages come out ~780 CSS px wide).
 * Born-digital pages: scaled so the page is ~800 CSS px wide (1600 px image), which puts
 * 10pt body text at ~13 px on screen.
 */
const scanScale = 2 / 3;
const TEXT_PAGE_PX = 1600;
const PAPER = 10; // #0a0a0a
const INK = 237; // #ededed

// --- "invert": greyscale ------------------------------------------------------

/** Grey → dark-mode tone: dark ink becomes light, paper becomes the page background. */
const LUT = (() => {
  const lut = new Uint8Array(256);
  for (let g = 0; g < 256; g++) {
    const t = Math.min(1, Math.max(0, (g - 50) / (235 - 50)));
    lut[g] = Math.round(INK - (INK - PAPER) * t);
  }
  return lut;
})();

/**
 * Mask of photographic regions: large connected areas of tiles that are mostly
 * ink. Line art and text are sparse and never reach the threshold.
 */
function photoMask(grey: Uint8Array, w: number, h: number): Uint8Array {
  const T = 32;
  const tw = Math.ceil(w / T);
  const th = Math.ceil(h / T);
  const dense = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      let ink = 0;
      let n = 0;
      for (let y = ty * T; y < Math.min(h, ty * T + T); y++)
        for (let x = tx * T; x < Math.min(w, tx * T + T); x++, n++) if (grey[y * w + x] < 128) ink++;
      dense[ty * tw + tx] = ink / n > 0.3 ? 1 : 0;
    }
  const mask = new Uint8Array(w * h);
  const seen = new Uint8Array(tw * th);
  for (let start = 0; start < dense.length; start++) {
    if (!dense[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let [x0, y0, x1, y1, count] = [tw, th, 0, 0, 0];
    while (stack.length) {
      const t = stack.pop()!;
      const tx = t % tw;
      const ty = (t - tx) / tw;
      count++;
      [x0, y0, x1, y1] = [Math.min(x0, tx), Math.min(y0, ty), Math.max(x1, tx), Math.max(y1, ty)];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        const nt = ny * tw + nx;
        if (nx >= 0 && ny >= 0 && nx < tw && ny < th && dense[nt] && !seen[nt]) {
          seen[nt] = 1;
          stack.push(nt);
        }
      }
    }
    if (count < 20) continue;
    for (let y = y0 * T; y < Math.min(h, (y1 + 1) * T); y++) mask.fill(1, y * w + x0 * T, y * w + Math.min(w, (x1 + 1) * T));
  }
  return mask;
}

function recolourGrey(grey: Uint8Array, w: number, h: number): Buffer {
  const photo = photoMask(grey, w, h);
  const px = Buffer.alloc(grey.length);
  for (let j = 0; j < px.length; j++) {
    // Photos with dark backgrounds keep their tones (inverting them reads as a negative).
    px[j] = photo[j] ? Math.round(PAPER + ((INK - PAPER) * grey[j]) / 255) : LUT[grey[j]];
  }
  return px;
}

// --- "lightness": colour ------------------------------------------------------

const toLinear = new Float64Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (linear: number) => {
  const c = Math.min(1, Math.max(0, linear));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
};

/** OKLab lightness of the dark-mode endpoints. */
const L_PAPER = oklab(PAPER, PAPER, PAPER)[0];
const L_INK = oklab(INK, INK, INK)[0];

function oklab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = toLinear[r8];
  const g = toLinear[g8];
  const b = toLinear[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186167 * m + 1.707614701 * s),
  ];
}

function recolourLightness(rgb: Buffer, channels: number, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3);
  const cache = new Map<number, number>();
  for (let i = 0, j = 0; j < out.length; i += channels, j += 3) {
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      const [L, a, b] = oklab(rgb[i], rgb[i + 1], rgb[i + 2]);
      // Invert lightness into [paper, ink]; keep hue, slightly soften chroma so pastels don't glow.
      const t = Math.min(1, Math.max(0, (L - 0.2) / (1 - 0.2)));
      const L2 = L_INK - (L_INK - L_PAPER) * t;
      const [r, g, bb] = fromOklab(L2, a * 0.85, b * 0.85);
      packed = (r << 16) | (g << 8) | bb;
      cache.set(key, packed);
    }
    out[j] = packed >> 16;
    out[j + 1] = (packed >> 8) & 255;
    out[j + 2] = packed & 255;
  }
  return out;
}

// --- pages ---------------------------------------------------------------------

/**
 * Hi-res source for born-digital pages: a 600 dpi render (twice the anchors'
 * 300 dpi), so the 3x/4x variants are real detail rather than upscaling.
 */
const HI_DPI = 600;
const run = promisify(execFile);

async function hiResPng(book: BookConfig, pdfPage: number): Promise<string> {
  const dir = workDir(book.slug, "pages-hi");
  const file = path.join(dir, `${pageFile(pdfPage)}.png`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const prefix = path.join(dir, `tmp-${pdfPage}`);
  await run("pdftoppm", ["-f", String(pdfPage), "-l", String(pdfPage), "-r", String(HI_DPI), "-hide-annotations", "-png", "-singlefile", book.source.pdf, prefix]);
  fs.renameSync(`${prefix}.png`, file);
  return file;
}

/**
 * Cut the page's crop box out of `png` (rendered at `k` × the anchors' DPI),
 * resize to `width` px, recolour and save as webp.
 */
async function renderVariant(book: BookConfig, page: RawPage, png: string, k: number, width: number, out: string): Promise<{ width: number; height: number }> {
  const c = page.crop;
  const EXT = 600 * k; // paper margin so crops may extend past the render edge
  const grey = book.recolor === "invert";
  let img = sharp(png, { limitInputPixels: false });
  if (grey) img = img.greyscale();
  const padded = await img
    .removeAlpha()
    .extend({ top: EXT, bottom: EXT, left: EXT, right: EXT, background: "#ffffff" })
    .toBuffer();
  const height = Math.round((width * c.height) / c.width);
  const { data, info } = await sharp(padded, { limitInputPixels: false })
    .extract({ left: Math.round(c.left * k) + EXT, top: Math.round(c.top * k) + EXT, width: Math.round(c.width * k), height: Math.round(c.height * k) })
    .resize({ width, height, kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (grey) {
    const g = new Uint8Array(info.width * info.height);
    for (let i = 0, j = 0; j < g.length; i += info.channels, j++) g[j] = data[i];
    await sharp(recolourGrey(g, info.width, info.height), { raw: { width: info.width, height: info.height, channels: 1 } })
      .webp({ quality: 82 })
      .toFile(out);
  } else {
    await sharp(recolourLightness(data, info.channels, info.width, info.height), { raw: { width: info.width, height: info.height, channels: 3 } })
      .webp({ quality: 85 })
      .toFile(out);
  }
  return { width: info.width, height: info.height };
}

/**
 * The page at ~2x its CSS width (`<label>.webp`), plus sharper variants for
 * zoom and high-DPI screens: 3x and 4x for born-digital pages (from a 600 dpi
 * render), 3x for scans (their full resolution; more would only upscale).
 */
async function renderPage(book: BookConfig, page: RawPage, dir: string, url: string): Promise<{ base: { width: number; height: number }; srcset: { src: string; w: number }[] }> {
  const text = book.source.kind === "text";
  const baseW = Math.round(page.crop.width * (text ? Math.min(1, TEXT_PAGE_PX / page.crop.width) : scanScale));
  const base = await renderVariant(book, page, pagePng(book.slug, page.pdfPage), 1, baseW, path.join(dir, `${page.label}.webp`));
  const srcset = [{ src: `${url}/${page.label}.webp`, w: base.width }];
  const extra: [string, number][] = text ? [["3x", 1.5], ["4x", 2]] : [["3x", 1.5]];
  const hi = text ? await hiResPng(book, page.pdfPage) : pagePng(book.slug, page.pdfPage);
  const k = text ? HI_DPI / DPI : 1;
  for (const [name, f] of extra) {
    const w = Math.round(base.width * f);
    if (w > page.crop.width * k + 2) continue; // never upscale past the source (± rounding)
    const v = await renderVariant(book, page, hi, k, w, path.join(dir, `${page.label}@${name}.webp`));
    srcset.push({ src: `${url}/${page.label}@${name}.webp`, w: v.width });
  }
  return { base, srcset };
}

export async function assembleUnit(book: BookConfig, unitId: string): Promise<void> {
  const raw: RawUnit = JSON.parse(fs.readFileSync(rawUnitPath(book.slug, unitId), "utf8"));
  const pageDir = publicBookDir(book.slug, "pages", unitId);
  fs.mkdirSync(pageDir, { recursive: true });

  const url = `books/${book.slug}/pages/${unitId}`;
  const pages: PageImage[] = await pool(raw.pages, 4, async (p) => {
    const { base, srcset } = await renderPage(book, p, pageDir, url);
    return {
      label: p.label,
      src: `${url}/${p.label}.webp`,
      width: Math.round(base.width / 2),
      height: Math.round(base.height / 2),
      ...(srcset.length > 1 ? { srcset } : {}),
    };
  });

  const byPage = new Map(raw.pages.map((p) => [p.pdfPage, p]));
  const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const norm = (pdfPage: number, x: number, y: number) => {
    const c = byPage.get(pdfPage)!.crop;
    return { x: r4((x - c.left) / c.width), y: r4((y - c.top) / c.height) };
  };

  // Raw anchors are already in reading order (page → column → top-down).
  const anchors: Anchor[] = raw.anchors.map((a) => {
    const tl = norm(a.pdfPage, a.box.l, a.box.t);
    const br = norm(a.pdfPage, a.box.r, a.box.b);
    return { id: a.id, section: a.section, page: byPage.get(a.pdfPage)!.label, y: tl.y, y1: br.y, x: tl.x, x1: br.x, column: a.column, kind: a.kind };
  });

  const doc: Unit = {
    book: book.slug,
    unit: unitId,
    title: raw.title,
    sections: raw.sections.map((s) => ({ id: s.id, title: s.title, page: byPage.get(s.pdfPage)!.label, y: norm(s.pdfPage, 0, s.top).y })),
    pages,
    anchors,
  };
  const file = unitJsonPath(book.slug, unitId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  writeLibrary();
  info(`assemble: ${book.slug}/${unitId} ${pages.length} pages, ${anchors.length} anchors, ${doc.sections.length} sections`);
}

/** public/books/index.json: every book with at least one assembled unit, units in config order. */
export function writeLibrary(): void {
  const books: Library["books"] = [];
  for (const b of listBooks().sort((x, y) => x.title.localeCompare(y.title))) {
    const units = b.units
      .filter((u) => fs.existsSync(unitJsonPath(b.slug, u.id)))
      .map((u) => {
        const doc = JSON.parse(fs.readFileSync(unitJsonPath(b.slug, u.id), "utf8")) as Unit;
        return { id: u.id, title: u.title, sections: doc.sections };
      });
    if (units.length) books.push({ slug: b.slug, title: b.title, short: b.short, subtitle: b.subtitle, domain: b.domain, units });
  }
  const file = path.resolve("public/books/index.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ books } satisfies Library, null, 2));
}
