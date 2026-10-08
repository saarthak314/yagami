// `#/`: the library. Continue where you left off, then every book with its chapters.

import { useEffect, useState } from "react";
import type { Library } from "../types";
import { ApiError, continueBook, forgetJob, isTouch, type Health, type JobSummary } from "../lib/api";
import { assetUrl, isNumbered, loadUnit, planFor, useDemosVersion } from "../lib/data";
import { LAST_BOOK, RESUME, load, progressKey, type Progress } from "../lib/store";
import { buildHash, hashFor } from "../lib/route";
import { Uploader } from "./Uploader";
import { Inline } from "../lib/inline";
import { Check, Copy } from "../ui/icons";
import { Mark } from "../ui/Brand";

const demoCount = (book: string, unit: string) => planFor(`${book}/${unit}`)?.demos.length ?? 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A chapter's title without the number the list already shows ("20. Random Walks" → "Random Walks"). */
const chapterTitle = (u: { id: string; title: string }) => {
  if (!isNumbered(u.id) || !u.title.startsWith(u.id)) return u.title;
  const rest = u.title.slice(u.id.length).match(/^[.:]?\s+(.+)$/);
  return rest ? rest[1] : u.title;
};

/** First page image of a book's first built unit, for the thumbnail. */
function useCover(book: string, unit: string | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!unit) return;
    let live = true;
    loadUnit(book, unit)
      .then((u) => live && u.pages[0] && setSrc(assetUrl(u.pages[0].src)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [book, unit]);
  return src;
}

function Cover({ book, unit }: { book: string; unit?: string }) {
  const src = useCover(book, unit);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`cover${loaded ? "" : " skel"}`}>
      {src && <img src={src} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} />}
    </div>
  );
}

const progressWidth = (job: JobSummary) => `${job.total ? Math.max(4, Math.round((job.ready / job.total) * 100)) : job.pagesReady ? 8 : 3}%`;
const buildingWhat = (job: JobSummary) => (!job.pagesReady ? "reading pages" : job.total === 0 ? "planning demos" : `${job.ready}/${job.total} ready`);

/** "building · 3/6 ready" with a thin bar under a book that's being added to; links to the progress view. */
function BuildingMeta({ job }: { job: JobSummary }) {
  return (
    <a className="book-building" href={buildHash(job.job)}>
      <span className="building-text">
        <span className="building-dot" aria-hidden />
        building · {buildingWhat(job)}
      </span>
      <span className="progress small" aria-hidden>
        <span style={{ width: progressWidth(job) }} />
      </span>
    </a>
  );
}

/** A book that exists only as a build so far: running, stopped or failed. */
function PendingRow({ job }: { job: JobSummary }) {
  const running = job.status === "running";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? (/no book/.test(e.message) ? "nothing was built yet — add the same pdf again" : e.message) : "something went wrong");
      setBusy(false);
    }
  };
  return (
    <li className={`book-row pending ${job.status}`}>
      <a className="book-link" href={buildHash(job.job)}>
        <div className="cover placeholder" />
        <div className="book-text">
          <span className="book-title">{job.title || "new book"}</span>
          {running ? (
            <>
              <span className="book-meta building-meta">
                <span className="building-dot" aria-hidden />
                building · {buildingWhat(job)}
              </span>
              <span className="progress small" aria-hidden>
                <span style={{ width: progressWidth(job) }} />
              </span>
            </>
          ) : (
            <span className="book-meta">
              <span className={`tag ${job.status}`}>{job.status}</span>
              {" · "}
              {job.status === "failed" ? "open it to see why" : job.total ? `${job.ready} of ${job.total} demos made` : "nothing made yet"}
            </span>
          )}
        </div>
      </a>
      {!running && (
        <div className="row-actions">
          <button className="btn small" disabled={busy} onClick={() => act(async () => (location.hash = buildHash((await continueBook(job.slug)).job)))}>
            {job.status === "stopped" ? "resume" : "retry"}
          </button>
          <button
            className="btn ghost small"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await forgetJob(job.job);
                window.dispatchEvent(new Event("yagami:jobs"));
              })
            }
          >
            remove
          </button>
          {error && <span className="row-error">{error}</span>}
        </div>
      )}
    </li>
  );
}

function Continue({ library }: { library: Library }) {
  const slug = load<string | null>(LAST_BOOK, null);
  const book = library.books.find((b) => b.slug === slug);
  const p = book ? load<Progress | null>(progressKey(book.slug), null) : null;
  const unit = book?.units.find((u) => u.id === p?.unit);
  if (!book || !p || !unit) return null;
  const section = unit.sections.find((s) => s.id === p.section);
  const where = [book.units.length > 1 ? (isNumbered(unit.id) ? `${unit.id}. ${chapterTitle(unit)}` : unit.title) : null, section && (isNumbered(section.id) ? `${section.id} ${section.title}` : section.title)]
    .filter(Boolean)
    .join(" · ");
  const pageOf = p.pages && p.pageIndex !== undefined ? `p. ${p.page} of ${p.page === String(p.pageIndex + 1) ? p.pages : `${p.pages} pages`}` : "";
  return (
    <a className="continue" href={hashFor({ book: book.slug, unit: unit.id, section: p.section })} onClick={() => sessionStorage.setItem(RESUME, book.slug)}>
      <span className="continue-label">continue reading</span>
      <span className="continue-title">{book.title}</span>
      <span className="continue-where">
        {where}
        {where && pageOf && " · "}
        {pageOf && <span className="continue-page">{pageOf}</span>}
      </span>
      <span className="progress" aria-label={`${Math.round(p.fraction * 100)}% through`}>
        <span style={{ width: `${Math.max(2, Math.round(p.fraction * 100))}%` }} />
      </span>
    </a>
  );
}

const REPO = "https://github.com/saarthak314/yagami";

function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>© {new Date().getFullYear()} Sarthak Tomar</span>
      <a href={REPO} target="_blank" rel="noreferrer">
        source
      </a>
      <span className="site-footer-note">books and papers belong to their authors and publishers.</span>
    </footer>
  );
}

function AddHint({ label = "add a book" }: { label?: string }) {
  const cmd = "yagami <file.pdf>";
  const [copied, setCopied] = useState(false);
  return (
    <div className="add-hint">
      {label && <span>{label}</span>}
      <code>{cmd}</code>
      <button
        className="btn icon ghost"
        aria-label="copy command"
        title="copy"
        onClick={() => {
          navigator.clipboard?.writeText(cmd).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => {},
          );
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

export function LibraryView({ library, notFound, health, jobs = [] }: { library: Library; notFound?: string; health?: Health | null; jobs?: JobSummary[] }) {
  useEffect(() => {
    document.title = "yagami";
  }, []);
  useDemosVersion();
  const books = library.books;
  const demos = books.reduce((n, b) => n + b.units.reduce((m, u) => m + demoCount(b.slug, u.id), 0), 0);
  // The build server is there (local `yagami`): books can be added from the page.
  const canUpload = !!health;
  const touch = isTouch();
  const running = new Map(jobs.filter((j) => j.kind === "build" && j.status === "running").map((j) => [j.slug, j]));
  const inLibrary = new Set(books.map((b) => b.slug));
  // Builds whose book isn't readable yet; the newest per book.
  const pending = jobs.filter((j, i) => j.kind === "build" && !inLibrary.has(j.slug) && jobs.findIndex((x) => x.slug === j.slug) === i && (j.status === "running" || j.status === "stopped" || j.status === "failed"));
  const pendingList = pending.length > 0 && (
    <ul className="books">
      {pending.map((j) => (
        <PendingRow key={j.job} job={j} />
      ))}
    </ul>
  );

  if (books.length === 0) {
    return (
      <main className="library library-empty">
        <div className="empty">
          <div className="empty-brand">
            <Mark size={24} />
            <span className="wordmark">yagami</span>
          </div>
          {canUpload ? (
            <>
              <p>your library is empty.</p>
              <div className="empty-add">
                <Uploader health={health} prominent />
                {pendingList}
              </div>
              {!touch && <AddHint label="or from a terminal" />}
            </>
          ) : (
            <>
              <p>your library is empty. turn a paper or a textbook into a book with</p>
              <AddHint label="" />
            </>
          )}
        </div>
        <SiteFooter />
      </main>
    );
  }

  return (
    <main className="library">
      <div className="library-inner">
        {notFound && <p className="not-found">nothing at {decodeURIComponent(notFound)}. here is the library.</p>}
        <Continue library={library} />

        <div className="library-head">
          <h1>library</h1>
          <span className="muted">
            {plural(books.length, "book")} · {plural(demos, "demo")}
          </span>
        </div>

        {canUpload && <Uploader health={health} />}

        <ul className="books">
          {pending.map((j) => (
            <PendingRow key={j.job} job={j} />
          ))}
          {books.map((b) => {
            // A book (chapters, even just one built so far) or a paper (one unit, "paper").
            const multi = b.units.length > 1 || (b.units.length === 1 && b.units[0].id !== "paper");
            const n = b.units.reduce((m, u) => m + demoCount(b.slug, u.id), 0);
            return (
              <li key={b.slug} className="book-row">
                <a className="book-link" href={hashFor({ book: b.slug })}>
                  <Cover book={b.slug} unit={b.units[0]?.id} />
                  <div className="book-text">
                    <span className="book-title">{b.title}</span>
                    {b.subtitle && !b.title.includes(b.subtitle) && <span className="book-sub">{b.subtitle}</span>}
                    <span className="book-meta">
                      {multi ? plural(b.units.length, "chapter") : "paper"} · {plural(n, "demo")}
                    </span>
                  </div>
                </a>
                {running.has(b.slug) && <BuildingMeta job={running.get(b.slug)!} />}
                {multi && (
                  <ul className="chapters">
                    {b.units.map((u) => (
                      <li key={u.id}>
                        <a href={hashFor({ book: b.slug, unit: u.id })}>
                          <span className="chapter-num">{isNumbered(u.id) ? u.id : ""}</span>
                          <span className="chapter-title">
                            <Inline md={chapterTitle(u)} />
                          </span>
                          <span className="chapter-demos">{plural(demoCount(b.slug, u.id), "demo")}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {canUpload ? !touch && <AddHint label="or from a terminal" /> : <AddHint />}
        <SiteFooter />
      </div>
    </main>
  );
}
