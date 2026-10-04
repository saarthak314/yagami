// "?": keyboard shortcuts and the site theme.

import { useEffect, useRef, useState } from "react";
import { THEMES, type ThemeId } from "../theme/themes";
import { savedTheme, setTheme } from "../theme/apply";

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous step"],
  ["Space", "Play / pause"],
  ["r", "Restart demo"],
  ["h", "Pin demo while scrolling"],
  ["◎", "Show the step's paragraph"],
  ["f", "Focus on the demo"],
  ["d", "Show / hide demos"],
  ["t", "Contents"],
  ["+ / −", "Zoom pages (0 to fit)"],
  ["⌘K  /", "Search"],
  ["Esc", "Close / leave focus"],
  ["?", "This panel"],
];

export function HelpButton({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [theme, setThemeState] = useState<ThemeId>(savedTheme);
  useEffect(() => {
    const on = (e: Event) => setThemeState((e as CustomEvent<ThemeId>).detail);
    window.addEventListener("yagami:theme", on);
    return () => window.removeEventListener("yagami:theme", on);
  }, []);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onOpenChange(false);
      opener.current?.focus();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  return (
    <div className="help-wrap" ref={wrap}>
      <button ref={opener} className="btn icon" aria-expanded={open} onClick={() => onOpenChange(!open)} aria-label="Shortcuts and settings" title="Shortcuts and settings (?)">
        ?
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Shortcuts and settings" tabIndex={-1} ref={panel}>
          <dl>
            {SHORTCUTS.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <label className="popover-row">
            <span>Theme</span>
            <select className="select" value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
