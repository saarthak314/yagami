// Command palette (⌘K or /): jump to a book, chapter, section or demo.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Library } from "../types";
import { search, searchIndex, type Target } from "../lib/search";
import { Inline } from "../lib/inline";

const LIMIT = 60;

export function Palette({
  library,
  near,
  onGo,
  onClose,
}: {
  library: Library;
  near?: { book: string; unit?: string };
  onGo: (t: Target) => void;
  onClose: () => void;
}) {
  const index = useMemo(() => searchIndex(library), [library]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const results = useMemo(() => search(index, query, near).slice(0, LIMIT), [index, query, near]);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const r = results[i];
    if (r) onGo(r.target);
  };

  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onPointerUp={() => input.current?.focus()}
      >
        <input
          ref={input}
          className="palette-input"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-label="Search"
          placeholder="Search books, chapters, sections and demos"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel);
            } else if (e.key === "Tab") {
              // Focus stays in the field; Tab moves the selection like the arrows.
              e.preventDefault();
              setSel((s) => (e.shiftKey ? Math.max(0, s - 1) : Math.min(results.length - 1, s + 1)));
            }
          }}
          aria-activedescendant={`palette-${sel}`}
          aria-controls="palette-list"
        />
        <ul className="palette-list" id="palette-list" ref={list} role="listbox" tabIndex={-1}>
          {results.map((r, i) => (
            <li
              key={`${r.kind}:${r.target.book}/${r.target.unit}/${r.target.section ?? ""}/${r.target.anchor ?? ""}/${r.title}`}
              id={`palette-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "selected" : undefined}
              onPointerMove={() => setSel(i)}
              onClick={() => choose(i)}
            >
              <span className="palette-kind">{r.kind}</span>
              <span className="palette-main">
                <span className="palette-title">
                  <Inline md={r.title} />
                </span>
                <span className="palette-context">{r.context}</span>
              </span>
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">{index.length === 0 ? "The library is empty." : `Nothing matches “${query}”.`}</li>}
        </ul>
      </div>
    </div>
  );
}
