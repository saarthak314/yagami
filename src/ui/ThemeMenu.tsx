// Header button + menu for the site theme.

import { useEffect, useRef, useState } from "react";
import { THEMES, type ThemeId } from "../theme/themes";
import { savedTheme, setTheme } from "../theme/apply";

const ThemeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor" />
  </svg>
);

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ThemeId>(savedTheme);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const on = (e: Event) => setCurrent((e as CustomEvent<ThemeId>).detail);
    window.addEventListener("yagami:theme", on);
    return () => window.removeEventListener("yagami:theme", on);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, THEMES.findIndex((t) => t.id === current)));
    list.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]); // runs when the menu opens; `current` only seeds the highlight

  const choose = (id: ThemeId) => {
    setTheme(id);
    setOpen(false);
    opener.current?.focus();
  };

  return (
    <div className="theme-wrap" ref={wrap}>
      <button
        ref={opener}
        className="btn icon"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Theme"
        title="theme"
        onClick={() => setOpen((v) => !v)}
      >
        <ThemeIcon />
      </button>
      {open && (
        <ul
          ref={list}
          className="theme-menu"
          role="listbox"
          aria-label="Theme"
          aria-activedescendant={`theme-${THEMES[active].id}`}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((i) => (i + 1) % THEMES.length);
            else if (e.key === "ArrowUp") setActive((i) => (i - 1 + THEMES.length) % THEMES.length);
            else if (e.key === "Enter" || e.key === " ") choose(THEMES[active].id);
            else if (e.key === "Escape") {
              setOpen(false);
              opener.current?.focus();
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {THEMES.map((t, i) => (
            <li
              key={t.id}
              id={`theme-${t.id}`}
              role="option"
              aria-selected={t.id === current}
              className={i === active ? "active" : undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(t.id)}
            >
              <span className="theme-swatch" style={{ background: t.bg, borderColor: t.borderStrong }}>
                <span style={{ background: t.fg }} />
                <span style={{ background: t.accent }} />
              </span>
              <span className="theme-name">{t.label}</span>
              {t.id === current && <span className="theme-check" aria-hidden>✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
