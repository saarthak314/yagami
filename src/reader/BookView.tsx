// `#/<book>/<unit>/<section>`: one unit open. Header, optional contents on the
// left, the pages, and the demo pane on the right (a bottom sheet on phones).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Library, Unit } from "../types";
import { beatsInOrder, isNumbered, loadUnit, planFor } from "../lib/data";
import { hashFor } from "../lib/route";
import type { Target } from "../lib/search";
import { LAST_BOOK, progressKey, save, useStored } from "../lib/store";
import { Inline } from "../lib/inline";
import { Reader, type Marker, type ReaderHandle, type ReaderPosition } from "./Reader";
import { Contents } from "./Contents";
import { DemoPane, StepNav } from "../demo/DemoPane";
import { Brand } from "../ui/Brand";
import { HelpButton } from "../ui/Help";
import { ChevronDown, ChevronUp, ListIcon, Locate, Minus, PanelRight, Plus, Search } from "../ui/icons";

const ZOOMS = [0.75, 1, 1.25, 1.5, 1.75, 2];
/** Phones cycle through fewer, larger steps from one button. */
const PHONE_ZOOMS = [1, 1.5, 2];

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

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

const sectionLabel = (s: { id: string; title: string }) => (isNumbered(s.id) ? `${s.id} ${s.title}` : s.title);

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
  const [tocOpenWide, setTocOpenWide] = useStored("yagami.contents", false);
  const [tocOpenNarrow, setTocOpenNarrow] = useState(false);
  const tocOpen = narrow ? tocOpenNarrow : tocOpenWide;
  const setTocOpen = narrow ? setTocOpenNarrow : setTocOpenWide;
  const [demoHidden, setDemoHidden] = useStored("yagami.demoHidden", false);
  const [demoW, setDemoW] = useStored<number | null>("yagami.demoWidth", null);
  const [zoom, setZoom] = useStored(`yagami.zoom.${slug}`, 1);
  const [phoneZoom, setPhoneZoom] = useStored(`yagami.zoom.${slug}.phone`, 1);
  const [focus, setFocus] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Demo state.
  const reader = useRef<ReaderHandle>(null);
  const [pos, setPos] = useState<ReaderPosition>({ active: 0, page: "", pageIndex: 0, section: "", fraction: 0 });
  const [pinned, setPinned] = useState<number | null>(null);
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
  const shown = Math.min(pinned ?? pos.active, Math.max(0, beats.length - 1));
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

  // Arrive at the requested section / demo.
  useEffect(() => {
    if (!unit) return;
    if (target.anchor) reader.current?.scrollToAnchor(target.anchor, false);
    else if (target.section) reader.current?.scrollToSection(target.section, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, target.seq]);

  // URL, title and progress follow the reading position.
  const section = unit?.sections.find((s) => s.id === pos.section) ?? unitInfo.sections.find((s) => s.id === pos.section);
  useEffect(() => {
    if (!unit || !pos.section) return;
    history.replaceState(null, "", hashFor({ book: slug, unit: unitId, section: pos.section }));
    save(LAST_BOOK, slug);
    save(progressKey(slug), { unit: unitId, section: pos.section, page: pos.page, fraction: pos.fraction });
  }, [unit, slug, unitId, pos.section, pos.page, pos.fraction]);
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
        else if (narrow && tocOpen) setTocOpen(false);
        else if (narrow && sheetOpen) setSheetOpen(false);
        return;
      }
      if (k === "t") setTocOpen((v) => !v);
      else if (k === "+" || k === "=") zoomBy(1);
      else if (k === "-" || k === "_") zoomBy(-1);
      else if (k === "0") setZoom(1);
      else if (!hasDemos) return;
      else if (k === "j") goToBeat(shown + 1);
      else if (k === "k") goToBeat(shown - 1);
      else if (k === "h") setPinned((p) => (p === null ? shown : null));
      else if (k === "r") setResetKey((x) => x + 1);
      else if (k === "f") {
        setDemoHidden(false);
        setFocus((v) => !v);
      } else if (k === "d") {
        setFocus(false);
        setDemoHidden((v) => !v);
      } else if (k === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, help, focus, narrow, tocOpen, sheetOpen, hasDemos, shown, goToBeat, zoomBy, setZoom, setTocOpen, setDemoHidden]);

  // Drag to resize the demo pane.
  const defaultW = () => Math.round(Math.min(760, Math.max(380, window.innerWidth * 0.42)));
  const width = demoW ?? defaultW();
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const max = Math.min(window.innerWidth * 0.7, window.innerWidth - 420);
      setDemoW(Math.round(Math.min(max, Math.max(340, window.innerWidth - ev.clientX))));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const pageText = (() => {
    if (!unit || !pos.page) return "";
    const n = unit.pages.length;
    return pos.page === String(pos.pageIndex + 1) ? `p. ${pos.page} / ${n}` : `p. ${pos.page} · ${pos.pageIndex + 1}/${n}`;
  })();

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
          onPrev: stepIdx > 0 ? () => goToBeat(steps[stepIdx - 1]) : undefined,
          onNext: stepIdx >= 0 && stepIdx < steps.length - 1 ? () => goToBeat(steps[stepIdx + 1]) : undefined,
        },
        onShowInText: showInText,
        pinned: pinned !== null,
        onTogglePin: () => setPinned((p) => (p === null ? shown : null)),
        focused: focus,
        onToggleFocus: () => setFocus((v) => !v),
      }
    : null;

  const showDock = hasDemos && !demoHidden;

  return (
    <div className="app">
      <header className="topbar">
        <Brand wordmark={!narrow} />
        <span className="topbar-sep" aria-hidden />
        <button className="btn icon ghost" aria-pressed={tocOpen} onClick={() => setTocOpen((v) => !v)} aria-label="Contents" title="Contents (t)">
          <ListIcon />
        </button>
        <select
          className="select plain book-select"
          aria-label="Book"
          value={slug}
          onChange={(e) => onNavigate({ book: e.target.value })}
          title={book.title}
        >
          {library.books.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.short}
            </option>
          ))}
        </select>
        {book.units.length > 1 && (
          <select className="select plain chapter-select" aria-label="Chapter" value={unitId} onChange={(e) => onNavigate({ book: slug, unit: e.target.value })}>
            {book.units.map((u) => (
              <option key={u.id} value={u.id}>
                {isNumbered(u.id) ? `${u.id}. ${u.title}` : u.title}
              </option>
            ))}
          </select>
        )}
        {!narrow && section && (
          <button className="crumb" onClick={() => setTocOpen((v) => !v)} title="Contents (t)">
            <Inline md={sectionLabel(section)} />
          </button>
        )}
        <span className="spacer" />
        {!narrow && pageText && <span className="page-indicator">{pageText}</span>}
        {!narrow && (
          <div className="zoom" role="group" aria-label="Zoom">
            <button className="btn icon ghost" onClick={() => zoomBy(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out" title="Zoom out (−)">
              <Minus />
            </button>
            <button className="zoom-level" onClick={() => setZoom(1)} title="Fit width (0)">
              {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <button className="btn icon ghost" onClick={() => zoomBy(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in" title="Zoom in (+)">
              <Plus />
            </button>
          </div>
        )}
        {narrow && (
          <button
            className="btn ghost zoom-cycle"
            onClick={() => setPhoneZoom((z) => PHONE_ZOOMS[(PHONE_ZOOMS.indexOf(z) + 1) % PHONE_ZOOMS.length] ?? 1)}
            aria-label="Zoom pages"
            title="Zoom pages"
          >
            {phoneZoom === 1 ? "Fit" : `${Math.round(phoneZoom * 100)}%`}
          </button>
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

      <div className={`book-body${focus && showDock && !narrow ? " focus" : ""}${narrow ? " narrow" : ""}`}>
        {tocOpen && (
          <>
            {narrow && <div className="scrim" onClick={() => setTocOpen(false)} />}
            <Contents
              title={book.units.length > 1 ? `${isNumbered(unitId) ? `${unitId}. ` : ""}${unitInfo.title}` : book.short}
              sections={unit?.sections ?? unitInfo.sections}
              beats={beats}
              current={pos.section}
              activeDemo={current?.demo.id}
              onSection={(id) => {
                reader.current?.scrollToSection(id, false);
                if (narrow) setTocOpen(false);
              }}
              onDemo={(anchor) => {
                reader.current?.scrollToAnchor(anchor, false);
                setPinned(null);
                if (narrow) setTocOpen(false);
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
            zoom={narrow ? phoneZoom : zoom}
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
            <div className="sheet-bar">
              <button className="sheet-toggle" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}>
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
