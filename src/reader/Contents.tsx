// Contents drawer: the unit's sections, each with the demos that have steps there (a demo whose steps span
// several sections is listed under each). Demos with steps before the first heading open the list.

import { useEffect, useMemo, useRef } from "react";
import type { SectionId, Unit } from "../types";
import { anchorsInOrder, isNumbered, planFor } from "../lib/data";
import { Inline } from "../lib/inline";
import { cleanTitle } from "../lib/titles";
import { Close } from "../ui/icons";

interface Props {
  title: string;
  unitKey: string;
  unit: Unit | null;
  sections: Unit["sections"];
  current: SectionId;
  activeDemo?: string;
  onSection: (id: SectionId) => void;
  onDemo: (anchorId: string) => void;
  onClose: () => void;
}

interface Entry {
  id: string;
  title: string;
  /** The demo's first step in this section. */
  anchor: string;
  at: number;
  flagged?: string;
}

const BEGINNING = "\u0000beginning" as SectionId;

export function Contents({ title, unitKey, unit, sections, current, activeDemo, onSection, onDemo, onClose }: Props) {
  // Each demo is filed under every section it has a step in, linked to its first step there. Steps in text
  // outside the listed sections (the unit's opening, before the first heading) go under BEGINNING.
  const { bySection, start } = useMemo(() => {
    const out = new Map<SectionId, Entry[]>();
    if (!unit) return { bySection: out, start: undefined };
    const ordered = anchorsInOrder(unit);
    const listed = new Set(sections.map((s) => s.id));
    const order = new Map(ordered.map((a, i) => [a.id, { i, a }]));
    for (const d of planFor(unitKey)?.demos ?? []) {
      const firstIn = new Map<SectionId, { i: number; id: string }>();
      for (const b of d.beats) {
        const o = order.get(b.anchor);
        if (!o) continue;
        const key = listed.has(o.a.section) ? o.a.section : BEGINNING;
        const had = firstIn.get(key);
        if (!had || o.i < had.i) firstIn.set(key, { i: o.i, id: o.a.id });
      }
      for (const [key, f] of firstIn) {
        const list = out.get(key) ?? [];
        list.push({ id: d.id, title: d.title, anchor: f.id, at: f.i, flagged: d.flagged });
        out.set(key, list);
      }
    }
    for (const list of out.values()) list.sort((x, y) => x.at - y.at);
    return { bySection: out, start: ordered[0]?.id };
  }, [unit, unitKey, sections]);
  const opening = bySection.get(BEGINNING) ?? [];

  const demoRows = (demos: Entry[]) =>
    demos.map((d) => (
      <button
        key={d.id}
        className={`toc-demo${d.id === activeDemo ? " active" : ""}${d.flagged ? " flagged" : ""}`}
        onClick={() => onDemo(d.anchor)}
        title={d.flagged ? `may be inaccurate: ${d.flagged}` : undefined}
      >
        <span className="toc-dot" aria-hidden />
        <span className="toc-text">
          <Inline md={d.title} />
        </span>
        {d.flagged && (
          <span className="toc-flag" aria-label="may be inaccurate">
            ?
          </span>
        )}
      </button>
    ));

  const listedCurrent = sections.some((s) => s.id === current);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".toc-section.current")?.scrollIntoView({ block: "center" });
    list.current?.querySelector<HTMLElement>(".toc-section.current .toc-link")?.focus({ preventScroll: true });
  }, []);

  return (
    <nav className="contents" aria-label="Contents">
      <div className="contents-head">
        <span className="contents-title">
          <Inline md={title} />
        </span>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close contents" title="close (esc)">
          <Close />
        </button>
      </div>
      <div className="contents-list" ref={list}>
        {opening.length > 0 && (
          <div className={`toc-section toc-opening${listedCurrent ? "" : " current"}`}>
            <button className="toc-link" onClick={() => start && onDemo(start)} aria-current={listedCurrent ? undefined : "location"}>
              <span className="toc-text">beginning</span>
              <span className="toc-count" title={`${opening.length} demo${opening.length > 1 ? "s" : ""}`}>
                {opening.length}
              </span>
            </button>
            {demoRows(opening)}
          </div>
        )}
        {sections.map((s) => {
          const demos = bySection.get(s.id) ?? [];
          return (
            <div key={s.id} className={`toc-section${s.id === current ? " current" : ""}`}>
              <button className="toc-link" onClick={() => onSection(s.id)} aria-current={s.id === current ? "location" : undefined}>
                {isNumbered(s.id) && <span className="toc-num">{s.id}</span>}
                <span className="toc-text">
                  <Inline md={cleanTitle(s.title)} />
                </span>
                {demos.length > 0 && (
                  <span className="toc-count" title={`${demos.length} demo${demos.length > 1 ? "s" : ""}`}>
                    {demos.length}
                  </span>
                )}
              </button>
              {demoRows(demos)}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
