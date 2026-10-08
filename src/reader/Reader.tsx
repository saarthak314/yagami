// The book pane: pages stacked vertically, a clickable marker per demo step
// (left of the text, or in the column gutter for right-column paragraphs), the
// active paragraph highlighted on the page, and a reading line that decides
// which step is active.
//
// Pages are shown at "fit page" (the whole scan fits the pane width), "fit
// text" (each page is cropped to its text column, so small type gets bigger) or
// "fit column" (two-column pages become two stacked slices, left column then
// right, for phones), times a zoom factor. Geometry is computed from page sizes
// rather than measured, so zooming or resizing keeps the reading position exactly.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { Anchor, PageLabel, SectionId, Unit } from "../types";
import { assetUrl } from "../lib/data";

/** Fraction of the pane's height where the reading line sits. */
export const READING_LINE = 0.38;

export type Fit = "page" | "text" | "column";

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

/** A unit laid out in two columns (enough right-column paragraphs to matter). */
export function isTwoColumn(unit: Unit): boolean {
  const body = unit.anchors.filter((a) => a.kind === "para");
  return body.length > 0 && body.filter((a) => a.column === 1).length / body.length >= 0.2;
}

/**
 * Crop bands for "fit column": one width for the whole unit (type size stays constant), with a left edge per
 * column, from the paragraphs that sit inside one column (full-width blocks are ignored).
 */
export function columnBands(unit: Unit): { width: number; left: [number, number] } {
  const q = (xs: number[], f: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * f))] : 0);
  const narrow = unit.anchors.filter((a) => a.kind === "para" && a.x1 - a.x < 0.6);
  const band = (col: 0 | 1, fallback: [number, number]): [number, number] => {
    const as = narrow.filter((a) => (a.column ?? 0) === col);
    return as.length ? [q(as.map((a) => a.x), 0.1), q(as.map((a) => a.x1), 0.9)] : fallback;
  };
  const b0 = band(0, [0, 0.5]);
  const b1 = band(1, [0.5, 1]);
  const width = Math.min(1, Math.max(b0[1] - b0[0], b1[1] - b1[0]) + 2 * CROP_PAD);
  const leftOf = (b: [number, number]) => Math.min(1 - width, Math.max(0, (b[0] + b[1]) / 2 - width / 2));
  return { width, left: [leftOf(b0), leftOf(b1)] };
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
  /** Height covered at the bottom (the phone's bottom sheet): kept free at the end, and the reading line sits in
   * the part of the pane above it. */
  bottomInset?: number;
  onPosition: (p: ReaderPosition) => void;
  onMarker: (index: number) => void;
  /** The reader scrolled the text themselves (wheel, touch, keys, scrollbar) — not a programmatic scroll. */
  onUserScroll?: () => void;
  ref?: Ref<ReaderHandle>;
}

/** One visible strip of a page: the whole page, its text column, or (fit column) one of its two columns. */
interface Slice {
  label: PageLabel;
  /** Page index. */
  pi: number;
  /** Which column this slice shows (fit column on a two-column unit), else null. */
  col: 0 | 1 | null;
  top: number;
  w: number;
  h: number;
  fw: number;
  left: number;
  vis: number;
}

export function Reader({ unit, markers, active, zoom, fit, flashKey, bottomInset = 0, onPosition, onMarker, onUserScroll, ref }: Props) {
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
  const twoCol = useMemo(() => isTwoColumn(unit), [unit]);
  const columns = fit === "column" && twoCol;
  const crop = useMemo(() => (fit === "text" || (fit === "column" && !twoCol) ? textCrop(unit) : null), [fit, twoCol, unit]);
  const bands = useMemo(() => (columns ? columnBands(unit) : null), [columns, unit]);
  const geo = useMemo<Slice[]>(() => {
    const widest = Math.max(...unit.pages.map((p) => p.width), 1);
    let y = PAD_TOP;
    const out: Slice[] = [];
    unit.pages.forEach((p, pi) => {
      const parts: { col: 0 | 1 | null; vis: number; left: number }[] = bands
        ? [
            { col: 0, vis: bands.width, left: bands.left[0] },
            { col: 1, vis: bands.width, left: bands.left[1] },
          ]
        : [{ col: null, vis: crop ? crop.width : 1, left: crop ? (crop.left.get(p.label) ?? 0) : 0 }];
      for (const part of parts) {
        const cropped = part.vis < 1;
        const w = cropped ? colW : Math.round((colW * p.width) / widest);
        const fw = cropped ? colW / part.vis : w;
        const h = Math.round((fw * p.height) / p.width);
        out.push({ label: p.label, pi, col: part.col, top: y, w, h, fw, left: part.left, vis: part.vis });
        // The two columns of one page read as one block: a small gap between them, the usual one after the page.
        y += h + (part.col === 0 ? Math.round(GAP / 2) : GAP);
      }
    });
    return out;
  }, [unit, colW, crop, bands]);
  // Slice index by page (and column): anchors in the right column sit in the page's second slice.
  const sliceOf = useMemo(() => {
    const first = new Map<PageLabel, number>();
    geo.forEach((g, i) => {
      if (!first.has(g.label)) first.set(g.label, i);
    });
    return (page: PageLabel, col?: 0 | 1) => {
      const i = first.get(page) ?? 0;
      return columns && col === 1 ? i + 1 : i;
    };
  }, [geo, columns]);
  const yOf = useCallback(
    (page: PageLabel, y: number, col?: 0 | 1) => {
      const g = geo[sliceOf(page, col)];
      return g ? g.top + y * g.h : 0;
    },
    [geo, sliceOf],
  );
  const anchorTop = useCallback((a: Anchor) => yOf(a.page, a.y, a.column), [yOf]);

  // Where each section starts in reading order: its heading (or first) paragraph, with the column it sits in.
  const sectionStarts = useMemo(() => {
    const byId = new Map(unit.anchors.map((a) => [a.id, a]));
    const firstOf = new Map<string, Anchor>();
    const pageIdx = new Map(unit.pages.map((p, i) => [p.label, i]));
    const rank = (a: Anchor) => (pageIdx.get(a.page) ?? 0) * 4 + (a.column ?? 0) * 2 + a.y;
    for (const a of unit.anchors) {
      const cur = firstOf.get(a.section);
      if (!cur || rank(a) < rank(cur)) firstOf.set(a.section, a);
    }
    return unit.sections.map((sec) => {
      const a = byId.get(`${sec.id}-h`) ?? firstOf.get(sec.id);
      return { id: sec.id, page: a?.page ?? sec.page, y: a?.y ?? sec.y, col: (a?.column ?? 0) as 0 | 1 };
    });
  }, [unit]);
  const pageIdx = useMemo(() => new Map(unit.pages.map((p, i) => [p.label, i])), [unit]);

  // Where the reading line is (page, fraction) and the horizontal centre: kept steady across relayouts.
  const point = useRef<{ pi: number; col?: 0 | 1; f: number; hx: number } | null>(null);
  const last = useRef("");
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  // The part of the pane the text is read in: above the bottom sheet, when there is one.
  const viewH = useCallback((s: HTMLElement) => Math.max(1, s.clientHeight - bottomInset), [bottomInset]);

  const update = useCallback(() => {
    const s = scroller.current;
    if (!s || !avail) return;
    const line = s.scrollTop + viewH(s) * READING_LINE;
    let activeIdx = 0;
    let best = -Infinity;
    markers.forEach((m, i) => {
      const top = anchorTop(m.anchor);
      if (top <= line + 1 && top >= best) {
        best = top;
        activeIdx = i;
      }
    });
    // If that paragraph has scrolled off the top, the demo should be about text on screen:
    // take the nearest step below the line that is visible, if there is one.
    const cur = markers[activeIdx]?.anchor;
    if (cur && yOf(cur.page, cur.y1, cur.column) < s.scrollTop) {
      let below = Infinity;
      markers.forEach((m, i) => {
        const top = anchorTop(m.anchor);
        if (top > line && top < s.scrollTop + viewH(s) && top < below) {
          below = top;
          activeIdx = i;
        }
      });
    }
    let si = 0;
    geo.forEach((g, i) => {
      if (g.top <= line) si = i;
    });
    const g = geo[si];
    const pi = g?.pi ?? 0;
    const f = g ? Math.min(1, Math.max(0, (line - g.top) / g.h)) : 0;
    point.current = { pi, col: g?.col ?? undefined, f, hx: s.scrollWidth ? (s.scrollLeft + s.clientWidth / 2) / s.scrollWidth : 0.5 };
    // Section: the last one whose start the reader has passed, in reading order. With fit column the slices are
    // already in reading order; otherwise, on a two-column page, the column being read is the active step's
    // column when that step is on this page (else the left one) — so a heading at the top of the right column
    // isn't "passed" while the left column is being read.
    const readCol: 0 | 1 = !columns && cur && cur.page === g?.label ? (cur.column ?? 0) : 0;
    const here = columns ? si + f : pi * 4 + readCol * 2 + f;
    const at = (p: { page: PageLabel; y: number; col: 0 | 1 }) => (columns ? sliceOf(p.page, p.col) + p.y : (pageIdx.get(p.page) ?? 0) * 4 + p.col * 2 + p.y);
    let section = unit.sections[0]?.id ?? "";
    let bestAt = -Infinity;
    for (const st of sectionStarts) {
      const a = at(st);
      if (a <= here + 1e-6 && a >= bestAt) {
        bestAt = a;
        section = st.id;
      }
    }
    const fraction = Math.min(1, (pi + f) / Math.max(1, unit.pages.length));
    const key = `${activeIdx}|${si}|${section}|${Math.round(f * 50)}`;
    if (key !== last.current) {
      last.current = key;
      onPositionRef.current({ active: activeIdx, page: g?.label ?? "", pageIndex: pi, pageFrac: f, section, fraction });
    }
  }, [avail, markers, geo, unit, yOf, anchorTop, columns, sectionStarts, sliceOf, pageIdx, viewH]);

  // Scroll requests made before the first layout wait for it (kept as page positions, not pixels).
  const pending = useRef<{ page: PageLabel; y: number; col?: 0 | 1 } | null>(null);
  const scrollTo = useCallback(
    (page: PageLabel, y: number, smooth: boolean, col?: 0 | 1) => {
      const s = scroller.current;
      if (!s || !avail) {
        pending.current = { page, y, col };
        return;
      }
      s.scrollTo({ top: Math.max(0, yOf(page, y, col) - viewH(s) * READING_LINE + 2), behavior: smooth ? "smooth" : "auto" });
    },
    [avail, yOf, viewH],
  );

  // After a relayout (zoom, fit, pane resize, bottom sheet): put the same spot back on the reading line, and keep the
  // horizontal centre where it was (centred the first time a page grows past the pane).
  const lastKey = useRef("");
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s || !avail) return;
    // (The bottom sheet opening or closing moves the reading line: the same spot goes back on it.)
    const key = `${colW}|${fit}|${box.h}|${bottomInset}`;
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      s.scrollTop = Math.max(0, yOf(p.page, p.y, p.col) - viewH(s) * READING_LINE + 2);
      s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
    } else if (lastKey.current && lastKey.current !== key && point.current) {
      // Same page and column as before, whatever the new slicing (fit column splits pages, the others don't).
      const label = unit.pages[point.current.pi]?.label;
      const g = label !== undefined ? geo[sliceOf(label, point.current.col)] : undefined;
      if (g) s.scrollTop = Math.max(0, g.top + point.current.f * g.h - viewH(s) * READING_LINE);
      const wasFit = s.scrollWidth <= s.clientWidth + 1;
      s.scrollLeft = (wasFit ? 0.5 : point.current.hx) * s.scrollWidth - s.clientWidth / 2;
    }
    lastKey.current = key;
    last.current = "";
    update();
  }, [avail, box.h, bottomInset, colW, fit, geo, update, yOf, sliceOf, unit, viewH]);

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

  // Scrolling by hand (not a jump to a step): wheel, touch, scroll keys, or dragging the scrollbar.
  const onUserScrollRef = useRef(onUserScroll);
  onUserScrollRef.current = onUserScroll;
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const user = () => onUserScrollRef.current?.();
    const keys = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(e.key)) user();
    };
    // A press on the scroller itself (its scrollbar), not on a page or marker inside it.
    const press = (e: PointerEvent) => e.target === s && user();
    s.addEventListener("wheel", user, { passive: true });
    s.addEventListener("touchmove", user, { passive: true });
    s.addEventListener("pointerdown", press);
    window.addEventListener("keydown", keys);
    return () => {
      s.removeEventListener("wheel", user);
      s.removeEventListener("touchmove", user);
      s.removeEventListener("pointerdown", press);
      window.removeEventListener("keydown", keys);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToAnchor: (id, smooth = true, onSettle) => {
        const a = unit.anchors.find((x) => x.id === id);
        if (a) scrollTo(a.page, a.y, smooth, a.column);
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
        const sec = sectionStarts.find((x) => x.id === id);
        if (!sec) return;
        const a = preferAnchor ? unit.anchors.find((x) => x.id === preferAnchor) : undefined;
        const h = scroller.current ? viewH(scroller.current) : 800;
        if (a && avail && anchorTop(a) - yOf(sec.page, sec.y, sec.col) < h * 0.3 && anchorTop(a) >= yOf(sec.page, sec.y, sec.col)) scrollTo(a.page, a.y, smooth, a.column);
        else scrollTo(sec.page, sec.y, smooth, sec.col);
      },
      scrollToPoint: (i, f) => {
        const p = unit.pages[Math.min(unit.pages.length - 1, Math.max(0, i))];
        if (p) scrollTo(p.label, f, false);
      },
    }),
    [unit, scrollTo, yOf, avail, sectionStarts, anchorTop, viewH],
  );

  // Flash the highlight when asked ("show in text").
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!flashKey) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 1100);
    return () => clearTimeout(t);
  }, [flashKey]);

  // Markers by slice (fit column puts right-column paragraphs in the page's second slice).
  const bySlice = new Map<number, { m: Marker; i: number }[]>();
  markers.forEach((m, i) => {
    const k = sliceOf(m.anchor.page, m.anchor.column);
    const list = bySlice.get(k) ?? [];
    list.push({ m, i });
    bySlice.set(k, list);
  });
  const activeAnchor = markers[active]?.anchor;
  const activeSlice = activeAnchor ? sliceOf(activeAnchor.page, activeAnchor.column) : -1;
  const end = geo.length ? geo[geo.length - 1].top + geo[geo.length - 1].h : 0;
  const pageOf = useMemo(() => new Map(unit.pages.map((p) => [p.label, p])), [unit]);

  return (
    <div className="reader">
      <div className="reader-scroll" ref={scroller}>
        <div className="reader-column" style={{ width: colW + 2 * pad, height: end + bottomInset + box.h * 0.62 }}>
          {avail > 0 &&
            geo.map((g, gi) => {
              const p = pageOf.get(g.label)!;
              // Page x (0..1 of the full scan) → % of the visible box.
              const X = (x: number) => `${((x - g.left) / g.vis) * 100}%`;
              const Wd = (w: number) => `${(w / g.vis) * 100}%`;
              // In a slice, every marker sits left of the text (each column has its own left edge).
              const inGutter = (a: Anchor) => g.col === null && a.column === 1;
              return (
                <div
                  key={`${g.label}|${g.col ?? ""}`}
                  className={`page${g.col === 0 ? " col-first" : g.col === 1 ? " col-second" : ""}`}
                  style={{ top: g.top, left: pad + (colW - g.w) / 2, width: g.w, height: g.h }}
                >
                  <div className="page-clip skel">
                    <img
                      onLoad={(e) => e.currentTarget.parentElement?.classList.remove("skel")}
                      src={assetUrl(p.src)}
                      srcSet={p.srcset?.map((v) => `${assetUrl(v.src)} ${v.w}w`).join(", ")}
                      sizes={`${Math.round(g.fw)}px`}
                      alt={g.col === null ? `Page ${p.label}` : `Page ${p.label}, ${g.col === 0 ? "left" : "right"} column`}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      style={{ left: -g.left * g.fw, width: g.fw, height: g.h }}
                    />
                  </div>
                  {activeAnchor && activeSlice === gi && (
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
                  {(bySlice.get(gi) ?? []).map(({ m, i: mi }) => (
                    <button
                      key={m.anchor.id}
                      className={`marker${mi === active ? " active" : ""}`}
                      style={
                        inGutter(m.anchor)
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
