// `#/<book>/<unit>/<section>`: one unit open. Header, the contents drawer, the
// pages, and the demo pane on the right (a bottom sheet on phones).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Library, Unit } from "../types";
import { beatsInOrder, isNumbered, loadUnit, planFor } from "../lib/data";
import { hashFor } from "../lib/route";
import type { Target } from "../lib/search";
import { LAST_BOOK, RESUME, load, progressKey, save, useStored, type Progress } from "../lib/store";
import { Inline } from "../lib/inline";
import { Reader, textCrop, type Fit, type Marker, type ReaderHandle, type ReaderPosition } from "./Reader";
import { Contents } from "./Contents";
import { DemoPane, StepNav } from "../demo/DemoPane";
import { Brand } from "../ui/Brand";
import { HelpButton } from "../ui/Help";
import { ChevronDown, ChevronUp, ListIcon, Locate, Minus, PanelRight, Plus, Search, ZoomIcon } from "../ui/icons";

const ZOOMS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const MIN_PANE = 420;

function useNarrow() {
  const q = "(max-width: 899px)";
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Keys typed into a field belong to the field; buttons, sliders and checkboxes don't take letters. */
export const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return true;
  return el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type);
};

const sectionLabel = (s: { id: string; title: string }) => (isNumbered(s.id) ? `${s.id} ${s.title}` : s.title);

/** Fit page / fit text / fixed zoom, as one menu. */
function ZoomMenu({ fit, zoom, onPick, compact }: { fit: Fit; zoom: number; onPick: (fit: Fit, zoom: number) => void; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", off);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", off);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const label = zoom === 1 ? (fit === "text" ? "Fit text" : "Fit page") : `${Math.round(zoom * 100)}%`;
  const items: [string, Fit, number][] = [
    ["Fit page", "page", 1],
    ["Fit text", "text", 1],
    ["125%", fit, 1.25],
    ["150%", fit, 1.5],
    ["175%", fit, 1.75],
    ["200%", fit, 2],
  ];
  return (
    <div className="menu-wrap" ref={wrap}>
      {compact ? (
        <button className="btn icon ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} aria-label={`Zoom: ${label}`} title={`Zoom: ${label}`}>
          <ZoomIcon />
        </button>
      ) : (
        <button className="zoom-level" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Page size">
          {label}
        </button>
      )}
      {open && (
        <div className="menu" role="menu">
          {items.map(([l, f, z]) => {
            const on = l.startsWith("Fit") ? zoom === 1 && f === fit : zoom === z;
            return (
              <button
                key={l}
                role="menuitemradio"
                aria-checked={on}
                className={on ? "on" : undefined}
                onClick={() => {
                  onPick(f, z);
                  setOpen(false);
                }}
              >
                {l}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Props {
  library: Library;
  book: string;
  unit: string;
  /** Where to go once the unit is open; `seq` changes on every navigation. */
  target: { section?: string; anchor?: string; seq: number };
  onNavigate: (t: Target) => void;
  onSearch: () => void;
  help: boolean;
  onHelp: (open: boolean) => void;
  /** A modal (palette) is open: leave the keyboard alone. */
  modal: boolean;
}

export function BookView({ library, book: slug, unit: unitId, target, onNavigate, onSearch, help, onHelp, modal }: Props) {
  const book = library.books.find((b) => b.slug === slug)!;
  const unitInfo = book.units.find((u) => u.id === unitId)!;
  const narrow = useNarrow();

  const [unit, setUnit] = useState<Unit | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadUnit(slug, unitId)
      .then((u) => live && setUnit(u))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [slug, unitId]);

  // Preferences.
  const [tocOpen, setTocOpen] = useStored(narrow ? "yagami.contents.phone" : "yagami.contents", false);
  const [demoHidden, setDemoHidden] = useStored("yagami.demoHidden", false);
  const [demoW, setDemoW] = useStored<number | null>("yagami.demoWidth", null);
  const device = narrow ? "phone" : "wide";
  const [zoom, setZoom] = useStored(`yagami.zoom.${slug}.${device}`, 1);
  // Fit text by default where type would otherwise be small: phones, and scans with wide margins.
  const cropWidth = useMemo(() => (unit ? textCrop(unit).width : 1), [unit]);
  const [fitPref, setFit] = useStored<Fit | null>(`yagami.fit.${slug}.${device}`, null);
  const fit: Fit = fitPref ?? (narrow || cropWidth < 0.75 ? "text" : "page");
  const [focus, setFocus] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Demo state.
  const reader = useRef<ReaderHandle>(null);
  const [pos, setPos] = useState<ReaderPosition>({ active: 0, page: "", pageIndex: 0, pageFrac: 0, section: "", fraction: 0 });
  const [pinned, setPinned] = useState<number | null>(null);
  // While the pane is being resized the text reflows; keep the demo steady.
  const [frozen, setFrozen] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [flashKey, setFlashKey] = useState(0);

  const beats = useMemo(() => (unit ? beatsInOrder(planFor(`${slug}/${unitId}`), unit) : []), [unit, slug, unitId]);
  const markers = useMemo<Marker[]>(() => {
    const seen = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const b of beats) totals.set(b.demo.id, (totals.get(b.demo.id) ?? 0) + 1);
    return beats.map((b) => {
      const k = (seen.get(b.demo.id) ?? 0) + 1;
      seen.set(b.demo.id, k);
      return { anchor: b.anchor, label: `${b.demo.title.replace(/\$/g, "")} · step ${k} of ${totals.get(b.demo.id)}` };
    });
  }, [beats]);
  const hasDemos = beats.length > 0;
  const shown = Math.min(frozen ?? pinned ?? pos.active, Math.max(0, beats.length - 1));
  const current = beats[shown] ?? null;

  // Steps of the current demo, in reading order.
  const steps = useMemo(() => (current ? beats.map((b, i) => (b.demo.id === current.demo.id ? i : -1)).filter((i) => i >= 0) : []), [beats, current]);
  const stepIdx = steps.indexOf(shown);

  const goToBeat = useCallback(
    (i: number, smooth = true) => {
      const b = beats[i];
      if (!b) return;
      if (pinned !== null) setPinned(i);
      reader.current?.scrollToAnchor(b.anchor.id, smooth);
    },
    [beats, pinned],
  );

  // Next / previous step: within the current demo, then on into the neighbouring demo in the text.
  const neighbour = useCallback(
    (dir: 1 | -1): number | null => {
      if (!current) return null;
      const within = steps[stepIdx + dir];
      if (within !== undefined) return within;
      for (let i = shown + dir; i >= 0 && i < beats.length; i += dir) if (beats[i].demo.id !== current.demo.id) return i;
      return null;
    },
    [current, steps, stepIdx, shown, beats],
  );
  const step = (dir: 1 | -1) => {
    const n = neighbour(dir);
    if (n !== null) goToBeat(n);
  };

  // Arrive at the requested section / demo (or resume exactly where Continue left off).
  useEffect(() => {
    if (!unit) return;
    const resume = sessionStorage.getItem(RESUME) === slug;
    sessionStorage.removeItem(RESUME);
    const saved = load<Progress | null>(progressKey(slug), null);
    if (target.anchor) reader.current?.scrollToAnchor(target.anchor, false);
    else if (resume && saved?.unit === unitId && saved.pageIndex !== undefined) reader.current?.scrollToPoint(saved.pageIndex, saved.pageFrac ?? 0);
    else if (target.section) {
      // Prefer the section's first demo paragraph, so the demo shown is about text on screen.
      const first = beats.find((b) => b.anchor.section === target.section);
      reader.current?.scrollToSection(target.section, false, first?.anchor.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, target.seq]);

  // URL, title and progress follow the reading position.
  const section = unit?.sections.find((s) => s.id === pos.section) ?? unitInfo.sections.find((s) => s.id === pos.section);
  useEffect(() => {
    if (!unit || !pos.section) return;
    history.replaceState(null, "", hashFor({ book: slug, unit: unitId, section: pos.section }));
    save(LAST_BOOK, slug);
    save(progressKey(slug), {
      unit: unitId,
      section: pos.section,
      page: pos.page,
      pageIndex: pos.pageIndex,
      pageFrac: pos.pageFrac,
      pages: unit.pages.length,
      fraction: pos.fraction,
    } satisfies Progress);
  }, [unit, slug, unitId, pos]);
  useEffect(() => {
    document.title = [section && section.title, book.short, "yagami"].filter(Boolean).join(" · ");
  }, [section, book.short]);

  const zoomBy = useCallback(
    (dir: 1 | -1) =>
      setZoom((z) => {
        const i = ZOOMS.findIndex((v) => v >= z - 1e-6);
        return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))];
      }),
    [setZoom],
  );

  const showInText = useCallback(() => {
    if (!current) return;
    if (focus) setFocus(false);
    if (narrow) setSheetOpen(false);
    reader.current?.scrollToAnchor(current.anchor.id, true);
    setFlashKey((k) => k + 1);
  }, [current, focus, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modal || help || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key;
      if (k === "Escape") {
        if (focus) setFocus(false);
        else if (tocOpen) setTocOpen(false);
        else if (narrow && sheetOpen) setSheetOpen(false);
        return;
      }
      const onControl = (e.target as HTMLElement).closest?.("button, input, select, a");
      if (k === "t") setTocOpen((v) => !v);
      else if (k === "+" || k === "=") zoomBy(1);
      else if (k === "-" || k === "_") zoomBy(-1);
      else if (k === "0") {
        setZoom(1);
      } else if (!hasDemos) return;
      else if (k === "j") step(1);
      else if (k === "k") step(-1);
      else if (k === "h") setPinned((p) => (p === null ? shown : null));
      else if (k === "r") setResetKey((x) => x + 1);
      else if (k === "f") {
        setDemoHidden(false);
        setFocus((v) => !v);
      } else if (k === "d") {
        setFocus(false);
        setDemoHidden((v) => !v);
      } else if (k === " " && !onControl) {
        // Space on a focused button or checkbox presses it; elsewhere it plays / pauses.
        e.preventDefault();
        setPlaying((p) => !p);
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Drag to resize the demo pane (between MIN_PANE and 55% of the window).
  const maxPane = () => Math.max(MIN_PANE, Math.round(window.innerWidth * 0.55));
  const defaultW = () => Math.round(Math.min(maxPane(), Math.max(MIN_PANE, window.innerWidth * 0.42)));
  const width = Math.min(maxPane(), Math.max(MIN_PANE, demoW ?? defaultW()));
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    setFrozen(shown);
    const move = (ev: PointerEvent) => setDemoW(Math.round(Math.min(maxPane(), Math.max(MIN_PANE, window.innerWidth - ev.clientX))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      // Let the text settle at its new width before following it again.
      requestAnimationFrame(() => requestAnimationFrame(() => setFrozen(null)));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const pageText = (() => {
    if (!unit || !pos.page) return "";
    const n = unit.pages.length;
    return pos.page === String(pos.pageIndex + 1) ? `p. ${pos.page} / ${n}` : `p. ${pos.page} · ${pos.pageIndex + 1}/${n}`;
  })();

  const prevStep = neighbour(-1);
  const nextStep = neighbour(1);
  const paneProps = current
    ? {
        unitKey: `${slug}/${unitId}`,
        beat: current,
        playing,
        resetKey,
        onTogglePlay: () => setPlaying((p) => !p),
        onRestart: () => setResetKey((x) => x + 1),
        step: {
          index: stepIdx,
          total: steps.length,
          onPrev: prevStep !== null ? () => goToBeat(prevStep) : undefined,
          onNext: nextStep !== null ? () => goToBeat(nextStep) : undefined,
        },
        onShowInText: showInText,
        pinned: pinned !== null,
        onTogglePin: () => setPinned((p) => (p === null ? shown : null)),
        focused: focus,
        onToggleFocus: () => setFocus((v) => !v),
      }
    : null;

  const showDock = hasDemos && !demoHidden;
  const pickZoom = (f: Fit, z: number) => {
    setFit(f);
    setZoom(z);
  };

  const chapterSelect = book.units.length > 1 && (
    <select className="select plain chapter-select" aria-label="Chapter" value={unitId} onChange={(e) => onNavigate({ book: slug, unit: e.target.value })}>
      {book.units.map((u) => (
        <option key={u.id} value={u.id}>
          {isNumbered(u.id) ? `${u.id}. ${u.title}` : u.title}
        </option>
      ))}
    </select>
  );

  // Phone sheet: drag the bar up to open, down to close.
  const drag = useRef<{ y: number; moved: boolean } | null>(null);

  return (
    <div className="app">
      <header className="topbar">
        <Brand wordmark={!narrow} />
        <span className="topbar-sep" aria-hidden />
        <button className="btn icon ghost" aria-pressed={tocOpen} onClick={() => setTocOpen((v) => !v)} aria-label="Contents" title="Contents (t)">
          <ListIcon />
        </button>
        <select className="select plain book-select" aria-label="Book" value={slug} onChange={(e) => onNavigate({ book: e.target.value })} title={book.title}>
          {library.books.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.short}
            </option>
          ))}
        </select>
        {!narrow && chapterSelect}
        {!narrow && section && (
          <button className="crumb" onClick={() => setTocOpen((v) => !v)} title="Contents (t)">
            <Inline md={sectionLabel(section)} />
          </button>
        )}
        <span className="spacer" />
        {!narrow && pageText && <span className="page-indicator">{pageText}</span>}
        {narrow ? (
          <ZoomMenu fit={fit} zoom={zoom} onPick={pickZoom} compact />
        ) : (
          <div className="zoom" role="group" aria-label="Page size">
            <button className="btn icon ghost" onClick={() => zoomBy(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out" title="Zoom out (−)">
              <Minus />
            </button>
            <ZoomMenu fit={fit} zoom={zoom} onPick={pickZoom} compact={false} />
            <button className="btn icon ghost" onClick={() => zoomBy(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in" title="Zoom in (+)">
              <Plus />
            </button>
          </div>
        )}
        <button className={`btn search-btn${narrow ? " icon ghost" : ""}`} onClick={onSearch} aria-label="Search" title="Search (⌘K)">
          <Search />
          {!narrow && <span className="search-label">Search</span>}
          {!narrow && <kbd>⌘K</kbd>}
        </button>
        {!narrow && hasDemos && (
          <button
            className="btn icon ghost"
            aria-pressed={!demoHidden}
            onClick={() => {
              setFocus(false);
              setDemoHidden((v) => !v);
            }}
            aria-label={demoHidden ? "Show demos" : "Hide demos"}
            title={demoHidden ? "Show demos (d)" : "Hide demos (d)"}
          >
            <PanelRight />
          </button>
        )}
        <HelpButton open={help} onOpenChange={onHelp} />
      </header>
      {narrow && (
        <div className="subbar">
          {chapterSelect}
          <button className="subbar-section" onClick={() => setTocOpen(true)} aria-label="Open contents">
            {section && <Inline md={sectionLabel(section)} />}
          </button>
          <span className="subbar-page">{pageText}</span>
        </div>
      )}

      <div className={`book-body${focus && showDock && !narrow ? " focus" : ""}${narrow ? " narrow" : ""}`}>
        {tocOpen && (
          <>
            <div className="scrim" onClick={() => setTocOpen(false)} />
            <Contents
              title={book.units.length > 1 ? `${isNumbered(unitId) ? `${unitId}. ` : ""}${unitInfo.title}` : book.short}
              unitKey={`${slug}/${unitId}`}
              unit={unit}
              sections={unit?.sections ?? unitInfo.sections}
              current={pos.section}
              activeDemo={current?.demo.id}
              onSection={(id) => {
                const first = beats.find((b) => b.anchor.section === id);
                reader.current?.scrollToSection(id, false, first?.anchor.id);
                setTocOpen(false);
              }}
              onDemo={(anchor) => {
                reader.current?.scrollToAnchor(anchor, false);
                setPinned(null);
                setTocOpen(false);
              }}
              onClose={() => setTocOpen(false)}
            />
          </>
        )}

        {unit ? (
          <Reader
            ref={reader}
            unit={unit}
            markers={markers}
            active={hasDemos ? shown : -1}
            zoom={zoom}
            fit={fit}
            flashKey={flashKey}
            bottomInset={narrow && showDock ? 72 : 0}
            onPosition={setPos}
            onMarker={(i) => {
              goToBeat(i);
              if (narrow) setSheetOpen(true);
            }}
          />
        ) : (
          <div className="reader">{error && <p className="quiet">{error}</p>}</div>
        )}

        {showDock && paneProps && !narrow && (
          <aside className="demo-dock" style={{ width }} aria-label="Demo">
            {!focus && (
              <div
                className="resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize demo pane"
                title="Drag to resize · double-click to reset"
                onPointerDown={onResizeStart}
                onDoubleClick={() => setDemoW(null)}
              />
            )}
            <DemoPane {...paneProps} />
          </aside>
        )}

        {showDock && paneProps && narrow && (
          <aside className={`sheet${sheetOpen ? " open" : ""}`} aria-label="Demo">
            <div
              className="sheet-bar"
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest(".step-nav, .sheet-bar > .btn")) return;
                const d = { y: e.clientY, moved: false };
                drag.current = d;
                const move = (ev: PointerEvent) => {
                  const dy = ev.clientY - d.y;
                  if (!d.moved && Math.abs(dy) > 40) {
                    d.moved = true;
                    setSheetOpen(dy < 0);
                  }
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  // The click that follows a drag must not toggle the sheet back.
                  setTimeout(() => (drag.current = null), 0);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            >
              <span className="sheet-grip" aria-hidden />
              <button
                className="sheet-toggle"
                onClick={() => {
                  if (!drag.current?.moved) setSheetOpen((v) => !v);
                }}
                aria-expanded={sheetOpen}
              >
                <span className="sheet-text">
                  <span className="demo-title">
                    <Inline md={paneProps.beat.demo.title} />
                  </span>
                  {!sheetOpen && (
                    <span className="sheet-caption">
                      <Inline md={paneProps.beat.beat.caption} />
                    </span>
                  )}
                </span>
                <span className="sheet-chevron">{sheetOpen ? <ChevronDown /> : <ChevronUp />}</span>
              </button>
              {sheetOpen && paneProps.step.total > 1 && <StepNav step={paneProps.step} />}
              {sheetOpen && (
                <button className="btn icon ghost" onClick={showInText} aria-label="Show in text" title="Show this paragraph in the text">
                  <Locate />
                </button>
              )}
            </div>
            {sheetOpen && <DemoPane {...paneProps} bare />}
          </aside>
        )}
      </div>
    </div>
  );
}
