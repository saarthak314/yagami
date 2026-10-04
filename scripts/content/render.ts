// Render a unit's PDF pages to 300 dpi PNGs: work/<slug>/pages/p<NNNN>.png.
// Scans render greyscale; born-digital pages keep colour for their figures.
// Pages render in parallel (one pdftoppm process each) and are skipped when
// already on disk.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BookConfig } from "../../src/types";
import { pagePng, unitPages, workDir } from "../books";
import { pool } from "../lib/claude";
import { emit } from "../lib/report";
import { DPI } from "./raw";

const run = promisify(execFile);

export async function renderUnit(book: BookConfig, unitId: string): Promise<void> {
  if (!fs.existsSync(book.source.pdf)) throw new Error(`${book.slug}: missing ${book.source.pdf}${book.source.url ? ` (download from ${book.source.url})` : ""}`);
  const dir = workDir(book.slug, "pages");
  fs.mkdirSync(dir, { recursive: true });
  // Born-digital: colour, and no link-annotation boxes (hyperref's coloured borders).
  const opts = book.source.kind === "text" ? ["-hide-annotations"] : ["-gray"];
  const pages = unitPages(book, unitId);
  const todo = pages.filter((p) => !fs.existsSync(pagePng(book.slug, p)));
  let done = pages.length - todo.length;
  emit({ type: "progress", unit: unitId, stage: "render", done, total: pages.length, label: "pages" });
  await pool(todo, Math.max(2, Math.min(8, os.cpus().length)), async (p) => {
    const prefix = path.join(dir, `tmp-${p}`);
    await run("pdftoppm", ["-f", String(p), "-l", String(p), "-r", String(DPI), ...opts, "-png", "-singlefile", book.source.pdf, prefix]);
    fs.renameSync(`${prefix}.png`, pagePng(book.slug, p));
    emit({ type: "progress", unit: unitId, stage: "render", done: ++done, total: pages.length, label: "pages" });
  });
}
