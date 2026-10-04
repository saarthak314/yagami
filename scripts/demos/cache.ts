// Incremental runs: remember a hash of each step's inputs so unchanged work is
// skipped. work/<slug>/cache/<unit>.json. Entries are advisory — deleting the
// file only means the next run redoes (or re-adopts) the work.

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeJson } from "./common";

export interface UnitCache {
  /** Hash of the content steps' inputs (PDF, book settings, content code) when pages + anchors were made. */
  content?: string;
  /** Hash of the planner's inputs when plan.json was written. */
  plan?: string;
  demos: Record<string, { spec?: string; code?: string; verified?: boolean }>;
}

export function hash(...parts: (string | Buffer)[]): string {
  const h = crypto.createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

export function readCache(slug: string, unit: string): UnitCache {
  const f = paths.cache(slug, unit);
  if (!fs.existsSync(f)) return { demos: {} };
  try {
    const c = JSON.parse(fs.readFileSync(f, "utf8")) as UnitCache;
    return { content: c.content, plan: c.plan, demos: c.demos ?? {} };
  } catch {
    return { demos: {} };
  }
}

/** Read-modify-write one unit's cache (synchronous, so concurrent tasks in one process don't clobber each other). */
export function updateCache(slug: string, unit: string, fn: (c: UnitCache) => void): void {
  const c = readCache(slug, unit);
  fn(c);
  writeJson(paths.cache(slug, unit), c);
}

export function fileHash(file: string): string | undefined {
  return fs.existsSync(file) ? hash(fs.readFileSync(file)) : undefined;
}
