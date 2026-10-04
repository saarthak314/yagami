// Sanity gate for a unit's sections and anchors (the served Unit, after assemble). No model, no
// I/O: cheap enough to run before planning, in tests and in the e2e audit. Each problem is a
// symptom of a content-step miss the planner or a reviewer should know about:
//   - headings: none found, one section swallowing the unit, numbering that runs backwards,
//     sentence-like or table-of-contents titles, small caps left split, duplicate titles;
//   - anchors: page-sized blocks, right-column anchors reaching into the left column, page
//     numbers / running heads kept as paragraphs;
//   - pages: a trailing page with nothing but a heading (the next part's title page) or nothing.

import type { Unit } from "../../src/types";

export interface SanityProblem {
  /** Stable short code, e.g. "no-sections", "giant-section", "page-sized-anchor". */
  code: string;
  /** One line for logs and reports. */
  message: string;
  /** Section or anchor ids involved. */
  ids?: string[];
}

const numParts = (id: string) => (/^\d+(\.\d+)*$/.test(id) ? id.split(".").map(Number) : null);

/** Problems with a unit's sections and anchors (empty when it looks right). `text`: UnitText.text, if at hand. */
export function unitSanity(unit: Unit, text?: Record<string, string>): SanityProblem[] {
  const out: SanityProblem[] = [];
  const add = (code: string, message: string, ids?: string[]) => out.push({ code, message, ...(ids?.length ? { ids } : {}) });
  const body = unit.anchors.filter((a) => a.kind !== "heading");
  const front = `${unit.unit}-0`;
  const sections = unit.sections.filter((s) => s.id !== front);

  // --- headings
  if (unit.pages.length >= 3 && sections.length === 0) add("no-sections", `no section headings found on ${unit.pages.length} pages`);
  const bySection = new Map<string, number>();
  for (const a of body) bySection.set(a.section, (bySection.get(a.section) ?? 0) + 1);
  const pagesOf = (id: string) => new Set(body.filter((a) => a.section === id).map((a) => a.page)).size;
  for (const [id, n] of bySection) {
    const pages = pagesOf(id);
    if (body.length >= 40 && n > 0.6 * body.length && pages >= 4 && sections.length >= 1)
      add("giant-section", `section ${id} holds ${n} of ${body.length} anchors over ${pages} pages (missed headings?)`, [id]);
  }
  const frontN = bySection.get(front) ?? 0;
  if (sections.length && body.length >= 20 && frontN > 0.3 * body.length)
    add("front-matter-heavy", `${frontN} of ${body.length} anchors come before the first heading`, [front]);
  let lastTop = 0;
  for (const s of sections) {
    const p = numParts(s.id);
    if (p) {
      if (p[0] < lastTop) add("numbering-backwards", `section ${s.id} comes after section ${lastTop}`, [s.id]);
      lastTop = Math.max(lastTop, p[0]);
    }
    const t = s.title.trim();
    const glue = t.split(/\s+/).filter((w) => /^(the|a|an|if|is|are|was|be|been|must|have|has|that|then|this|we|it)$/.test(w)).length;
    if (t.length > 80 || /[a-z][.!?]\s+[A-Z]/.test(t) || /[,;]$|\b(the|a|an|of|and|that|to)$/i.test(t) || /^[A-Z][a-z]+,\s+[a-z]/.test(t) || glue >= 4)
      add("sentence-title", `section ${s.id} title reads like a sentence: "${t.slice(0, 60)}"`, [s.id]);
    if (/\s\d{1,4}$/.test(t) && !/\b(part|chapter|section|volume|vol\.?|appendix|phase|step|level|version|v)\s+\d+$/i.test(t))
      add("toc-title", `section ${s.id} title ends in a page number (a contents entry?): "${t}"`, [s.id]);
    if (/(^|\s)[A-Z] [A-Z]{2,}/.test(t)) add("split-small-caps", `section ${s.id} title has split small caps: "${t}"`, [s.id]);
  }
  const titles = new Map<string, string[]>();
  for (const s of sections) titles.set(s.title.toLowerCase(), [...(titles.get(s.title.toLowerCase()) ?? []), s.id]);
  for (const [t, ids] of titles) if (ids.length > 1 && /^(references|bibliography|abstract|introduction|contents|conclusions?)$/.test(t)) add("duplicate-section", `"${t}" appears ${ids.length} times`, ids);

  // --- anchors
  const twoCol = new Set(body.filter((a) => a.column === 1).map((a) => a.page));
  for (const a of body) {
    if ((a.kind === "para" || a.kind === "other") && a.y1 - a.y > 0.5) add("page-sized-anchor", `${a.id} (${a.kind}) covers ${Math.round((a.y1 - a.y) * 100)}% of page ${a.page}`, [a.id]);
    if (a.kind === "para" && twoCol.has(a.page) && a.column === 1 && a.x < 0.4) add("cross-column-anchor", `${a.id} is in the right column but starts at x=${a.x.toFixed(2)}`, [a.id]);
    const t = text?.[a.id]?.trim();
    if (t !== undefined && a.kind === "para" && /^\d{1,4}$/.test(t)) add("junk-anchor", `${a.id} is just "${t}" (a page number or tick label)`, [a.id]);
  }
  if (text) {
    // The same short line as its own paragraph on several pages: a running head or footer.
    const seen = new Map<string, Set<string>>();
    for (const a of body) {
      const t = text[a.id]?.trim();
      if ((a.kind !== "para" && a.kind !== "other") || (a.y > 0.15 && a.y1 < 0.88)) continue; // margins only
      if (!t || t.length > 80 || t.split(/\s+/).length > 10) continue;
      const k = t.toLowerCase().replace(/[^a-z]/g, "");
      if (k.length < 6) continue;
      seen.set(k, new Set([...(seen.get(k) ?? []), a.page]));
    }
    for (const [k, pages] of seen)
      if (pages.size >= 3) add("running-head", `"${k.slice(0, 40)}" is a paragraph on ${pages.size} pages (running head?)`, body.filter((a) => (a.y <= 0.15 || a.y1 >= 0.88) && text[a.id]?.toLowerCase().replace(/[^a-z]/g, "") === k).map((a) => a.id));
  }

  // --- pages
  const last = unit.pages[unit.pages.length - 1]?.label;
  if (unit.pages.length >= 3 && last !== undefined) {
    const onLast = unit.anchors.filter((a) => a.page === last);
    if (!onLast.length) add("blank-last-page", `last page ${last} has no anchors (blank page?)`);
    else if (onLast.every((a) => a.kind === "heading" || a.kind === "other") && onLast.length <= 3)
      add("title-only-last-page", `last page ${last} holds only ${onLast.map((a) => a.id).join(", ")} (the next part's title page?)`, onLast.map((a) => a.id));
  }
  return out;
}
