// Routes: `#/` the library, `#/<book>/<unit>/<section>` a book, `#/build/<job>` a
// build. The command palette (⌘K or /) and the help panel (?) work everywhere.

import { useCallback, useEffect, useRef, useState } from "react";
import { health as fetchHealth, type Health } from "./lib/api";
import { useJobs } from "./lib/job";
import { BuildView } from "./build/BuildView";
import type { Library } from "./types";
import { loadLibrary } from "./lib/data";
import { hashFor, parseHash, type Route } from "./lib/route";
import type { Target } from "./lib/search";
import { load, progressKey, type Progress } from "./lib/store";
import { LibraryView } from "./library/Library";
import { BookView } from "./reader/BookView";
import { Palette } from "./ui/Palette";
import { Brand } from "./ui/Brand";
import { HelpButton } from "./ui/Help";
import { ThemeMenu } from "./ui/ThemeMenu";
import { Search } from "./ui/icons";

/** Which unit and where in it a route opens: the URL first, then saved progress, then the start. */
function resolve(lib: Library, r: Route) {
  const book = lib.books.find((b) => b.slug === r.book);
  if (!book || book.units.length === 0) return null;
  const saved = load<Progress | null>(progressKey(book.slug), null);
  const unit = book.units.find((u) => u.id === r.unit) ?? book.units.find((u) => u.id === saved?.unit) ?? book.units[0];
  const section = r.section ?? (saved?.unit === unit.id ? saved.section : undefined);
  return { book: book.slug, unit: unit.id, section };
}

export function App() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route & { anchor?: string; seq: number }>(() => ({ ...parseHash(), seq: 0 }));
  const [palette, setPaletteState] = useState(false);
  // Focus goes back to whatever opened the palette when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const setPalette = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setPaletteState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next && !prev) opener.current = document.activeElement as HTMLElement | null;
      if (!next && prev) requestAnimationFrame(() => opener.current?.focus?.({ preventScroll: true }));
      return next;
    });
  }, []);
  const [help, setHelp] = useState(false);

  // A file dropped where nothing accepts it must not make the browser open it (and leave yagami).
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);
  // Anchor for the next hashchange (demos have no URL of their own).
  const nextAnchor = useRef<string | undefined>(undefined);

  useEffect(() => {
    loadLibrary()
      .then(setLibrary)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  // The local build server (absent on a static export: no uploads then).
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);
  const jobs = useJobs(!!health);
  // A build adds books and pages as it goes: reload the index when that changes.
  const jobsKey = jobs.map((j) => `${j.slug}:${j.pagesReady}:${j.status}:${j.ready}:${j.total}`).join("|");
  const firstJobs = useRef(true);
  useEffect(() => {
    if (firstJobs.current) {
      firstJobs.current = false;
      return;
    }
    void loadLibrary().then((lib) => setLibrary((prev) => (prev && JSON.stringify(prev) === JSON.stringify(lib) ? prev : lib)));
  }, [jobsKey]);

  useEffect(() => {
    const on = () => {
      const anchor = nextAnchor.current;
      nextAnchor.current = undefined;
      setRoute((r) => ({ ...parseHash(), anchor, seq: r.seq + 1 }));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const navigate = useCallback((t: Target) => {
    setPalette(false);
    const h = hashFor(t);
    if (location.hash === h) setRoute((r) => ({ ...parseHash(h), anchor: t.anchor, seq: r.seq + 1 }));
    else {
      nextAnchor.current = t.anchor;
      location.hash = h;
    }
  }, [setPalette]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHelp(false);
        setPalette((v) => !v);
      } else if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      else if (e.key === "/") {
        e.preventDefault();
        setHelp(false);
        setPalette(true);
      } else if (e.key === "?") setHelp((v) => !v);
      else if (e.key === "Escape") setHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  if (!library) {
    return (
      <div className="app">
        <header className="topbar">
          <Brand />
        </header>
        {error ? (
          <p className="quiet">{error}</p>
        ) : (
          <main className="library" aria-busy>
            <div className="library-inner skel-library" aria-hidden>
              <span className="skel skel-heading" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="skel-book">
                  <span className="skel skel-cover" />
                  <span className="skel-lines">
                    <span className="skel skel-line" style={{ width: `${60 - i * 8}%` }} />
                    <span className="skel skel-line short" />
                  </span>
                </div>
              ))}
            </div>
          </main>
        )}
      </div>
    );
  }

  const at = route.book ? resolve(library, route) : null;
  const libraryTopbar = (
    <header className="topbar">
      <Brand />
      <span className="spacer" />
      <button className="btn search-btn" onClick={() => setPalette(true)} aria-label="Search" title="search (⌘k)">
        <Search />
        <span className="search-label">search</span>
        <kbd>⌘K</kbd>
      </button>
      <ThemeMenu />
      <HelpButton open={help} onOpenChange={setHelp} context="library" />
    </header>
  );
  const anchor = route.anchor;

  return (
    <>
      {at ? (
        <BookView
          key={`${at.book}/${at.unit}`}
          library={library}
          book={at.book}
          unit={at.unit}
          target={{ section: anchor ? undefined : at.section, anchor, seq: route.seq }}
          onNavigate={navigate}
          onSearch={() => setPalette(true)}
          help={help}
          onHelp={setHelp}
          modal={palette}
        />
      ) : route.job ? (
        <div className="app">
          {libraryTopbar}
          <BuildView key={route.job} job={route.job} library={library} jobs={jobs} health={health} />
        </div>
      ) : (
        <div className="app">
          {libraryTopbar}
          <LibraryView library={library} notFound={route.book ? location.hash : undefined} health={health} jobs={jobs} />
        </div>
      )}
      {palette && <Palette library={library} near={at ?? undefined} onGo={navigate} onClose={() => setPalette(false)} />}
    </>
  );
}
