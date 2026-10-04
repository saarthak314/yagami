// Contents drawer: the unit's sections, each with the demos that start there.

import { useEffect, useMemo, useRef } from "react";
import type { SectionId, Unit } from "../types";
import { anchorsInOrder, isNumbered, planFor } from "../lib/data";
import { Inline } from "../lib/inline";
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

export function Contents({ title, unitKey, unit, sections, current, activeDemo, onSection, onDemo, onClose }: Props) {
  // Each demo is filed under the section of its earliest paragraph in the text.
  const bySection = useMemo(() => {
    const out = new Map<SectionId, { id: string; title: string; anchor: string; at: number }[]>();
    if (!unit) return out;
    const order = new Map(anchorsInOrder(unit).map((a, i) => [a.id, { i, a }]));
    for (const d of planFor(unitKey)?.demos ?? []) {
      const first = d.beats
        .map((b) => order.get(b.anchor))
        .filter((x) => x !== undefined)
        .sort((x, y) => x.i - y.i)[0];
      if (!first) continue;
      const list = out.get(first.a.section) ?? [];
      list.push({ id: d.id, title: d.title, anchor: first.a.id, at: first.i });
      out.set(first.a.section, list);
    }
    for (const list of out.values()) list.sort((x, y) => x.at - y.at);
    return out;
  }, [unit, unitKey]);

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
        <button className="btn icon ghost" onClick={onClose} aria-label="Close contents" title="Close (Esc)">
          <Close />
        </button>
      </div>
      <div className="contents-list" ref={list}>
        {sections.map((s) => {
          const demos = bySection.get(s.id) ?? [];
          return (
            <div key={s.id} className={`toc-section${s.id === current ? " current" : ""}`}>
              <button className="toc-link" onClick={() => onSection(s.id)} aria-current={s.id === current ? "location" : undefined}>
                {isNumbered(s.id) && <span className="toc-num">{s.id}</span>}
                <span className="toc-text">
                  <Inline md={s.title} />
                </span>
                {demos.length > 0 && (
                  <span className="toc-count" title={`${demos.length} demo${demos.length > 1 ? "s" : ""}`}>
                    {demos.length}
                  </span>
                )}
              </button>
              {demos.map((d) => (
                <button key={d.id} className={`toc-demo${d.id === activeDemo ? " active" : ""}`} onClick={() => onDemo(d.anchor)}>
                  <span className="toc-dot" aria-hidden />
                  <span className="toc-text">
                    <Inline md={d.title} />
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
