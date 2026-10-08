// Header button + popover for model access: the provider builds use, keys and plan logins (the
// rows and their flows are the shared ModelChooser). Only shown when the build server is there.

import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_MODELS, PROVIDERS, modelGap, type Health, type ProviderId } from "../lib/api";
import { ModelChooser, useModelAccess } from "./ModelChooser";
import { Cross } from "./icons";

/** Short name of a provider, for the header button ("claude plan"). */
const shortName = (id: string | undefined) => (id && id in PROVIDERS ? PROVIDERS[id as ProviderId].short : "model");

/** A model: a chip. */
const ChipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <path d="M6.5 1.75V4M9.5 1.75V4M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25" />
  </svg>
);

export function ModelMenu({ health }: { health: Health | null | undefined }) {
  const m = useModelAccess(health);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Where focus goes back to on close (the header button, or the uploader's "connect a model"). */
  const returnTo = useRef<HTMLElement | null>(null);
  const { refresh, clearFinished } = m;

  const show = useCallback(
    (from?: HTMLElement | null) => {
      returnTo.current = from ?? opener.current;
      setOpen(true);
      void refresh();
    },
    [refresh],
  );

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      clearFinished();
      // Back to what opened the panel; the header button when that's gone (a "connect a model" that went away).
      const back = returnTo.current?.isConnected ? returnTo.current : opener.current;
      if (refocus) back?.focus({ preventScroll: true });
    },
    [clearFinished],
  );

  // "connect a model" elsewhere on the page (the uploader, the build page) opens this panel.
  useEffect(() => {
    const on = () => show(document.activeElement as HTMLElement | null);
    window.addEventListener(OPEN_MODELS, on);
    return () => window.removeEventListener(OPEN_MODELS, on);
  }, [show]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const gap = modelGap(health, m.view);
  const ok = !!health?.credentials;
  const label = m.waiting ? "logging in…" : ok ? shortName(health?.provider) : gap?.id ? `${PROVIDERS[gap.id].short} · not set up` : "connect a model";
  const ariaLabel = `model: ${ok ? shortName(health?.provider) : gap?.id ? `${PROVIDERS[gap.id].name} chosen, not set up` : "none connected — connect a model"}${m.waiting ? ", a login is waiting" : ""}`;

  return (
    <div className="model-wrap" ref={wrap}>
      <button
        ref={opener}
        className={`btn model-btn${ok ? "" : " cta"}${ok || m.waiting ? " chip" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "model-panel" : undefined}
        aria-label={ariaLabel}
        title="model — what builds run on"
        onClick={() => (open ? close() : show())}
      >
        <span className={`model-dot${ok ? " on" : " warn"}`} aria-hidden />
        <span className="model-btn-label">{label}</span>
        <span className="model-btn-phone" aria-hidden>
          {ok || m.waiting ? <ChipIcon /> : "connect"}
        </span>
      </button>
      {open && (
        <div
          className="model-panel"
          id="model-panel"
          role="dialog"
          aria-labelledby="model-panel-title"
          tabIndex={-1}
          ref={panel}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
          }}
          onBlur={(e) => {
            // Tabbing out of the panel closes it (a new tab taking focus doesn't: no related target).
            const to = e.relatedTarget as Node | null;
            if (to && !wrap.current?.contains(to)) close(false);
          }}
        >
          <div className="model-head">
            <h2 className="model-title" id="model-panel-title">
              model
            </h2>
            <button className="btn icon ghost" aria-label="close" title="close (esc)" onClick={() => close()}>
              <Cross />
            </button>
          </div>
          <ModelChooser m={m} />
        </div>
      )}
    </div>
  );
}
