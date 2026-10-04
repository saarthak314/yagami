import { useSyncExternalStore, type ComponentType } from "react";
import type { Anchor, Beat, DemoPlan, DemoProps, DemoSpec, Library, Unit } from "../types";

const base = import.meta.env.BASE_URL;
export const assetUrl = (src: string) => base + src.replace(/^\//, "");


/** The library index; empty when no book has been built yet (missing file or not JSON). */
export async function loadLibrary(): Promise<Library> {
  try {
    const r = await fetch(assetUrl("books/index.json"));
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return { books: [] };
    const lib = (await r.json()) as Library;
    return Array.isArray(lib?.books) ? lib : { books: [] };
  } catch {
    return { books: [] };
  }
}

const unitCache = new Map<string, Promise<Unit>>();
export function loadUnit(book: string, unit: string): Promise<Unit> {
  const key = `${book}/${unit}`;
  let p = unitCache.get(key);
  if (!p) {
    p = fetch(assetUrl(`books/${book}/units/${unit}.json`)).then((r) => {
      if (!r.ok) throw new Error(`Missing unit ${key}`);
      return r.json();
    });
    p.catch(() => unitCache.delete(key));
    unitCache.set(key, p);
  }
  return p;
}

/** Numbered ids ("13", "13-2", "3.2.1") are shown before titles; slugs ("abstract", "paper-0") are not. */
export const isNumbered = (id: string) => /^\d+([.-]\d+)*$/.test(id) && !/-0$/.test(id);

// ---------------------------------------------------------------------------
// Demo registry: src/demos/<book>/<unit>/plan.json and <Component>.tsx
// ---------------------------------------------------------------------------

type Loader = () => Promise<{ default: ComponentType<DemoProps> }>;

const planModules = import.meta.glob<DemoPlan>("../demos/*/*/plan.json", { eager: true, import: "default" });
const componentModules = import.meta.glob<{ default: ComponentType<DemoProps> }>("../demos/*/*/*.tsx");

// The registry lives on globalThis so that, while a build is writing new plans and
// demos, this module can be hot-replaced in place (see the accept() below): readers
// see the new demos without a page reload.
interface Registry {
  plans: Map<string, DemoPlan>;
  loaders: Map<string, Loader>;
  version: number;
}
const reg: Registry = ((globalThis as { __yagamiDemos?: Registry }).__yagamiDemos ??= { plans: new Map(), loaders: new Map(), version: 0 });
const plans = reg.plans;
const loaders = reg.loaders;
plans.clear();
loaders.clear();
for (const [path, plan] of Object.entries(planModules)) {
  const m = /demos\/([^/]+)\/([^/]+)\/plan\.json$/.exec(path);
  if (m) plans.set(`${m[1]}/${m[2]}`, plan);
}
for (const [path, load] of Object.entries(componentModules)) {
  const m = /demos\/([^/]+)\/([^/]+)\/(\w+)\.tsx$/.exec(path);
  if (m) loaders.set(`${m[1]}/${m[2]}/${m[3]}`, load);
}
reg.version++;
if (typeof window !== "undefined") window.dispatchEvent(new Event("yagami:demos"));
if (import.meta.hot) import.meta.hot.accept();

const subscribe = (cb: () => void) => {
  window.addEventListener("yagami:demos", cb);
  return () => window.removeEventListener("yagami:demos", cb);
};
/** Changes whenever plans or demo files are added or updated (re-render on it). */
export function useDemosVersion(): number {
  return useSyncExternalStore(subscribe, () => reg.version);
}

/** `unitKey` is "<book>/<unit>". */
export function planFor(unitKey: string): DemoPlan | undefined {
  return plans.get(unitKey);
}

export function loaderFor(unitKey: string, component: string): Loader | undefined {
  return loaders.get(`${unitKey}/${component}`);
}

export interface BeatRef {
  demo: DemoSpec;
  beat: Beat;
  /** Index of the beat within its demo. */
  index: number;
}

/** Anchors in reading order: page, then column, then top edge. */
export function anchorsInOrder(unit: Unit): Anchor[] {
  const pageIdx = new Map(unit.pages.map((p, i) => [p.label, i]));
  return [...unit.anchors].sort(
    (a, b) => (pageIdx.get(a.page) ?? 0) - (pageIdx.get(b.page) ?? 0) || (a.column ?? 0) - (b.column ?? 0) || a.y - b.y,
  );
}

/** All beats of a unit whose anchors exist, in reading order (one beat per anchor). */
export function beatsInOrder(plan: DemoPlan | undefined, unit: Unit): (BeatRef & { anchor: Anchor })[] {
  if (!plan) return [];
  const ordered = anchorsInOrder(unit);
  const pos = new Map(ordered.map((a, i) => [a.id, i]));
  const out: (BeatRef & { anchor: Anchor; pos: number })[] = [];
  for (const demo of plan.demos) {
    demo.beats.forEach((beat, index) => {
      const p = pos.get(beat.anchor);
      if (p !== undefined) out.push({ demo, beat, index, anchor: ordered[p], pos: p });
    });
  }
  out.sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.beat.anchor) ? false : (seen.add(b.beat.anchor), true)));
}
