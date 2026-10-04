// The book pane: pages stacked vertically at fit-width × zoom, a clickable
// marker per demo step (left of the page, or in the column gutter for
// right-column paragraphs), the active paragraph highlighted on the page, and
// a reading line that decides which step is active.
//
// Page geometry is computed from each page's aspect ratio rather than measured,
// so zooming or resizing the pane keeps the reading position exactly.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { Anchor, PageLabel, SectionId, Unit } from "../types";
import { assetUrl } from "../lib/data";

/** Fraction of the pane's height where the reading line sits. */
export const READING_LINE = 0.38;

const MAX_FIT = 980; // widest a page gets at zoom 1 ("fit width")
const PAD_TOP = 24;
const GAP = 24;

export interface ReaderHandle {
  scrollToAnchor: (id: string, smooth?: boolean) => void;
  scrollToSection: (id: SectionId, smooth?: boolean) => void;
}

export interface ReaderPosition {
  /** Index into `markers` of the step whose paragraph top is closest above the reading line (0 before the first). */
  active: number;
  page: PageLabel;
  pageIndex: number;
  section: SectionId;
  /** 0..1 through the unit. */
  fraction: number;
}

export interface Marker {
  anchor: Anchor;
  /** Tooltip, e.g. "Scaled dot-product attention · step 2 of 6". */
  label: string;
}

interface Props {
  unit: Unit;
  /** Demo steps in reading order. */
  markers: Marker[];
  /** Index into `markers` of the step shown in the demo pane (-1: none). */
  active: number;
  zoom: number;
  /** Bump to flash the active paragraph's highlight. */
  flashKey: number;
  /** Extra space kept free at the bottom (phone bottom sheet). */
  bottomInset?: number;
  onPosition: (p: ReaderPosition) => void;
  onMarker: (index: number) => void;
  ref?: Ref<ReaderHandle>;
}

export function Reader({ unit, markers, active, zoom, flashKey, bottomInset = 0, onPosition, onMarker, ref }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const avail = box.w;

  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const set = () => setBox((b) => (b.w === s.clientWidth && b.h === s.clientHeight ? b : { w: s.clientWidth, h: s.clientHeight }));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(s);
    return () => ro.disconnect();
  }, []);

  // Geometry: every page scaled to the same width (relative to the widest scan).
  const pad = avail < 600 ? 20 : 32;
  const fit = Math.max(240, Math.min(MAX_FIT, avail - 2 * pad));
  const pageW = Math.round(fit * zoom);
  const geo = useMemo(() => {
    const widest = Math.max(...unit.pages.map((p) => p.width), 1);
    let y = PAD_TOP;
    return unit.pages.map((p) => {
      const w = Math.round((pageW * p.width) / widest);
      const h = Math.round((w * p.height) / p.width);
      const g = { label: p.label, top: y, w, h };
      y += h + GAP;
      return g;
    });
  }, [unit, pageW]);
  const pageIdx = useMemo(() => new Map(unit.pages.map((p, i) => [p.label, i])), [unit]);
  const yOf = useCallback(
    (page: PageLabel, y: number) => {
      const g = geo[pageIdx.get(page) ?? 0];
      return g ? g.top + y * g.h : 0;
    },
    [geo, pageIdx],
  );

  // Where the reading line is, as (page, fraction of page): kept steady across relayouts.
  const point = useRef<{ i: number; f: number } | null>(null);
  const last = useRef("");
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  const update = useCallback(() => {
    const s = scroller.current;
    if (!s || !avail) return;
    const line = s.scrollTop + s.clientHeight * READING_LINE;
    let activeIdx = 0;
    let best = -Infinity;
    markers.forEach((m, i) => {
      const top = yOf(m.anchor.page, m.anchor.y);
      if (top <= line + 1 && top >= best) {
        best = top;
        activeIdx = i;
      }
    });
    let pi = 0;
    geo.forEach((g, i) => {
      if (g.top <= line) pi = i;
    });
    const g = geo[pi];
    point.current = { i: pi, f: g ? (line - g.top) / g.h : 0 };
    let section = unit.sections[0]?.id ?? "";
    for (const sec of unit.sections) if (yOf(sec.page, sec.y) <= line + 1) section = sec.id;
    const fraction = unit.pages.length > 1 ? Math.min(1, Math.max(0, pi + (point.current?.f ?? 0)) / unit.pages.length) : Math.min(1, Math.max(0, point.current.f));
    const key = `${activeIdx}|${pi}|${section}|${Math.round(fraction * 100)}`;
    if (key !== last.current) {
      last.current = key;
      onPositionRef.current({ active: activeIdx, page: g?.label ?? "", pageIndex: pi, section, fraction });
    }
  }, [avail, markers, geo, unit, yOf]);

  // Scroll requests made before the first layout wait for it (kept as page positions, not pixels).
  const pending = useRef<{ page: PageLabel; y: number } | null>(null);
  const scrollTo = useCallback(
    (page: PageLabel, y: number, smooth: boolean) => {
      const s = scroller.current;
      if (!s || !avail) {
        pending.current = { page, y };
        return;
      }
      s.scrollTo({ top: Math.max(0, yOf(page, y) - s.clientHeight * READING_LINE + 2), behavior: smooth ? "smooth" : "auto" });
    },
    [avail, yOf],
  );

  // After a relayout (zoom, pane resize): put the same spot back on the reading line.
  const lastW = useRef(0);
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s || !avail) return;
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      s.scrollTop = Math.max(0, yOf(p.page, p.y) - s.clientHeight * READING_LINE + 2);
    } else if (lastW.current && lastW.current !== pageW && point.current) {
      const g = geo[point.current.i];
      if (g) s.scrollTop = Math.max(0, g.top + point.current.f * g.h - s.clientHeight * READING_LINE);
      // Zoomed past the pane: start at the left edge, where lines begin.
      s.scrollLeft = 0;
    }
    lastW.current = pageW;
    last.current = "";
    update();
  }, [avail, pageW, geo, update, yOf]);

  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    s.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      s.removeEventListener("scroll", onScroll);
    };
  }, [update]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToAnchor: (id, smooth = true) => {
        const a = unit.anchors.find((x) => x.id === id);
        if (a) scrollTo(a.page, a.y, smooth);
      },
      scrollToSection: (id, smooth = false) => {
        const sec = unit.sections.find((x) => x.id === id);
        if (sec) scrollTo(sec.page, sec.y, smooth);
      },
    }),
    [unit, scrollTo],
  );

  // Flash the highlight when asked ("show in text").
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!flashKey) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 1100);
    return () => clearTimeout(t);
  }, [flashKey]);

  const byPage = new Map<PageLabel, { m: Marker; i: number }[]>();
  markers.forEach((m, i) => {
    const list = byPage.get(m.anchor.page) ?? [];
    list.push({ m, i });
    byPage.set(m.anchor.page, list);
  });
  const activeAnchor = markers[active]?.anchor;
  const end = geo.length ? geo[geo.length - 1].top + geo[geo.length - 1].h : 0;

  return (
    <div className="reader">
      <div className="reader-scroll" ref={scroller}>
        <div className="reader-column" style={{ width: pageW + 2 * pad, height: end + bottomInset + box.h * 0.62 }}>
          {avail > 0 &&
            unit.pages.map((p, i) => {
              const g = geo[i];
              return (
                <div key={p.label} className="page" style={{ top: g.top, left: pad + (pageW - g.w) / 2, width: g.w, height: g.h }}>
                  <img src={assetUrl(p.src)} alt={`Page ${p.label}`} loading="lazy" decoding="async" draggable={false} />
                  {activeAnchor && activeAnchor.page === p.label && (
                    <div
                      className={`anchor-hl${flashing ? " flash" : ""}`}
                      style={{
                        left: `calc(${activeAnchor.x * 100}% - 6px)`,
                        top: `calc(${activeAnchor.y * 100}% - 3px)`,
                        width: `calc(${(activeAnchor.x1 - activeAnchor.x) * 100}% + 12px)`,
                        height: `calc(${(activeAnchor.y1 - activeAnchor.y) * 100}% + 6px)`,
                      }}
                      aria-hidden
                    />
                  )}
                  {(byPage.get(p.label) ?? []).map(({ m, i: mi }) => (
                    <button
                      key={m.anchor.id}
                      className={`marker${mi === active ? " active" : ""}`}
                      style={m.anchor.column === 1 ? { top: `${m.anchor.y * 100}%`, left: `calc(${m.anchor.x * 100}% - 16px)` } : { top: `${m.anchor.y * 100}%` }}
                      title={m.label}
                      aria-label={m.label}
                      onClick={() => onMarker(mi)}
                    />
                  ))}
                </div>
              );
            })}
        </div>
      </div>
      <div className="reading-line" style={{ top: `${READING_LINE * 100}%` }} aria-hidden />
    </div>
  );
}
