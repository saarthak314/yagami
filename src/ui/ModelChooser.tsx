// Model access, shared by the header's model panel and the #/connect page: which provider builds
// use, API keys pasted here (checked with the provider, saved by the local server) and plan logins
// (the official CLIs' flows, run by the server).
//
// Two groups ("use your plan", "use an api key"), one line per provider: a status dot, its name and
// one action or state. Details (what it needs, its models, the key) and flows (paste a key, log in)
// open inside the row, one row at a time.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  MODELS_CHANGED,
  PROVIDERS,
  cancelLogin,
  chooseProvider,
  getModels,
  publishModels,
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
import { Check, ChevronDown, Spinner } from "./icons";

type KeyProvider = "anthropic" | "openai";

const ENV_VAR: Record<KeyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const KEY_PAGE: Record<KeyProvider, { href: string; text: string }> = {
  anthropic: { href: "https://console.anthropic.com/settings/keys", text: "console.anthropic.com" },
  openai: { href: "https://platform.openai.com/api-keys", text: "platform.openai.com" },
};
const CLI: Record<SubProvider, { name: string; needs: string; install: string; login: string; logout: string }> = {
  "claude-sub": { name: "claude code", needs: "needs claude code and a claude plan", install: "npm i -g @anthropic-ai/claude-code", login: "claude auth login", logout: "claude auth logout" },
  "openai-sub": { name: "codex", needs: "needs codex and a chatgpt plan", install: "npm i -g @openai/codex", login: "codex login", logout: "codex logout" },
};
/** Row names: the group label says "plan" or "key". */
export const LABEL: Record<ProviderId, string> = { "claude-sub": "claude", "openai-sub": "chatgpt", anthropic: "anthropic key", openai: "openai key" };
const GROUPS: { id: string; label: string; ids: ProviderId[] }[] = [
  { id: "plan", label: "use your plan", ids: ["claude-sub", "openai-sub"] },
  { id: "key", label: "use an api key", ids: ["anthropic", "openai"] },
];
/** The connect page's line under each name: what it costs and what it needs. */
const BLURB: Record<ProviderId, string> = {
  "claude-sub": "included in your plan · needs claude code",
  "openai-sub": "included in your plan · needs codex",
  anthropic: "pay per use · about $2.50 a chapter",
  openai: "pay per use",
};
const BILLING = { api: "pay per use", subscription: "included in your plan" } as const;

const isKey = (id: ProviderId): id is KeyProvider => id === "anthropic" || id === "openai";
const message = (e: unknown, fallback = "something went wrong") => (e instanceof ApiError ? e.message : fallback);
const announceChange = () => window.dispatchEvent(new Event(MODELS_CHANGED));

/** A login CLI's error, as a plain line (raw CLI output like `{"error":"invalid_grant",…}` never shows). */
function loginError(raw: string | undefined, id: SubProvider): { text: string; install?: boolean } {
  const s = (raw ?? "").toLowerCase();
  const cli = CLI[id];
  if (/not installed|enoent|command not found/.test(s)) return { text: `${cli.name} isn't installed — install it first, then log in.`, install: true };
  if (/invalid_grant|invalid|bad code|for a new code/.test(s)) return { text: "that code didn't work — codes work once and expire after a few minutes. log in again for a new one." };
  if (/expired|timed? ?out|timeout/.test(s)) return { text: "the sign-in expired — log in again." };
  if (/cancel|denied|access_denied/.test(s)) return { text: "the sign-in was cancelled." };
  if (/didn't start|no sign-in link/.test(s)) return { text: `${cli.name} didn't start the login — try again, or run ${cli.login} in a terminal.` };
  if (!s || /^[{[]/.test(s.trim()) || /status code|\b[45]\d\d\b/.test(s) || s.length > 140) return { text: "the login didn't finish — try again." };
  return { text: s };
}

/** A pasted code that was refused while the login still waits. */
const codeError = (raw: string) =>
  /expired/i.test(raw) ? "that code expired — cancel and log in again for a new one." : "that code didn't work — copy the whole code and paste it again.";

/** The active provider is set up: builds can run. */
export const activeReady = (v: ModelsView | null) => !!v?.providers.find((p) => p.id === v.active)?.ready;

/**
 * The providers as the server sees them, and the changes made to them. One instance at a time: the
 * header's model menu, or the connect page (which has no model menu).
 */
export function useModelAccess(health: Health | null | undefined) {
  const [view, setView] = useState<ModelsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The action in flight ("use:openai", "key:anthropic", "login:claude-sub", "code", …). */
  const [busy, setBusy] = useState<string | null>(null);
  /** Errors by row ("auto", a provider id). */
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  /** The code pasted for a claude login (kept while the panel is closed). */
  const [code, setCode] = useState("");
  /** The sign-in tab couldn't be opened (popup blocked): the link is shown prominently. */
  const [blocked, setBlocked] = useState(false);
  /** The row an action was about: focus stays there when the control it used goes away. */
  const focusRow = useRef<string | null>(null);
  /** Bumped by every change: a poll that started before one is stale. */
  const gen = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const healthRef = useRef(health);
  healthRef.current = health;

  // The rest of the page (uploader, build page) names the chosen provider from this view.
  useEffect(() => publishModels(view), [view]);

  const refresh = useCallback(async () => {
    const g = gen.current;
    try {
      const v = await getModels();
      if (g === gen.current) {
        setView(v);
        setLoadError(null);
        // Changed outside the page (a login finished, a key set elsewhere): refresh what the page shows.
        const h = healthRef.current;
        if (h && (h.provider !== v.active || h.credentials !== activeReady(v))) announceChange();
      }
    } catch (e) {
      if (g === gen.current) setLoadError(message(e, "couldn't reach yagami"));
    }
  }, []);

  // Loaded up front: the panel opens with its rows, and the header can say which provider is chosen.
  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    if (activeReady(v)) return;
    await run(`use:${id}`, id, () => chooseProvider(id));
  };

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
    setBlocked(false);
    focusRow.current = loginDone;
    void adopt(view, loginDone);
  }, [loginDone]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Leaving (the panel closes, the page goes): a finished login has nothing more to say; a waiting one keeps going. */
  const clearFinished = useCallback(() => {
    setErrors({});
    const v = viewRef.current;
    if (v?.login?.status !== "waiting") setBlocked(false);
    if (v?.login && v.login.status !== "waiting") {
      gen.current++;
      setView({ ...v, login: null });
      void cancelLogin().catch(() => {});
    }
  }, []);

  return { view, loadError, busy, errors, setErrors, code, setCode, blocked, setBlocked, focusRow, login, waiting, refresh, run, adopt, clearFinished };
}

export type ModelAccess = ReturnType<typeof useModelAccess>;

/** Rows while the view loads (rarely seen: it's fetched with the page). */
function Skeleton({ page }: { page: boolean }) {
  return (
    <>
      <span className="sr-only" role="status">
        loading…
      </span>
      <div aria-hidden className="mc-skel-wrap">
        {[0, 1].map((g) => (
          <div key={g} className="mc-group">
            <span className="skel static skel-line mc-skel-label" />
            {[0, 1].map((i) => (
              <div key={i} className={`mc-row mc-skel${page ? " mc-card" : ""}`}>
                <span className="skel static skel-line" style={{ width: `${40 - i * 8}%` }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The providers, grouped, one line each. `page`: the connect page's larger cards (with what each
 * costs and needs under its name, and no "automatic" footer).
 */
export function ModelChooser({ m, variant = "panel" }: { m: ModelAccess; variant?: "panel" | "page" }) {
  const { view, busy, errors, login, waiting, run, adopt, refresh, focusRow } = m;
  const page = variant === "page";
  /** The one open row. A login that's waiting or failed opens its row. */
  const [expanded, setExpanded] = useState<ProviderId | null>(() => (login && login.status !== "done" ? login.provider : null));
  const [editing, setEditing] = useState<KeyProvider | null>(null);
  const [confirming, setConfirming] = useState<KeyProvider | null>(null);
  const [keyText, setKeyText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heads = useRef<Partial<Record<string, HTMLElement | null>>>({});
  /** A control to focus once it's rendered and enabled (after an async action). */
  const want = useRef<{ sel: string; select?: boolean } | null>(null);
  const [, rerender] = useState(0);
  const focusSoon = (sel: string, select = false) => {
    want.current = { sel, select };
    rerender((n) => n + 1);
  };

  // After a change removes the focused control (a "use" that became "in use"), keep focus in its row.
  useEffect(() => {
    if (busy) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const r = focusRow.current && heads.current[focusRow.current];
    if (r) r.focus({ preventScroll: true });
    else root.current?.closest<HTMLElement>("[role=dialog]")?.focus({ preventScroll: true });
  }, [view, busy, editing, confirming, expanded, focusRow]);

  // Then the control an action asked for, once it's there and enabled (after the effect above).
  useEffect(() => {
    const w = want.current;
    if (!w) return;
    // "a || b": the first that's there (waiting while it's disabled).
    let el: HTMLElement | null = null;
    for (const sel of w.sel.split(" || ")) if ((el = root.current?.querySelector<HTMLElement>(sel) ?? null)) break;
    if (!el || (el as HTMLButtonElement).disabled) return;
    want.current = null;
    el.focus();
    if (w.select && el instanceof HTMLInputElement) el.select();
  });

  // A login that starts waiting or fails opens its row (also when it changed while the panel was closed).
  const loginKey = login ? `${login.provider}:${login.status}` : "";
  useEffect(() => {
    if (login && login.status !== "done") setExpanded(login.provider);
  }, [loginKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A refused code: back to the code field, selected, to paste the right one.
  const refused = login?.codeError ?? null;
  useEffect(() => {
    if (refused) focusSoon("#model-code", true);
  }, [refused]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) {
    return m.loadError ? (
      <p className="model-error mc-pad" role="alert">
        {m.loadError}
      </p>
    ) : (
      <Skeleton page={page} />
    );
  }

  const providers = view.providers;
  const byId = (id: ProviderId) => providers.find((p) => p.id === id);
  const pinned = view.pinned;
  const anyBusy = busy !== null;
  const auto = view.chosen === null;
  const activeState = byId(view.active);

  const toggle = (id: ProviderId) => {
    setExpanded((x) => (x === id ? null : id));
    // A key being typed or a removal being confirmed belongs to its row: closing it (or opening another) drops it.
    if (editing) {
      setEditing(null);
      setKeyText("");
      m.setErrors((e) => ({ ...e, [editing]: undefined }));
    }
    setConfirming(null);
  };

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
    m.setBlocked(!tab);
    m.setCode("");
    setExpanded(id);
    setEditing(null);
    setConfirming(null);
    void run(`login:${id}`, id, () => startLogin(id)).then((v) => {
      const l = v?.login?.provider === id ? v.login : null;
      const url = l?.status === "waiting" ? l.url : null;
      if (tab && url) tab.location.href = url;
      else tab?.close();
      if (l?.status === "waiting") focusSoon(!tab ? ".model-link" : id === "claude-sub" ? "#model-code" : ".model-link");
    });
  };

  const cancelLogin_ = (id: SubProvider) =>
    void run("cancel", id, cancelLogin).then(() => {
      m.setBlocked(false);
      focusSoon(`[data-act="login:${id}"] || #model-head-${id}`);
    });

  const startEdit = (id: KeyProvider) => {
    setExpanded(id);
    setEditing(id);
    setConfirming(null);
    setKeyText("");
  };

  const cancelEdit = (id: KeyProvider) => {
    setEditing(null);
    setKeyText("");
    m.setErrors((e) => ({ ...e, [id]: undefined }));
    focusSoon(`[data-act="edit:${id}"] || #model-head-${id}`);
  };

  const submitKey = async (id: KeyProvider) => {
    const key = keyText.trim();
    if (!key) return m.setErrors((e) => ({ ...e, [id]: "paste a key" }));
    const v = await run(`key:${id}`, id, () => saveKey(id, key));
    if (!v) return focusSoon(`#model-key-${id}`, true);
    setEditing(null);
    setKeyText("");
    await adopt(v, id);
  };

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
      },
      () => {},
    );
  };

  const use = (id: ProviderId) => run(`use:${id}`, id, () => chooseProvider(id));

  // --- pieces of a row's open part

  const ext = (id: KeyProvider) => (
    <a className="model-ext" href={KEY_PAGE[id].href} target="_blank" rel="noreferrer">
      {KEY_PAGE[id].text} <span aria-hidden>↗</span>
      <span className="sr-only"> (opens a new tab)</span>
    </a>
  );

  const installLine = (id: SubProvider) => (
    <div className="model-install">
      <code>{CLI[id].install}</code>
      <button className="btn ghost small" aria-label={`copy the install command: ${CLI[id].install}`} onClick={() => copy(id, CLI[id].install)}>
        {copied === id ? <Check /> : null}
        {copied === id ? "copied" : "copy"}
      </button>
      <span className="sr-only" role="status">
        {copied === id ? "copied" : ""}
      </span>
    </div>
  );

  const keyForm = (id: KeyProvider, p: ProviderState) => {
    const checking = busy === `key:${id}`;
    return (
      <form
        className="model-form"
        onSubmit={(e) => {
          e.preventDefault();
          // Focus stays with the key (a clicked "save" turns disabled while it's checked).
          document.getElementById(`model-key-${id}`)?.focus();
          void submitKey(id);
        }}
      >
        <div className="model-inline">
          <input
            id={`model-key-${id}`}
            className="model-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={id === "anthropic" ? "sk-ant-…" : "sk-…"}
            value={keyText}
            // Read-only, not disabled, while it's checked: focus stays here for a retry.
            readOnly={checking}
            aria-busy={checking}
            autoFocus
            aria-label={`paste your ${PROVIDERS[id].name}`}
            aria-invalid={!!errors[id]}
            aria-describedby={errors[id] ? `model-err-${id}` : `model-keynote-${id}`}
            onChange={(e) => setKeyText(e.target.value)}
            onKeyDown={(e) => {
              // Escape cancels the edit first; a second one closes the panel.
              if (e.key === "Escape" && !checking) {
                e.stopPropagation();
                cancelEdit(id);
              }
            }}
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
          <button type="button" className="btn ghost small" disabled={checking} onClick={() => cancelEdit(id)}>
            cancel
          </button>
        </div>
        <span className="model-note" id={`model-keynote-${id}`}>
          checked with {id} for free, then saved on this computer only.
        </span>
        {p.source === null && <span className="model-note">get a key at {ext(id)}</span>}
      </form>
    );
  };

  const confirmRemove = (p: ProviderState & { id: KeyProvider }) => (
    <div
      className="model-confirm"
      role="group"
      aria-labelledby={`model-confirm-${p.id}`}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        setConfirming(null);
        focusSoon(`[data-act="remove:${p.id}"]`);
      }}
    >
      <span id={`model-confirm-${p.id}`}>remove {p.hint ? `key ${p.hint}` : "this key"}?</span>
      <button
        className="btn small model-danger"
        data-act={`confirm-remove:${p.id}`}
        disabled={anyBusy}
        onClick={() =>
          void run(`remove:${p.id}`, p.id, () => removeKey(p.id)).then((v) => {
            setConfirming(null);
            if (v) focusSoon(`[data-act="edit:${p.id}"]`);
          })
        }
      >
        {busy === `remove:${p.id}` ? "removing…" : "remove"}
      </button>
      <button
        className="btn ghost small"
        data-act="keep"
        disabled={anyBusy}
        onClick={() => {
          setConfirming(null);
          focusSoon(`[data-act="remove:${p.id}"]`);
        }}
      >
        keep
      </button>
    </div>
  );

  const loginBlock = (id: SubProvider): ReactNode => {
    if (!login || login.provider !== id) return null;
    if (login.status === "done")
      return (
        <p className="model-done" role="status">
          <Check /> logged in
        </p>
      );
    if (login.status === "failed") {
      const why = loginError(login.error, id);
      return (
        <div className="model-login">
          <p className="model-error" role="alert">
            {why.text}
          </p>
          {why.install && installLine(id)}
          <div className="model-actions">
            {!why.install && (
              <button className="btn small" disabled={anyBusy} onClick={() => doLogin(id)}>
                try again
              </button>
            )}
            <button className="btn ghost small" disabled={anyBusy} onClick={() => cancelLogin_(id)}>
              dismiss
            </button>
          </div>
        </div>
      );
    }
    const sending = busy === "code";
    const link = login.url && (
      <a className={`btn small${m.blocked ? " primary" : ""} model-link`} href={login.url} target="_blank" rel="noreferrer">
        {m.blocked ? "open the sign-in page" : "sign-in page"} ↗
      </a>
    );
    const cancel = (
      <div className="model-actions">
        <button className="btn ghost small" disabled={busy === "cancel"} onClick={() => cancelLogin_(id)}>
          cancel login
        </button>
      </div>
    );
    if (id === "openai-sub")
      return (
        <div className="model-login">
          <p className="model-wait" role="status">
            <Spinner /> waiting for you to sign in…
          </p>
          <p className="model-note">{m.blocked ? "open the sign-in page and sign in with chatgpt." : "sign in on the chatgpt page that opened."} this finishes by itself.</p>
          {link}
          {cancel}
        </div>
      );
    return (
      <div className="model-login">
        <ol className="model-steps">
          <li>
            <span className="model-step-n" aria-hidden>
              1
            </span>
            <span className="model-step-body">
              <span>
                sign in on claude.ai{m.blocked ? "" : <span className="model-step-hint"> (opened in a new tab)</span>}
              </span>
              {link}
            </span>
          </li>
          <li>
            <span className="model-step-n" aria-hidden>
              2
            </span>
            <form
              className="model-step-body"
              onSubmit={(e) => {
                e.preventDefault();
                if (!m.code.trim()) return;
                void run("code", id, () => sendLoginCode(m.code.trim()));
              }}
            >
              <label htmlFor="model-code">paste the code it shows</label>
              <span className="model-inline">
                <input
                  id="model-code"
                  className="model-input"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="code from claude.ai"
                  value={m.code}
                  readOnly={sending}
                  aria-busy={sending}
                  aria-invalid={!!login.codeError}
                  aria-describedby={login.codeError ? "model-code-err" : undefined}
                  onChange={(e) => m.setCode(e.target.value)}
                />
                <button type="submit" className="btn primary small" disabled={sending || !m.code.trim()}>
                  {sending ? (
                    <>
                      <Spinner /> checking…
                    </>
                  ) : (
                    "connect"
                  )}
                </button>
              </span>
              {login.codeError && (
                <span className="model-error" id="model-code-err" role="alert">
                  {codeError(login.codeError)}
                </span>
              )}
            </form>
          </li>
        </ol>
        {cancel}
      </div>
    );
  };

  /** What an open row says when nothing is in progress in it. */
  const details = (p: ProviderState): ReactNode => {
    const lines: ReactNode[] = [];
    if (isKey(p.id)) {
      const id = p.id;
      if (p.source === "env")
        lines.push(
          <p key="src">
            set in your shell (<code>{ENV_VAR[id]}</code>) — change it there
          </p>,
        );
      else if (p.source === "saved")
        lines.push(
          <div key="src" className="mc-keyline">
            <span>saved on this computer</span>
            <button className="btn small" data-act={`edit:${id}`} disabled={anyBusy} aria-label={`replace ${PROVIDERS[id].name}`} onClick={() => startEdit(id)}>
              replace
            </button>
            <button
              className="btn ghost small model-remove"
              data-act={`remove:${id}`}
              disabled={anyBusy}
              aria-label={`remove ${PROVIDERS[id].name}`}
              onClick={() => {
                setConfirming(id);
                focusSoon('[data-act="keep"]');
              }}
            >
              remove
            </button>
          </div>,
        );
      else lines.push(<p key="src">get a key at {ext(id)}</p>);
    } else {
      const id = p.id;
      if (!p.ready && p.installed === false)
        lines.push(
          // (the card already says "install … first" under its name)
          !page && <p key="need">install {CLI[id].name} first, then log in:</p>,
          <div key="install" className="mc-installrow">
            {installLine(id)}
            <button
              className="btn ghost small"
              data-act={`check:${id}`}
              disabled={anyBusy}
              aria-label={`check again whether ${CLI[id].name} is installed`}
              onClick={() => {
                focusRow.current = id;
                void refresh().then(() => focusSoon(`[data-act="login:${id}"] || [data-act="check:${id}"]`));
              }}
            >
              check again
            </button>
          </div>,
        );
      else if (p.ready)
        lines.push(
          <p key="out">
            to sign out: <code>{CLI[id].logout}</code>
          </p>,
        );
      else if (!page) lines.push(<p key="need">{CLI[id].needs}</p>);
    }
    const meta = page ? p.models : [BILLING[p.billing], p.models].filter(Boolean).join(" · ");
    if (meta) lines.push(<p key="meta">{meta}</p>);
    return lines;
  };

  /** The one action or state on the right of a row. */
  const side = (p: ProviderState, inUse: boolean): { node: ReactNode; text: string } => {
    const name = PROVIDERS[p.id].name;
    const flowLogin = !isKey(p.id) && login?.provider === p.id ? login : null;
    if (editing === p.id) return { node: null, text: "adding a key" };
    if (flowLogin?.status === "waiting") return { node: <span className="mc-state">logging in…</span>, text: "logging in" };
    if (flowLogin?.status === "failed") return { node: <span className="mc-state">login failed</span>, text: "login failed" };
    if (inUse) return { node: <span className="mc-state in-use">in use</span>, text: "in use" };
    if (p.ready && pinned) return { node: <span className="mc-state">ready</span>, text: "ready" };
    if (p.ready)
      return {
        node: (
          <button className="btn small" data-act={`use:${p.id}`} disabled={anyBusy} aria-label={`use ${name}`} onClick={() => void use(p.id)}>
            {busy === `use:${p.id}` ? <Spinner /> : null}
            use
          </button>
        ),
        text: "ready",
      };
    if (isKey(p.id)) {
      const id = p.id;
      return {
        node: (
          <button className="btn small" data-act={`edit:${id}`} disabled={anyBusy} aria-label={`add ${name}`} onClick={() => startEdit(id)}>
            add key
          </button>
        ),
        text: "not set up",
      };
    }
    const id = p.id;
    if (p.installed === false) return { node: <span className="mc-state">install first</span>, text: `install ${CLI[id].name} first` };
    const other = waiting && login?.provider !== id;
    return {
      node: (
        <button
          className="btn small"
          data-act={`login:${id}`}
          disabled={anyBusy || other}
          aria-label={`log in with your ${name}`}
          title={other ? "finish or cancel the other login first" : undefined}
          onClick={() => doLogin(id)}
        >
          {busy === `login:${id}` ? (
            <>
              <Spinner /> starting…
            </>
          ) : (
            "log in"
          )}
        </button>
      ),
      text: "not set up",
    };
  };

  const row = (p: ProviderState) => {
    const id = p.id;
    const active = view.active === id;
    const inUse = active && p.ready;
    const broken = active && view.chosen != null && !p.ready;
    const open = expanded === id;
    const err = errors[id];
    const s = side(p, inUse);
    const sub = !isKey(id) ? (id as SubProvider) : null;
    const flowLogin = sub && login?.provider === sub ? loginBlock(sub) : null;
    const flow = editing === id ? keyForm(id as KeyProvider, p) : confirming === id ? confirmRemove(p as ProviderState & { id: KeyProvider }) : flowLogin;
    const hint = isKey(id) && p.ready && p.hint ? p.hint : null;
    const label = `${PROVIDERS[id].short} — ${broken ? "chosen, not set up" : s.text}${hint ? `, key ${hint}` : ""}`;
    return (
      <li key={id} className={`mc-row${open ? " open" : ""}${inUse ? " in-use" : ""}${page ? " mc-card" : ""}`} id={`model-row-${id}`}>
        <div className="mc-line">
          <button
            type="button"
            className="mc-head"
            id={`model-head-${id}`}
            aria-expanded={open}
            aria-controls={open ? `model-detail-${id}` : undefined}
            aria-label={label}
            aria-describedby={page ? `model-blurb-${id}` : undefined}
            ref={(el) => {
              heads.current[id] = el;
            }}
            onClick={() => toggle(id)}
          >
            <span className={`model-dot${p.ready ? " on" : broken ? " warn" : ""}`} aria-hidden />
            <span className="mc-text">
              <span className="mc-name-line">
                <span className="mc-name">{LABEL[id]}</span>
                {hint && <span className="mc-hint-inline">{hint}</span>}
              </span>
            </span>
          </button>
          {s.node && <span className="mc-side">{s.node}</span>}
          <span className="mc-chev" aria-hidden>
            <ChevronDown />
          </span>
        </div>
        {page && (
          // Under the name (clicking it opens the row too); on a phone it runs under the action.
          <p className="mc-blurb" id={`model-blurb-${id}`}>
            {!sub || p.installed !== false || p.ready ? BLURB[id] : `included in your plan · install ${CLI[sub].name} first`}
          </p>
        )}
        {open && (
          <div className="mc-detail" id={`model-detail-${id}`}>
            {flow ?? details(p)}
          </div>
        )}
        {err && (
          <p className="model-error mc-err" id={`model-err-${id}`} role="alert">
            {err}
          </p>
        )}
      </li>
    );
  };

  // Something is chosen that isn't set up: say so once, with the way out when there is one.
  const firstReady = providers.find((p) => p.ready);
  const banner =
    !pinned && view.chosen !== null && !activeState?.ready ? (
      <div className="mc-banner">
        <span>
          {PROVIDERS[view.active].name} is chosen but {isKey(view.active) ? "has no key" : "isn't logged in"}.
        </span>
        {firstReady && (
          <button className="btn small" disabled={anyBusy} onClick={() => void use(firstReady.id)}>
            {busy === `use:${firstReady.id}` ? <Spinner /> : null}
            use {LABEL[firstReady.id]}
          </button>
        )}
      </div>
    ) : null;

  const usingName = activeState?.ready ? PROVIDERS[view.active].short : null;
  const foot = pinned ? (
    <p className="mc-foot mc-pinned">
      <code>YAGAMI_PROVIDER={view.chosen}</code> in your shell picks the model — unset it to choose here.
    </p>
  ) : page ? null : (
    <div className="mc-foot">
      <span className="mc-auto" id="model-auto-label">
        automatic
        <span className="mc-auto-state" id="model-auto-state">
          {" "}
          · {auto ? (usingName ? `using ${usingName}` : "nothing connected yet") : "off"}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        className="mc-switch"
        aria-checked={auto}
        aria-label="pick automatically"
        aria-describedby="model-auto-state"
        // Disabled while the change is saved (focus drops): it comes back here after.
        ref={(el) => {
          heads.current.auto = el;
        }}
        title={auto ? "on: uses the first one that's set up" : "off: uses the one you picked"}
        // Turning it off keeps what it picked; with nothing set up there's nothing to keep.
        disabled={anyBusy || (auto && !activeState?.ready)}
        onClick={() => void run("use:auto", "auto", () => chooseProvider(auto ? view.active : null))}
      >
        <span className="mc-switch-knob" />
      </button>
    </div>
  );

  return (
    <div className={`mc${page ? " mc-page" : ""}`} ref={root}>
      {banner}
      {GROUPS.map((g) => (
        <section key={g.id} className="mc-group" aria-labelledby={`model-group-${g.id}`}>
          <h3 className="mc-group-label" id={`model-group-${g.id}`}>
            {g.label}
          </h3>
          <ul className="mc-list">{g.ids.map((id) => byId(id)).filter((p): p is ProviderState => !!p).map(row)}</ul>
        </section>
      ))}
      {foot}
      {errors.auto && (
        <p className="model-error mc-err" role="alert">
          {errors.auto}
        </p>
      )}
    </div>
  );
}
