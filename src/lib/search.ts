// Everything the command palette can jump to: books, chapters, sections and
// demos, plus the site themes.

import type { Library } from "../types";
import { THEMES, type ThemeId } from "../theme/themes";
import { isNumbered, planFor } from "./data";

export interface Target {
  book: string;
  unit?: string;
  section?: string;
  /** Anchor id to scroll to once the unit is open (demos). */
  anchor?: string;
}

export interface SearchItem {
  kind: "Book" | "Chapter" | "Section" | "Demo" | "Theme";
  title: string;
  /** Where it lives, e.g. "Feynman Lectures · 13". */
  context: string;
  target: Target;
  /** Lower-cased text the query is matched against. */
  hay: string;
  /** For "Theme" items: the theme to switch to. */
  theme?: ThemeId;
}

export function searchIndex(lib: Library): SearchItem[] {
  const items: SearchItem[] = [];
  const add = (kind: SearchItem["kind"], title: string, context: string, target: Target) =>
    items.push({ kind, title, context, target, hay: `${title} ${context}`.toLowerCase() });

  for (const b of lib.books) {
    add("Book", b.title, b.subtitle ?? "", { book: b.slug });
    const multi = b.units.length > 1;
    for (const u of b.units) {
      const where = multi ? `${b.short} · ${isNumbered(u.id) ? u.id : u.title}` : b.short;
      if (multi) add("Chapter", isNumbered(u.id) ? `${u.id}. ${u.title}` : u.title, b.short, { book: b.slug, unit: u.id });
      for (const s of u.sections) {
        add("Section", isNumbered(s.id) ? `${s.id} ${s.title}` : s.title, where, { book: b.slug, unit: u.id, section: s.id });
      }
      for (const d of planFor(`${b.slug}/${u.id}`)?.demos ?? []) {
        add("Demo", d.title, where, { book: b.slug, unit: u.id, anchor: d.beats[0]?.anchor });
      }
    }
  }
  for (const t of THEMES) items.push({ kind: "Theme", title: `Theme: ${t.label}`, context: "", target: { book: "" }, hay: `theme ${t.label} ${t.dark ? "dark" : "light"}`.toLowerCase(), theme: t.id });
  return items;
}

/** Items matching every word of `query`, best first. `near` (book/unit) ranks the current place higher. */
export function search(items: SearchItem[], query: string, near?: { book: string; unit?: string }): SearchItem[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const kindRank = { Demo: 0, Section: 1, Chapter: 2, Book: 3, Theme: 4 } as const;
  const scored = items
    .filter((it) => (it.kind !== "Theme" || words.length > 0) && words.every((w) => it.hay.includes(w)))
    .map((it) => {
      const t = it.title.toLowerCase();
      let score = 0;
      if (q && t.startsWith(q)) score -= 30;
      else if (q && t.includes(q)) score -= 20;
      else if (q && words.every((w) => t.includes(w))) score -= 10;
      if (near && it.target.book === near.book) score -= near.unit && it.target.unit === near.unit ? 6 : 3;
      if (!q && it.kind === "Book") score -= 8;
      return { it, score: score + kindRank[it.kind] };
    });
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.it);
}
