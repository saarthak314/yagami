// The book pane: pages stacked vertically, a clickable marker per demo step
// (left of the text, or in the column gutter for right-column paragraphs), the
// active paragraph highlighted on the page, and a reading line that decides
// which step is active.
//
// Pages are shown at "fit page" (the whole scan fits the pane width) or "fit
// text" (each page is cropped to its text column, so small type gets bigger),
// times a zoom factor. Geometry is computed from page sizes rather than
// measured, so zooming or resizing keeps the reading position exactly.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { Anchor, PageLabel, SectionId, Unit } from "../types";
import { assetUrl } from "../lib/data";

/** Fraction of the pane's height where the reading line sits. */
export const READING_LINE = 0.38;

export type Fit = "page" | "text";

const MAX_FIT = 980; // widest a page (or text column) gets at zoom 1
const PAD_TOP = 24;
const GAP = 24;
const CROP_PAD = 0.03; // margin kept around the text column, as a fraction of page width

/**
 * Horizontal crop to the text column: one width for the whole unit (so type
 * size stays constant), centred on each page's own column (sidebars switch sides).
 */
export function textCrop(unit: Unit): { width: number; left: Map<PageLabel, number> } {
  const ext = new Map<PageLabel, [number, number]>();
  for (const a of unit.anchors) {
    const e = ext.get(a.page);
    ext.set(a.page, e ? [Math.min(e[0], a.x), Math.max(e[1], a.x1)] : [a.x, a.x1]);
  }
  const widths = [...ext.values()].map(([l, r]) => r - l).sort((a, b) => a - b);
  // A robust "widest column": ignore the odd page whose anchors span a full-width figure.
  const w = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))] : 1;
  const width = Math.min(1, w + 2 * CROP_PAD);
  const left = new Map<PageLabel, number>();
  for (const p of unit.pages) {
    const e = ext.get(p.label);
    const centre = e ? (e[0] + e[1]) / 2 : 0.5;
    left.set(p.label, Math.min(1 - width, Math.max(0, centre - width / 2)));
  }
  return { width, left };
}

export interface ReaderHandle {
  /** `onSettle` runs once the scroll has come to rest (or right away when there's nothing to animate). */
  scrollToAnchor: (id: string, smooth?: boolean, onSettle?: () => void) => void;
  /** Scroll to a section; if `preferAnchor` starts shortly below its heading, put that paragraph on the reading line instead. */
  scrollToSection: (id: SectionId, smooth?: boolean, preferAnchor?: string) => void;
  /** Scroll so that fraction `f` of page `i` is on the reading line. */
  scrollToPoint: (i: number, f: number) => void;
}

export interface ReaderPosition {
  /** Index into `markers` of the step whose paragraph top is closest above the reading line (0 before the first). */
  active: number;
  page: PageLabel;
  pageIndex: number;
  /** Fraction of the current page at the reading line. */
  pageFrac: number;
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
  fit: Fit;
  /** Bump to flash the active paragraph's highlight. */
  flashKey: number;
  /** Extra space kept free at the bottom (phone bottom sheet). */
  bottomInset?: number;
  onPosition: (p: ReaderPosition) => void;
  onMarker: (index: number) => void;
  ref?: Ref<ReaderHandle>;
}

export function Reader({ unit, markers, active, zoom, fit, flashKey, bottomInset = 0, onPosition, onMarker, ref }: Props) {
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

  // Geometry. `w` is the visible (possibly cropped) width, `fw` the full page width it implies.
  const pad = avail < 600 ? 20 : 32;
  const fitW = Math.max(240, Math.min(MAX_FIT, avail - 2 * pad));
  const colW = Math.round(fitW * zoom);
  const crop = useMemo(() => (fit === "text" ? textCrop(unit) : null), [fit, unit]);
  const geo = useMemo(() => {
    const widest = Math.max(...unit.pages.map((p) => p.width), 1);
    let y = PAD_TOP;
    return unit.pages.map((p) => {
      const w = crop ? colW : Math.round((colW * p.width) / widest);
      const fw = crop ? colW / crop.width : w;
      const h = Math.round((fw * p.height) / p.width);
      const left = crop ? (crop.left.get(p.label) ?? 0) : 0;
      const vis = crop ? crop.width : 1;
      const g = { label: p.label, top: y, w, h, fw, left, vis };
      y += h + GAP;
      return g;
    });
  }, [unit, colW, crop]);
  const pageIdx = useMemo(() => new Map(unit.pages.map((p, i) => [p.label, i])), [unit]);
  const yOf = useCallback(
    (page: PageLabel, y: number) => {
      const g = geo[pageIdx.get(page) ?? 0];
      return g ? g.top + y * g.h : 0;
    },
    [geo, pageIdx],
  );

  // Where the reading line is (page, fraction) and the horizontal centre: kept steady across relayouts.
  const point = useRef<{ i: number; f: number; hx: number } | null>(null);
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
    // If that paragraph has scrolled off the top, the demo should be about text on screen:
    // take the nearest step below the line that is visible, if there is one.
    const cur = markers[activeIdx]?.anchor;
    if (cur && yOf(cur.page, cur.y1) < s.scrollTop) {
      let below = Infinity;
      markers.forEach((m, i) => {
        const top = yOf(m.anchor.page, m.anchor.y);
        if (top > line && top < s.scrollTop + s.clientHeight && top < below) {
          below = top;
          activeIdx = i;
        }
      });
    }
    let pi = 0;
    geo.forEach((g, i) => {
      if (g.top <= line) pi = i;
    });
    const g = geo[pi];
    const f = g ? Math.min(1, Math.max(0, (line - g.top) / g.h)) : 0;
    point.current = { i: pi, f, hx: s.scrollWidth ? (s.scrollLeft + s.clientWidth / 2) / s.scrollWidth : 0.5 };
    let section = unit.sections[0]?.id ?? "";
    for (const sec of unit.sections) if (yOf(sec.page, sec.y) <= line + 1) section = sec.id;
    const fraction = Math.min(1, (pi + f) / Math.max(1, unit.pages.length));
    const key = `${activeIdx}|${pi}|${section}|${Math.round(f * 50)}`;
    if (key !== last.current) {
      last.current = key;
      onPositionRef.current({ active: activeIdx, page: g?.label ?? "", pageIndex: pi, pageFrac: f, section, fraction });
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

  // After a relayout (zoom, fit, pane resize): put the same spot back on the reading line, and keep the
  // horizontal centre where it was (centred the first time a page grows past the pane).
  const lastKey = useRef("");
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s || !avail) return;
    const key = `${colW}|${fit}|${box.h}`;
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      s.scrollTop = Math.max(0, yOf(p.page, p.y) - s.clientHeight * READING_LINE + 2);
      s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
    } else if (lastKey.current && lastKey.current !== key && point.current) {
      const g = geo[point.current.i];
      if (g) s.scrollTop = Math.max(0, g.top + point.current.f * g.h - s.clientHeight * READING_LINE);
      const wasFit = s.scrollWidth <= s.clientWidth + 1;
      s.scrollLeft = (wasFit ? 0.5 : point.current.hx) * s.scrollWidth - s.clientWidth / 2;
    }
    lastKey.current = key;
    last.current = "";
    update();
  }, [avail, box.h, colW, fit, geo, update, yOf]);

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
      scrollToAnchor: (id, smooth = true, onSettle) => {
        const a = unit.anchors.find((x) => x.id === id);
        if (a) scrollTo(a.page, a.y, smooth);
        const s = scroller.current;
        if (!onSettle) return;
        if (!s || !a || !smooth) return void requestAnimationFrame(() => onSettle());
        // Settled = no scroll events for a moment (smooth scrolling fires them every frame), capped.
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(quiet);
          clearTimeout(cap);
          s.removeEventListener("scroll", onScroll);
          onSettle();
        };
        const onScroll = () => {
          clearTimeout(quiet);
          quiet = setTimeout(done, 140);
        };
        const cap = setTimeout(done, 1600);
        s.addEventListener("scroll", onScroll, { passive: true });
        quiet = setTimeout(done, 200); // nothing to scroll (already there)
      },
      scrollToSection: (id, smooth = false, preferAnchor) => {
        const sec = unit.sections.find((x) => x.id === id);
        if (!sec) return;
        const a = preferAnchor ? unit.anchors.find((x) => x.id === preferAnchor) : undefined;
        const h = scroller.current?.clientHeight ?? 800;
        if (a && avail && yOf(a.page, a.y) - yOf(sec.page, sec.y) < h * 0.3) scrollTo(a.page, a.y, smooth);
        else scrollTo(sec.page, sec.y, smooth);
      },
      scrollToPoint: (i, f) => {
        const p = unit.pages[Math.min(unit.pages.length - 1, Math.max(0, i))];
        if (p) scrollTo(p.label, f, false);
      },
    }),
    [unit, scrollTo, yOf, avail],
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
        <div className="reader-column" style={{ width: colW + 2 * pad, height: end + bottomInset + box.h * 0.62 }}>
          {avail > 0 &&
            unit.pages.map((p, i) => {
              const g = geo[i];
              // Page x (0..1 of the full scan) → % of the visible box.
              const X = (x: number) => `${((x - g.left) / g.vis) * 100}%`;
              const Wd = (w: number) => `${(w / g.vis) * 100}%`;
              return (
                <div key={p.label} className="page" style={{ top: g.top, left: pad + (colW - g.w) / 2, width: g.w, height: g.h }}>
                  <div className="page-clip skel">
                    <img
                      onLoad={(e) => e.currentTarget.parentElement?.classList.remove("skel")}
                      src={assetUrl(p.src)}
                      srcSet={p.srcset?.map((v) => `${assetUrl(v.src)} ${v.w}w`).join(", ")}
                      sizes={`${Math.round(g.fw)}px`}
                      alt={`Page ${p.label}`}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      style={{ left: -g.left * g.fw, width: g.fw, height: g.h }}
                    />
                  </div>
                  {activeAnchor && activeAnchor.page === p.label && (
                    <div
                      className={`anchor-hl${flashing ? " flash" : ""}`}
                      style={{
                        left: `calc(${X(activeAnchor.x)} - 6px)`,
                        top: `calc(${activeAnchor.y * 100}% - 3px)`,
                        width: `calc(${Wd(activeAnchor.x1 - activeAnchor.x)} + 12px)`,
                        height: `calc(${(activeAnchor.y1 - activeAnchor.y) * 100}% + 6px)`,
                      }}
                      aria-hidden
                    />
                  )}
                  {(byPage.get(p.label) ?? []).map(({ m, i: mi }) => (
                    <button
                      key={m.anchor.id}
                      className={`marker${mi === active ? " active" : ""}`}
                      style={
                        m.anchor.column === 1
                          ? { top: `${m.anchor.y * 100}%`, left: `calc(${X(m.anchor.x)} - 16px)` }
                          : { top: `${m.anchor.y * 100}%`, left: `min(-18px, calc(${X(m.anchor.x)} - 18px))` }
                      }
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
    </div>
  );
}
