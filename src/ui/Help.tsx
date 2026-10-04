// "?": keyboard shortcuts.

import { useEffect, useRef } from "react";

const SHORTCUTS: [string, string][] = [
  ["next / previous step", "j  k"],
  ["play / pause", "space"],
  ["restart", "r"],
  ["pin demo", "h"],
  ["focus demo", "f"],
  ["hide demos", "d"],
  ["contents", "t"],
  ["zoom", "+  −"],
  ["search", "⌘k"],
];

export function HelpButton({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
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
      <button ref={opener} className="btn icon" aria-expanded={open} onClick={() => onOpenChange(!open)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        ?
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={panel}>
          <dl>
            {SHORTCUTS.map(([what, key]) => (
              <div key={what}>
                <dt>{what}</dt>
                <dd>
                  <kbd>{key}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
