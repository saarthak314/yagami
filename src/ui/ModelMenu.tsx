// Header button + panel for model access: which provider builds use, API keys pasted here
// (checked with the provider, saved by the local server) and subscription logins (the official
// CLIs' flows, run by the server). Only shown when the build server is there.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  MODELS_CHANGED,
  OPEN_MODELS,
  PROVIDERS,
  cancelLogin,
  chooseProvider,
  getModels,
  modelGap,
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
import { Check, Cross, Spinner } from "./icons";

type KeyProvider = "anthropic" | "openai";

const BILLING = { api: "pay per use", subscription: "uses your plan" } as const;
const ENV_VAR: Record<KeyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const KEY_PAGE: Record<KeyProvider, { href: string; text: string }> = {
  anthropic: { href: "https://console.anthropic.com/settings/keys", text: "console.anthropic.com" },
  openai: { href: "https://platform.openai.com/api-keys", text: "platform.openai.com/api-keys" },
};
const CLI: Record<SubProvider, { name: string; needs: string; install: string; login: string; logout: string; site: string }> = {
  "claude-sub": { name: "claude code", needs: "needs claude code and a claude plan", install: "npm i -g @anthropic-ai/claude-code", login: "claude auth login", logout: "claude auth logout", site: "claude.ai" },
  "openai-sub": { name: "codex", needs: "needs codex and a chatgpt plan", install: "npm i -g @openai/codex", login: "codex login", logout: "codex logout", site: "chatgpt.com" },
};
const isKey = (id: ProviderId): id is KeyProvider => id === "anthropic" || id === "openai";
const message = (e: unknown, fallback = "something went wrong") => (e instanceof ApiError ? e.message : fallback);

/** Short name of a provider, for the header button ("claude plan"). */
export const shortName = (id: string | undefined) => (id && id in PROVIDERS ? PROVIDERS[id as ProviderId].short : "model");

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
  const [editing, setEditing] = useState<KeyProvider | null>(null);
  const [confirming, setConfirming] = useState<KeyProvider | null>(null);
  const [keyText, setKeyText] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  /** The sign-in tab couldn't be opened (popup blocked): the link is shown prominently. */
  const [blocked, setBlocked] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Where focus goes back to on close (the header button, or the uploader's "connect a model"). */
  const returnTo = useRef<HTMLElement | null>(null);
  const rows = useRef<Partial<Record<string, HTMLElement | null>>>({});
  const focusRow = useRef<string | null>(null);
  /** A control to focus once it's rendered and enabled (after an async action). */
  const want = useRef<{ sel: string; select?: boolean } | null>(null);
  const [, rerender] = useState(0);
  const focusSoon = (sel: string, select = false) => {
    want.current = { sel, select };
    rerender((n) => n + 1);
  };
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
        const ready = v.providers.find((p) => p.id === v.active)?.ready ?? false;
        if (h && (h.provider !== v.active || h.credentials !== ready)) announceChange();
      }
    } catch (e) {
      if (g === gen.current) setLoadError(message(e, "couldn't reach yagami"));
    }
  }, []);

  // Loaded up front: the panel opens with its rows (no "loading…" jump), and the header can say
  // which provider is chosen.
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

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setEditing(null);
    setConfirming(null);
    setKeyText("");
    setErrors({});
    want.current = null;
    // A finished login has nothing more to say; a waiting one keeps going (and polling), and keeps
    // its "open the sign-in page" link for when the panel opens again.
    const v = viewRef.current;
    if (v?.login?.status !== "waiting") setBlocked(false);
    if (v?.login && v.login.status !== "waiting") {
      gen.current++;
      setView({ ...v, login: null });
      void cancelLogin().catch(() => {});
    }
    // Back to what opened the panel; the header button when that's gone (a "connect a model" that went away).
    const back = returnTo.current?.isConnected ? returnTo.current : opener.current;
    if (refocus) back?.focus({ preventScroll: true });
  }, []);

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

  // After a change removes the focused control (a "use this" that became "in use"), keep focus in its row.
  useEffect(() => {
    if (!open || busy) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const r = focusRow.current && rows.current[focusRow.current];
    (r || panel.current)?.focus({ preventScroll: true });
  }, [view, busy, open, editing, confirming]);

  // Then the control an action asked for, once it's there and enabled (after the effect above).
  useEffect(() => {
    const w = want.current;
    if (!w || !open) return;
    // "a || b": the first that's there (waiting while it's disabled).
    let el: HTMLElement | null = null;
    for (const sel of w.sel.split(" || ")) if ((el = panel.current?.querySelector<HTMLElement>(sel) ?? null)) break;
    if (!el || (el as HTMLButtonElement).disabled) return;
    want.current = null;
    el.focus();
    if (w.select && el instanceof HTMLInputElement) el.select();
  });

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

  // A refused code: back to the code field, selected, to paste the right one.
  const refused = login?.codeError ?? null;
  useEffect(() => {
    if (refused && open) focusSoon("#model-code", true);
  }, [refused]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- the header button
  const gap = modelGap(health, view);
  const ok = !!health?.credentials;
  const label = waiting ? "logging in…" : ok ? shortName(health?.provider) : gap?.id ? `${PROVIDERS[gap.id].short} · not set up` : "connect a model";
  const ariaLabel = `model: ${ok ? shortName(health?.provider) : gap?.id ? `${PROVIDERS[gap.id].name} chosen, not set up` : "none connected — connect a model"}${waiting ? ", a login is waiting" : ""}`;

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
      const l = v?.login?.provider === id ? v.login : null;
      const url = l?.status === "waiting" ? l.url : null;
      if (tab && url) tab.location.href = url;
      else tab?.close();
      if (l?.status === "waiting") focusSoon(!tab ? ".model-link" : id === "claude-sub" ? "#model-code" : ".model-link");
    });
  };

  const cancelEdit = (id: KeyProvider) => {
    setEditing(null);
    setKeyText("");
    setErrors((e) => ({ ...e, [id]: undefined }));
    focusSoon(`[data-act="edit:${id}"]`);
  };

  const submitKey = async (id: KeyProvider) => {
    const key = keyText.trim();
    if (!key) return setErrors((e) => ({ ...e, [id]: "paste a key" }));
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

  const providers = view?.providers ?? [];
  const activeState = providers.find((p) => p.id === view?.active);
  const pinned = !!view?.pinned;
  const anyBusy = busy !== null;

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

  const keyForm = (id: KeyProvider) => {
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
        <label className="model-label" htmlFor={`model-key-${id}`}>
          paste your key
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
          checked with {id} (free), then saved on this computer only.
        </span>
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

  const loginBlock = (id: SubProvider) => {
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
            <button
              className="btn ghost small"
              disabled={anyBusy}
              onClick={() => void run("cancel", id, cancelLogin).then(() => focusSoon(`[data-act="login:${id}"] || #model-row-${id}`))}
            >
              dismiss
            </button>
          </div>
        </div>
      );
    }
    const sending = busy === "code";
    const link = login.url && (
      <a className={`btn small${blocked ? " primary" : ""} model-link`} href={login.url} target="_blank" rel="noreferrer">
        {blocked ? "open the sign-in page" : "sign-in page"} ↗
      </a>
    );
    const cancel = (
      <div className="model-actions">
        <button
          className="btn ghost small"
          disabled={busy === "cancel"}
          onClick={() =>
            void run("cancel", id, cancelLogin).then(() => {
              setBlocked(false);
              focusSoon(`[data-act="login:${id}"]`);
            })
          }
        >
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
          <p className="model-note">{blocked ? "open the sign-in page and sign in with chatgpt." : "sign in on the chatgpt page that opened."} this finishes by itself.</p>
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
                sign in on claude.ai{blocked ? "" : <span className="model-step-hint"> (opened in a new tab)</span>}
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
                if (!code.trim()) return;
                void run("code", id, () => sendLoginCode(code.trim()));
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
                  value={code}
                  readOnly={sending}
                  aria-busy={sending}
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

  /** The one place a row's buttons go (top right). */
  const actions = (p: ProviderState, inUse: boolean) => {
    const name = PROVIDERS[p.id].name;
    const out: React.ReactNode[] = [];
    if (p.ready && !inUse && !pinned)
      out.push(
        <button key="use" className="btn small model-use" disabled={anyBusy} aria-label={`use ${name}`} onClick={() => void run(`use:${p.id}`, p.id, () => chooseProvider(p.id))}>
          {busy === `use:${p.id}` ? <Spinner /> : null}
          use this
        </button>,
      );
    // The main action on a line of its own, key management under it.
    if (out.length && isKey(p.id) && p.source === "saved") out.push(<span key="break" className="model-break" aria-hidden />);
    if (isKey(p.id) && p.source !== "env") {
      const id = p.id;
      const edit = () => {
        setEditing(id);
        setConfirming(null);
        setKeyText("");
      };
      if (p.source === "saved") {
        out.push(
          <button key="replace" className="btn small" data-act={`edit:${id}`} disabled={anyBusy} aria-label={`replace ${name}`} onClick={edit}>
            replace
          </button>,
          <button
            key="remove"
            className="btn ghost small model-remove"
            data-act={`remove:${id}`}
            disabled={anyBusy}
            aria-label={`remove ${name}`}
            onClick={() => {
              setConfirming(id);
              focusSoon('[data-act="keep"]');
            }}
          >
            remove
          </button>,
        );
      } else
        out.push(
          <button key="add" className="btn small" data-act={`edit:${id}`} disabled={anyBusy} aria-label={`add ${name}`} onClick={edit}>
            add key
          </button>,
        );
    }
    if (!isKey(p.id) && !p.ready && !(login?.provider === p.id && login.status !== "done")) {
      const id = p.id;
      const other = waiting && login?.provider !== id;
      if (p.installed === false)
        out.push(
          <button key="check" className="btn ghost small" disabled={anyBusy} aria-label={`check again whether ${CLI[id].name} is installed`} onClick={() => void refresh()}>
            check again
          </button>,
        );
      else
        out.push(
          <button
            key="login"
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
          </button>,
        );
    }
    return out.length ? <div className="model-row-actions">{out}</div> : null;
  };

  const status = (p: ProviderState) => {
    if (p.ready) {
      if (p.source === "login") return "connected";
      return `connected${p.hint ? ` · key ${p.hint}` : ""}`;
    }
    let need: React.ReactNode;
    if (isKey(p.id))
      need = (
        <>
          get a key at{" "}
          <a className="model-ext" href={KEY_PAGE[p.id].href} target="_blank" rel="noreferrer">
            {KEY_PAGE[p.id].text} <span aria-hidden>↗</span>
            <span className="sr-only"> (opens a new tab)</span>
          </a>
        </>
      );
    else need = p.installed === false ? `install ${CLI[p.id].name} first` : CLI[p.id].needs;
    return (
      <>
        <span className="sr-only">not set up: </span>
        {need}
      </>
    );
  };

  const row = (p: ProviderState) => {
    const info = PROVIDERS[p.id];
    const active = view?.active === p.id;
    const inUse = active && p.ready;
    const broken = active && view?.chosen != null && !p.ready;
    const err = errors[p.id];
    const editingThis = editing === p.id;
    const confirmingThis = confirming === p.id;
    const sub = !isKey(p.id) ? (p.id as SubProvider) : null;
    const note =
      isKey(p.id) && p.source === "env" ? (
        <>
          set in your shell (<code>{ENV_VAR[p.id]}</code>) — change it there
        </>
      ) : sub && p.ready ? (
        <>
          to sign out: <code>{CLI[sub].logout}</code>
        </>
      ) : null;
    return (
      <li
        key={p.id}
        id={`model-row-${p.id}`}
        className={`model-row${inUse ? " in-use" : ""}${broken ? " broken" : ""}`}
        tabIndex={-1}
        aria-labelledby={`model-name-${p.id}`}
        ref={(el) => {
          rows.current[p.id] = el;
        }}
      >
        <div className="model-row-head">
          <span className={`model-dot${p.ready ? " on" : broken ? " warn" : ""}`} aria-hidden />
          <span className="model-name" id={`model-name-${p.id}`}>
            {info.name}
          </span>
          {inUse ? (
            <span className="tag in-use">{view?.chosen === null ? "in use · auto" : "in use"}</span>
          ) : broken ? (
            <span className="tag chosen">chosen</span>
          ) : null}
        </div>
        {!editingThis && !confirmingThis && actions(p, inUse)}
        <div className={p.ready ? "model-status" : "model-status off"}>{status(p)}</div>
        {sub && !p.ready && p.installed === false && !(login?.provider === sub && login.status === "failed") && installLine(sub)}
        <div className="model-meta">
          {BILLING[p.billing]}
          {p.models ? ` · ${p.models}` : ""}
        </div>
        {note && <div className="model-note">{note}</div>}
        {editingThis && isKey(p.id) && keyForm(p.id)}
        {confirmingThis && isKey(p.id) && confirmRemove(p as ProviderState & { id: KeyProvider })}
        {sub && loginBlock(sub)}
        {err && (
          <p className="model-error" id={`model-err-${p.id}`} role="alert">
            {err}
          </p>
        )}
      </li>
    );
  };

  const auto = view?.chosen === null;
  const firstReady = providers.find((p) => p.ready);
  let banner: React.ReactNode = null;
  if (view && pinned)
    banner = (
      <p className="model-banner info">
        <span>
          <code>YAGAMI_PROVIDER={view.chosen}</code> in your shell picks the model — unset it to choose here.
        </span>
      </p>
    );
  else if (view && !activeState?.ready) {
    if (view.chosen !== null)
      banner = (
        <div className="model-banner">
          <span>
            {PROVIDERS[view.active].name} is chosen but {isKey(view.active) ? "has no key" : "isn't logged in"}.
          </span>
          {firstReady && (
            <button className="btn small" disabled={anyBusy} onClick={() => void run(`use:${firstReady.id}`, firstReady.id, () => chooseProvider(firstReady.id))}>
              {busy === `use:${firstReady.id}` ? <Spinner /> : null}
              use {PROVIDERS[firstReady.id].short}
            </button>
          )}
        </div>
      );
    else banner = <p className="model-banner info">no model connected yet — log in with a plan you already have, or add an api key.</p>;
  }

  return (
    <div className="model-wrap" ref={wrap}>
      <button
        ref={opener}
        className={`btn model-btn${ok ? "" : " cta"}`}
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
          {ok || waiting ? <ChipIcon /> : "connect"}
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
            <span className="model-title" id="model-panel-title">
              choose a model
            </span>
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
              <>
                <span className="sr-only" role="status">
                  loading…
                </span>
                <ul className="model-list" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <li key={i} className="model-row model-skel">
                      <span className="skel static skel-line" style={{ width: `${46 - i * 4}%` }} />
                      <span className="skel static skel-line short" />
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : (
            <>
              {banner}
              <ul className="model-list" aria-label="models">
                {providers.map(row)}
                {!pinned && (
                  <li
                    className="model-row model-auto"
                    id="model-row-auto"
                    tabIndex={-1}
                    aria-labelledby="model-name-auto"
                    ref={(el) => {
                      rows.current.auto = el;
                    }}
                  >
                    <div className="model-row-head">
                      <span className={`model-dot auto${auto && activeState?.ready ? " picked" : ""}`} aria-hidden />
                      <span className="model-name" id="model-name-auto">
                        pick automatically
                      </span>
                    </div>
                    {!auto && (
                      <div className="model-row-actions">
                        <button className="btn ghost small" disabled={anyBusy} aria-label="pick automatically" onClick={() => void run("use:auto", "auto", () => chooseProvider(null))}>
                          {busy === "use:auto" ? <Spinner /> : null}
                          use this
                        </button>
                      </div>
                    )}
                    <div className="model-status">
                      {auto ? (activeState?.ready ? `on · using ${PROVIDERS[view.active].name}` : "on · nothing connected yet") : "the first connected one, top to bottom"}
                    </div>
                    {errors.auto && (
                      <p className="model-error" role="alert">
                        {errors.auto}
                      </p>
                    )}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
