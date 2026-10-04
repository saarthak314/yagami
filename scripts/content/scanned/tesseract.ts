// Run tesseract (TSV output) on rendered pages; cached at work/<slug>/ocr/p<NNNN>.tsv

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { pageFile, pagePng, workDir } from "../../books";

const run = promisify(execFile);

export interface Word {
  block: number;
  par: number;
  line: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

export function tsvPath(slug: string, p: number) {
  return workDir(slug, "ocr", `${pageFile(p)}.tsv`);
}

export async function tesseractPage(slug: string, p: number): Promise<void> {
  const out = tsvPath(slug, p);
  if (fs.existsSync(out)) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const base = path.join(path.dirname(out), `tmp-${pageFile(p)}`);
  await run("tesseract", [pagePng(slug, p), base, "--psm", "3", "tsv"], { env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
  fs.renameSync(`${base}.tsv`, out);
}

export function readWords(slug: string, p: number): Word[] {
  const rows = fs.readFileSync(tsvPath(slug, p), "utf8").split("\n").slice(1);
  const words: Word[] = [];
  for (const r of rows) {
    const c = r.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = c[11].trim();
    if (!text) continue;
    words.push({
      block: +c[2],
      par: +c[3],
      line: +c[4],
      left: +c[6],
      top: +c[7],
      width: +c[8],
      height: +c[9],
      conf: +c[10],
      text,
    });
  }
  return words;
}
