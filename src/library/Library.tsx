// `#/`: the library. Continue where you left off, then every book with its chapters.

import { useEffect, useState } from "react";
import type { Library } from "../types";
import { assetUrl, isNumbered, loadUnit, planFor } from "../lib/data";
import { LAST_BOOK, RESUME, load, progressKey, type Progress } from "../lib/store";
import { hashFor } from "../lib/route";
import { Inline } from "../lib/inline";
import { Check, Copy } from "../ui/icons";
import { Mark } from "../ui/Brand";

const demoCount = (book: string, unit: string) => planFor(`${book}/${unit}`)?.demos.length ?? 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  return <div className="cover">{src && <img src={src} alt="" loading="lazy" decoding="async" />}</div>;
}

function Continue({ library }: { library: Library }) {
  const slug = load<string | null>(LAST_BOOK, null);
  const book = library.books.find((b) => b.slug === slug);
  const p = book ? load<Progress | null>(progressKey(book.slug), null) : null;
  const unit = book?.units.find((u) => u.id === p?.unit);
  if (!book || !p || !unit) return null;
  const section = unit.sections.find((s) => s.id === p.section);
  const where = [book.units.length > 1 ? (isNumbered(unit.id) ? `${unit.id}. ${unit.title}` : unit.title) : null, section && (isNumbered(section.id) ? `${section.id} ${section.title}` : section.title)]
    .filter(Boolean)
    .join(" · ");
  const pageOf = p.pages && p.pageIndex !== undefined ? `p. ${p.page} of ${p.page === String(p.pageIndex + 1) ? p.pages : `${p.pages} pages`}` : "";
  return (
    <a className="continue" href={hashFor({ book: book.slug, unit: unit.id, section: p.section })} onClick={() => sessionStorage.setItem(RESUME, book.slug)}>
      <span className="continue-label">Continue reading</span>
      <span className="continue-title">{book.title}</span>
      <span className="continue-where">
        {where}
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
        Source
      </a>
      <span className="site-footer-note">Books and papers belong to their authors and publishers.</span>
    </footer>
  );
}

function AddHint({ label = "Add a book" }: { label?: string }) {
  const cmd = "yagami <file.pdf>";
  const [copied, setCopied] = useState(false);
  return (
    <div className="add-hint">
      {label && <span>{label}</span>}
      <code>{cmd}</code>
      <button
        className="btn icon ghost"
        aria-label="Copy command"
        title="Copy"
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

export function LibraryView({ library, notFound }: { library: Library; notFound?: string }) {
  useEffect(() => {
    document.title = "yagami";
  }, []);
  const books = library.books;
  const demos = books.reduce((n, b) => n + b.units.reduce((m, u) => m + demoCount(b.slug, u.id), 0), 0);

  if (books.length === 0) {
    return (
      <main className="library library-empty">
        <div className="empty">
          <div className="empty-brand">
            <Mark size={24} />
            <span className="wordmark">yagami</span>
          </div>
          <p>Your library is empty. Turn a paper or textbook into a book with</p>
          <AddHint label="" />
        </div>
        <SiteFooter />
      </main>
    );
  }

  return (
    <main className="library">
      <div className="library-inner">
        {notFound && <p className="not-found">Nothing at {decodeURIComponent(notFound)}. Here is the library.</p>}
        <Continue library={library} />

        <div className="library-head">
          <h1>Library</h1>
          <span className="muted">
            {plural(books.length, "book")} · {plural(demos, "demo")}
          </span>
        </div>

        <ul className="books">
          {books.map((b) => {
            const multi = b.units.length > 1;
            const n = b.units.reduce((m, u) => m + demoCount(b.slug, u.id), 0);
            return (
              <li key={b.slug} className="book-row">
                <a className="book-link" href={hashFor({ book: b.slug })}>
                  <Cover book={b.slug} unit={b.units[0]?.id} />
                  <div className="book-text">
                    <span className="book-title">{b.title}</span>
                    {b.subtitle && !b.title.includes(b.subtitle) && <span className="book-sub">{b.subtitle}</span>}
                    <span className="book-meta">
                      <span>{multi ? plural(b.units.length, "chapter") : "Paper"}</span>
                      <span>{plural(n, "demo")}</span>
                    </span>
                  </div>
                </a>
                {multi && (
                  <ul className="chapters">
                    {b.units.map((u) => (
                      <li key={u.id}>
                        <a href={hashFor({ book: b.slug, unit: u.id })}>
                          <span className="chapter-num">{isNumbered(u.id) ? u.id : ""}</span>
                          <span className="chapter-title">
                            <Inline md={u.title} />
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

        <AddHint />
        <SiteFooter />
      </div>
    </main>
  );
}
