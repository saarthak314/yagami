// Header button + panel for model access: which provider builds use, API keys pasted here
// (checked with the provider, saved by the local server) and subscription logins (the official
// CLIs' flows, run by the server). Only shown when the build server is there.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  MODELS_CHANGED,
  OPEN_MODELS,
  cancelLogin,
  chooseProvider,
  getModels,
  removeKey,
  saveKey,
  sendLoginCode,
  startLogin,
  type Health,
  type ModelsView,
  type ProviderId,
  type ProviderState,
  type SubProvider,
} from "../lib/api";
import { Check, Cross, Spinner } from "./icons";

const INFO: Record<ProviderId, { name: string; short: string; models: string }> = {
  anthropic: { name: "anthropic api key", short: "anthropic key", models: "opus writes demos, sonnet reviews" },
  "claude-sub": { name: "claude subscription", short: "claude sub", models: "opus writes demos, sonnet reviews" },
  openai: { name: "openai api key", short: "openai key", models: "gpt-5.5" },
  "openai-sub": { name: "chatgpt subscription", short: "chatgpt sub", models: "gpt-5.5" },
};
const BILLING = { api: "pay per use", subscription: "uses your plan" } as const;
const isKey = (id: ProviderId): id is "anthropic" | "openai" => id === "anthropic" || id === "openai";
const message = (e: unknown, fallback = "something went wrong") => (e instanceof ApiError ? e.message : fallback);

/** Short name of the provider in use, for the header button. */
export const shortName = (id: string | undefined) => (id && id in INFO ? INFO[id as ProviderId].short : "model");

function status(p: ProviderState): string {
  if (!p.ready) return "not set up";
  if (p.source === "env") return `connected · from environment${p.hint ? ` · ${p.hint}` : ""}`;
  if (p.source === "login") return "connected · logged in";
  return `connected${p.hint ? ` · key ${p.hint}` : ""}`;
}

/** A model: a chip. */
const ChipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <path d="M6.5 1.75V4M9.5 1.75V4M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25" />
  </svg>
);

const announceChange = () => window.dispatchEvent(new Event(MODELS_CHANGED));

export function ModelMenu({ health }: { health: Health | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ModelsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The action in flight ("use:openai", "key:anthropic", "login:claude-sub", "code", …). */
  const [busy, setBusy] = useState<string | null>(null);
  /** Errors by row ("auto", a provider id). */
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [editing, setEditing] = useState<"anthropic" | "openai" | null>(null);
  const [keyText, setKeyText] = useState("");
  const [code, setCode] = useState("");
  /** The sign-in tab couldn't be opened (popup blocked): the link is shown prominently. */
  const [blocked, setBlocked] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Where focus goes back to on close (the header button, or the uploader's "connect a model"). */
  const returnTo = useRef<HTMLElement | null>(null);
  const rows = useRef<Partial<Record<string, HTMLElement | null>>>({});
  const focusRow = useRef<string | null>(null);
  /** Bumped by every change: a poll that started before one is stale. */
  const gen = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const healthRef = useRef(health);
  healthRef.current = health;

  const refresh = useCallback(async () => {
    const g = gen.current;
    try {
      const v = await getModels();
      if (g === gen.current) {
        setView(v);
        setLoadError(null);
        // Changed outside the page (a login finished, a key set elsewhere): refresh what the page shows.
        const h = healthRef.current;
        const ready = v.providers.find((p) => p.id === v.active)?.ready ?? false;
        if (h && (h.provider !== v.active || h.credentials !== ready)) announceChange();
      }
    } catch (e) {
      if (g === gen.current) setLoadError(message(e, "couldn't reach yagami"));
    }
  }, []);

  /** Run a change; the view it answers with replaces the current one. */
  const run = async (what: string, row: string, fn: () => Promise<ModelsView>): Promise<ModelsView | null> => {
    gen.current++;
    setBusy(what);
    setErrors((e) => ({ ...e, [row]: undefined }));
    focusRow.current = row;
    try {
      const v = await fn();
      gen.current++;
      setView(v);
      announceChange();
      return v;
    } catch (e) {
      setErrors((x) => ({ ...x, [row]: message(e) }));
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** A provider just got set up while the one chosen isn't: use the new one. */
  const adopt = async (v: ModelsView | null, id: ProviderId) => {
    if (!v || v.pinned || !v.providers.find((p) => p.id === id)?.ready) return;
    if (v.providers.find((p) => p.id === v.active)?.ready) return;
    await run(`use:${id}`, id, () => chooseProvider(id));
  };

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
      setEditing(null);
      setKeyText("");
      setErrors({});
      setBlocked(false);
      // A finished login has nothing more to say; a waiting one keeps going (and polling).
      const v = viewRef.current;
      if (v?.login && v.login.status !== "waiting") {
        gen.current++;
        setView({ ...v, login: null });
        void cancelLogin().catch(() => {});
      }
      // Back to what opened the panel; the header button when that's gone (a "connect a model" that went away).
      const back = returnTo.current?.isConnected ? returnTo.current : opener.current;
      if (refocus) back?.focus({ preventScroll: true });
    },
    [],
  );

  // "connect a model" elsewhere on the page (the uploader) opens this panel.
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

  // After a change removes the focused control (a "use this" that became "in use"), keep focus in its row.
  useEffect(() => {
    if (!open || busy) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const r = focusRow.current && rows.current[focusRow.current];
    (r || panel.current)?.focus({ preventScroll: true });
  }, [view, busy, open, editing]);

  // A login in progress: follow it (ChatGPT finishes by itself once the user signs in).
  const login = view?.login ?? null;
  const waiting = login?.status === "waiting";
  useEffect(() => {
    if (!waiting || busy) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [waiting, busy, refresh]);

  // A login that finished: tell the page, and use it if what's chosen isn't set up.
  const loginDone = login?.status === "done" ? login.provider : null;
  useEffect(() => {
    if (!loginDone) return;
    announceChange();
    setCode("");
    focusRow.current = loginDone;
    void adopt(view, loginDone);
  }, [loginDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = health?.credentials ? shortName(health.provider) : "connect a model";

  const doLogin = (id: SubProvider) => {
    // Open the tab now, inside the click (popup blockers), and point it at the sign-in page once known.
    let tab: Window | null = null;
    try {
      tab = window.open("", "_blank");
    } catch {
      tab = null;
    }
    if (tab) {
      try {
        tab.opener = null;
        tab.document.title = "signing in…";
        tab.document.body.style.cssText = "background:#0a0a0a;color:#a1a1a1;font:14px system-ui;padding:24px";
        tab.document.body.textContent = "opening the sign-in page…";
      } catch {
        // cross-origin already: fine
      }
    }
    setBlocked(!tab);
    setCode("");
    void run(`login:${id}`, id, () => startLogin(id)).then((v) => {
      const url = v?.login?.provider === id && v.login.status === "waiting" ? v.login.url : null;
      if (tab && url) tab.location.href = url;
      else tab?.close();
    });
  };

  const submitKey = async (id: "anthropic" | "openai") => {
    const key = keyText.trim();
    if (!key) return setErrors((e) => ({ ...e, [id]: "paste a key" }));
    const v = await run(`key:${id}`, id, () => saveKey(id, key));
    if (!v) return;
    setEditing(null);
    setKeyText("");
    await adopt(v, id);
  };

  const providers = view?.providers ?? [];
  const activeState = providers.find((p) => p.id === view?.active);
  const pinned = !!view?.pinned;
  const anyBusy = busy !== null;

  const keyForm = (id: "anthropic" | "openai") => {
    const checking = busy === `key:${id}`;
    return (
      <form
        className="model-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submitKey(id);
        }}
      >
        <label className="model-label" htmlFor={`model-key-${id}`}>
          {id === "anthropic" ? "anthropic api key" : "openai api key"}
        </label>
        <div className="model-inline">
          <input
            id={`model-key-${id}`}
            className="model-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={id === "anthropic" ? "sk-ant-…" : "sk-…"}
            value={keyText}
            disabled={checking}
            autoFocus
            aria-invalid={!!errors[id]}
            aria-describedby={errors[id] ? `model-err-${id}` : `model-keynote-${id}`}
            onChange={(e) => setKeyText(e.target.value)}
          />
          <button type="submit" className="btn primary small" disabled={checking || !keyText.trim()}>
            {checking ? (
              <>
                <Spinner /> checking…
              </>
            ) : (
              "save"
            )}
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={checking}
            onClick={() => {
              setEditing(null);
              setKeyText("");
              setErrors((e) => ({ ...e, [id]: undefined }));
              focusRow.current = id;
            }}
          >
            cancel
          </button>
        </div>
        <span className="model-note" id={`model-keynote-${id}`}>
          checked with {id === "anthropic" ? "anthropic" : "openai"} (free), then saved on this computer only.
        </span>
      </form>
    );
  };

  const loginBlock = (id: SubProvider) => {
    if (!login || login.provider !== id) return null;
    if (login.status === "done")
      return (
        <p className="model-done" role="status">
          <Check /> logged in
        </p>
      );
    if (login.status === "failed")
      return (
        <div className="model-login">
          <p className="model-error" role="alert">
            {login.error ?? "the login didn't finish"}
          </p>
          <div className="model-actions">
            <button className="btn small" disabled={anyBusy} onClick={() => doLogin(id)}>
              try again
            </button>
            <button className="btn ghost small" disabled={anyBusy} onClick={() => void run("cancel", id, cancelLogin)}>
              dismiss
            </button>
          </div>
        </div>
      );
    const claude = id === "claude-sub";
    const sending = busy === "code";
    return (
      <div className="model-login">
        <p className="model-wait">
          <Spinner />
          {claude ? "sign in on claude.ai, then paste the code it shows." : "sign in on the page that opened. this finishes by itself."}
        </p>
        {login.url && (
          <a className={`btn small${blocked ? " primary" : ""} model-link`} href={login.url} target="_blank" rel="noreferrer">
            {blocked ? "open the sign-in page" : "sign-in page"} ↗
          </a>
        )}
        {claude && (
          <form
            className="model-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!code.trim()) return;
              void run("code", id, () => sendLoginCode(code.trim()));
            }}
          >
            <label className="model-label" htmlFor="model-code">
              code from claude.ai
            </label>
            <div className="model-inline">
              <input
                id="model-code"
                className="model-input"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="paste the code"
                value={code}
                disabled={sending}
                aria-invalid={!!login.codeError}
                aria-describedby={login.codeError ? "model-code-err" : undefined}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="submit" className="btn primary small" disabled={sending || !code.trim()}>
                {sending ? (
                  <>
                    <Spinner /> checking…
                  </>
                ) : (
                  "connect"
                )}
              </button>
            </div>
            {login.codeError && (
              <span className="model-error" id="model-code-err" role="alert">
                {login.codeError}
              </span>
            )}
          </form>
        )}
        <div className="model-actions">
          <button className="btn ghost small" disabled={busy === "cancel"} onClick={() => void run("cancel", id, cancelLogin)}>
            cancel login
          </button>
        </div>
      </div>
    );
  };

  const row = (p: ProviderState) => {
    const info = INFO[p.id];
    // Under "automatic" with nothing set up, the fallback isn't really in use.
    const inUse = view?.active === p.id && (view.chosen !== null || p.ready);
    const loggingIn = login?.provider === p.id && login.status !== "done";
    const err = errors[p.id];
    return (
      <li
        key={p.id}
        className={`model-row${inUse ? " in-use" : ""}`}
        tabIndex={-1}
        ref={(el) => {
          rows.current[p.id] = el;
        }}
      >
        <div className="model-row-head">
          <span className={`model-dot${p.ready ? " on" : ""}`} aria-hidden />
          <span className="model-name">{info.name}</span>
          {inUse ? (
            <span className="tag in-use">in use</span>
          ) : (
            p.ready &&
            !pinned && (
              <button className="btn small" disabled={anyBusy} onClick={() => void run(`use:${p.id}`, p.id, () => chooseProvider(p.id))}>
                {busy === `use:${p.id}` ? <Spinner /> : null}
                use this
              </button>
            )
          )}
        </div>
        <div className="model-row-sub">
          <span className={p.ready ? "model-status" : "model-status off"}>{status(p)}</span>
          {isKey(p.id) && p.source !== "env" && editing !== p.id && (
            <span className="model-row-actions">
              {p.source === "saved" && (
                <button
                  className="btn ghost small"
                  disabled={anyBusy}
                  onClick={() => {
                    setEditing(p.id as "anthropic" | "openai");
                    setKeyText("");
                  }}
                >
                  replace
                </button>
              )}
              {p.source === "saved" ? (
                <button className="btn ghost small" disabled={anyBusy} onClick={() => void run(`remove:${p.id}`, p.id, () => removeKey(p.id as "anthropic" | "openai"))}>
                  {busy === `remove:${p.id}` ? "removing…" : "remove"}
                </button>
              ) : (
                <button
                  className="btn small"
                  disabled={anyBusy}
                  onClick={() => {
                    setEditing(p.id as "anthropic" | "openai");
                    setKeyText("");
                  }}
                >
                  add key
                </button>
              )}
            </span>
          )}
          {!isKey(p.id) && !p.ready && !loggingIn && (
            <span className="model-row-actions">
              <button className="btn small" disabled={anyBusy} onClick={() => doLogin(p.id as SubProvider)}>
                {busy === `login:${p.id}` ? (
                  <>
                    <Spinner /> starting…
                  </>
                ) : (
                  "log in"
                )}
              </button>
            </span>
          )}
        </div>
        <div className="model-meta">
          {BILLING[p.billing]} · {info.models}
        </div>
        {editing === p.id && isKey(p.id) && keyForm(p.id)}
        {!isKey(p.id) && loginBlock(p.id)}
        {err && (
          <p className="model-error" id={`model-err-${p.id}`} role="alert">
            {err}
          </p>
        )}
      </li>
    );
  };

  const auto = view?.chosen === null;
  return (
    <div className="model-wrap" ref={wrap}>
      <button
        ref={opener}
        className={`btn model-btn${health?.credentials ? "" : " cta"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={health?.credentials ? `model: ${label}` : "connect a model"}
        title="model"
        onClick={() => (open ? close() : show())}
      >
        <span className={`model-dot${health?.credentials ? " on" : " warn"}`} aria-hidden />
        <span className="model-btn-label">{label}</span>
        <span className="model-btn-phone" aria-hidden>
          {health?.credentials ? <ChipIcon /> : "connect"}
        </span>
      </button>
      {open && (
        <div
          className="model-panel"
          role="dialog"
          aria-label="model"
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
            <span className="model-title">model</span>
            <span className="model-sub">what builds run on</span>
            <button className="btn icon ghost" aria-label="close" title="close (esc)" onClick={() => close()}>
              <Cross />
            </button>
          </div>

          {!view ? (
            loadError ? (
              <p className="model-error model-pad" role="alert">
                {loadError}
              </p>
            ) : (
              <p className="model-wait model-pad">
                <Spinner /> loading…
              </p>
            )
          ) : (
            <>
              {pinned ? (
                <p className="model-banner">
                  YAGAMI_PROVIDER={view.chosen} is set where yagami runs, so it picks the model. unset it to choose here.
                </p>
              ) : (
                !activeState?.ready && (
                  <p className="model-banner">
                    {providers.some((p) => p.ready)
                      ? `${INFO[view.active].name} is chosen but not set up — set it up or use another.`
                      : "nothing is connected yet. add an api key or log in with a subscription."}
                  </p>
                )
              )}
              <ul className="model-list">
                {!pinned && (
                  <li
                    className={`model-row${auto ? " in-use" : ""}`}
                    tabIndex={-1}
                    ref={(el) => {
                      rows.current.auto = el;
                    }}
                  >
                    <div className="model-row-head">
                      <span className="model-dot auto" aria-hidden />
                      <span className="model-name">automatic</span>
                      {auto ? (
                        <span className="tag in-use">in use</span>
                      ) : (
                        <button className="btn small" disabled={anyBusy} onClick={() => void run("use:auto", "auto", () => chooseProvider(null))}>
                          {busy === "use:auto" ? <Spinner /> : null}
                          use this
                        </button>
                      )}
                    </div>
                    <div className="model-row-sub">
                      <span className="model-status">
                        {auto ? (activeState?.ready ? `now ${INFO[view.active].name}` : "nothing set up yet") : "the first one set up, in this order"}
                      </span>
                    </div>
                    {errors.auto && (
                      <p className="model-error" role="alert">
                        {errors.auto}
                      </p>
                    )}
                  </li>
                )}
                {providers.map(row)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
