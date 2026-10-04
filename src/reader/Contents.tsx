// Contents: the unit's sections, each with the demos that start there.

import { useEffect, useMemo, useRef } from "react";
import type { Anchor, SectionId, Unit } from "../types";
import { isNumbered, type BeatRef } from "../lib/data";
import { Inline } from "../lib/inline";
import { Close } from "../ui/icons";

interface Props {
  title: string;
  sections: Unit["sections"];
  /** Demo steps in reading order. */
  beats: (BeatRef & { anchor: Anchor })[];
  current: SectionId;
  activeDemo?: string;
  onSection: (id: SectionId) => void;
  onDemo: (anchorId: string) => void;
  onClose: () => void;
}

export function Contents({ title, sections, beats, current, activeDemo, onSection, onDemo, onClose }: Props) {
  // Each demo is listed once, under the section of its first step.
  const bySection = useMemo(() => {
    const seen = new Set<string>();
    const out = new Map<SectionId, { id: string; title: string; anchor: string }[]>();
    for (const b of beats) {
      if (seen.has(b.demo.id)) continue;
      seen.add(b.demo.id);
      const list = out.get(b.anchor.section) ?? [];
      list.push({ id: b.demo.id, title: b.demo.title, anchor: b.anchor.id });
      out.set(b.anchor.section, list);
    }
    return out;
  }, [beats]);

  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".toc-section.current")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <nav className="contents" aria-label="Contents">
      <div className="contents-head">
        <span className="contents-title">
          <Inline md={title} />
        </span>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close contents" title="Close (t)">
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
