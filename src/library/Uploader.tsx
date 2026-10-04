// Add a book from the library page: drop a PDF (anywhere on the window) or choose
// one → upload → what's in it → chapters (books) → build. The build itself runs
// on the yagami server; this only starts it and hands over to the progress view.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, estimate, isTouch, missingPrereqs, startBuild, upload, type Health, type UploadInfo } from "../lib/api";
import { isNumbered, planFor } from "../lib/data";
import { buildHash, hashFor } from "../lib/route";
import { Cross, Spinner, UploadIcon } from "../ui/icons";

const MAX_BYTES = 300 * 1024 * 1024;

type State =
  | { s: "idle" }
  | { s: "uploading"; name: string; size: number; f: number }
  | { s: "error"; message: string; name?: string }
  | { s: "ready"; name: string; upload: string; info: UploadInfo; picked: string[]; starting?: boolean; startError?: string };

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} kb` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} mb`);
const chapterLabel = (u: { id: string; title: string }) => (isNumbered(u.id) && !u.title.startsWith(u.id) ? `${u.id}. ${u.title}` : u.title);
const pageCount = (u: { pages: [number, number] }) => u.pages[1] - u.pages[0] + 1;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why building can't start on this server for this file (or null). */
export function blockedReason(health: Health | null | undefined, kind?: "text" | "scanned"): string | null {
  const m = missingPrereqs(health).filter((x) => !x.scansOnly || kind === "scanned");
  if (!m.length) return null;
  return `can't build yet — missing ${m.map((x) => `${x.what} (${x.how})`).join(", ")}`;
}

/**
 * Chapters picked by default (new chapters only; built ones are locked in): for a new
 * book everything when short, else the first three; for an existing book none.
 */
function defaultPick(info: UploadInfo): string[] {
  if (info.existing) return [];
  if (info.units.length <= 6) return info.units.map((u) => u.id);
  const numbered = info.units.filter((u) => isNumbered(u.id));
  return (numbered.length ? numbered : info.units).slice(0, 3).map((u) => u.id);
}

/** Quiet list of what's missing for building, shown up front (before any upload). */
function Prereqs({ health }: { health: Health | null | undefined }) {
  const m = missingPrereqs(health);
  if (!m.length) return null;
  return (
    <ul className="prereqs" aria-label="missing for building">
      {m.map((x) => (
        <li key={x.what}>
          <span className="prereq-what">{x.what} missing{x.scansOnly ? " (only for scanned pdfs)" : ""}</span>
          <code>{x.how}</code>
        </li>
      ))}
    </ul>
  );
}

export function Uploader({ health, prominent = false }: { health: Health | null | undefined; prominent?: boolean }) {
  const [st, setSt] = useState<State>({ s: "idle" });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const busy = st.s === "uploading" || (st.s === "ready" && st.starting);
  const touch = isTouch();

  const take = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files) : [];
      if (!list.length || busy) return;
      if (list.length > 1) return setSt({ s: "error", message: "one pdf at a time" });
      const file = list[0];
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return setSt({ s: "error", name: file.name, message: "not a pdf" });
      if (file.size > MAX_BYTES) return setSt({ s: "error", name: file.name, message: "that file is too large (300 mb max)" });
      if (file.size === 0) return setSt({ s: "error", name: file.name, message: "that file is empty" });
      abort.current = new AbortController();
      setSt({ s: "uploading", name: file.name, size: file.size, f: 0 });
      setAnnounce(`uploading ${file.name}`);
      try {
        const res = await upload(file, (f) => setSt((p) => (p.s === "uploading" ? { ...p, f } : p)), abort.current.signal);
        setSt({ s: "ready", name: file.name, upload: res.upload, info: res.info, picked: defaultPick(res.info) });
        setAnnounce(`${res.info.title}: ${res.info.pages} pages`);
      } catch (e) {
        const message = e instanceof ApiError ? e.message : "upload failed";
        setSt(message === "cancelled" ? { s: "idle" } : { s: "error", name: file.name, message });
        if (message !== "cancelled") setAnnounce(message);
      }
    },
    [busy],
  );

  // Drop anywhere on the window while the library is open (also replaces an inspected file).
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? "none" : "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void take(e.dataTransfer?.files ?? null);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [take, busy]);

  // Animate the box's height between states so the library below moves once, smoothly.
  useLayoutEffect(() => {
    const el = box.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [st.s]);

  // Focus the result once a file is inspected; back to the drop zone when closed.
  const prev = useRef(st.s);
  useEffect(() => {
    if (st.s === "ready" && prev.current !== "ready") heading.current?.focus({ preventScroll: true });
    if (st.s === "idle" && prev.current !== "idle") zone.current?.focus({ preventScroll: true });
    prev.current = st.s;
  }, [st.s]);

  const choose = () => input.current?.click();
  const reset = () => {
    abort.current?.abort();
    setSt({ s: "idle" });
  };
  // Escape closes the card (but not while a build is starting).
  const onCardKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !(st.s === "ready" && st.starting)) {
      e.stopPropagation();
      reset();
    }
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="application/pdf,.pdf"
      aria-label="choose a pdf"
      hidden
      onChange={(e) => {
        void take(e.currentTarget.files);
        e.currentTarget.value = "";
      }}
    />
  );

  let body: React.ReactNode;
  if (st.s === "idle" || st.s === "error") {
    body = (
      <div>
        <div
          ref={zone}
          className={`dropzone${dragging ? " dragging" : ""}${prominent ? " prominent" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={touch ? "add a book: choose a pdf" : "add a book: drop a pdf, or choose a file"}
          onClick={choose}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose();
            }
          }}
        >
          <span className="dz-icon">
            <UploadIcon />
          </span>
          <span className="dz-text">
            {dragging ? (
              "drop to add it to your library"
            ) : touch ? (
              <span className="dz-link">choose a pdf</span>
            ) : (
              <>
                drop a pdf, or <span className="dz-link">choose a file</span>
              </>
            )}
          </span>
          <span className="dz-sub">a paper or a textbook becomes a reader with live demos</span>
        </div>
        {st.s === "error" && (
          <p className="upload-error" role="alert">
            <span>
              {st.name && <span className="upload-file">{st.name}</span>}
              {st.message}
            </span>
            <button className="btn ghost small" onClick={reset}>
              dismiss
            </button>
          </p>
        )}
        <Prereqs health={health} />
      </div>
    );
  } else if (st.s === "uploading") {
    const done = st.f >= 1;
    body = (
      <div className="upload-card" onKeyDown={onCardKey}>
        <div className="upload-row">
          <span className="upload-name">{st.name}</span>
          <span className="upload-size">{mb(st.size)}</span>
          <button className="btn icon ghost" aria-label="cancel upload" title="cancel" onClick={reset}>
            <Cross />
          </button>
        </div>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(st.f * 100)} aria-label="upload">
          <span style={{ width: `${Math.round(st.f * 100)}%` }} />
        </div>
        <p className="upload-status">
          <Spinner />
          {done ? "reading the pdf…" : `uploading ${Math.round(st.f * 100)}%`}
        </p>
        {/* Stand-ins for what's coming (title, meta, note, actions): the card won't jump when it arrives. */}
        <div className="upload-skel" aria-hidden>
          <span className="skel static skel-line" style={{ width: "62%" }} />
          <span className="skel static skel-line short" />
          <span className="skel static skel-btn" />
        </div>
      </div>
    );
  } else {
    body = <Ready st={st} setSt={setSt} health={health} heading={heading} reset={reset} onKeyDown={onCardKey} dragging={dragging} />;
  }

  return (
    <div className="uploader">
      {fileInput}
      <div className="upload-box" ref={box} style={height !== null ? { height } : undefined}>
        {body}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {dragging && <div className="drop-overlay" aria-hidden />}
    </div>
  );
}

function Ready({
  st,
  setSt,
  health,
  heading,
  reset,
  onKeyDown,
  dragging,
}: {
  st: Extract<State, { s: "ready" }>;
  setSt: React.Dispatch<React.SetStateAction<State>>;
  health: Health | null | undefined;
  heading: React.RefObject<HTMLHeadingElement | null>;
  reset: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  dragging: boolean;
}) {
  const { info } = st;
  const multi = info.units.length > 1;
  const existing = info.existing;
  const blocked = blockedReason(health, info.kind);
  const picked = new Set(st.picked);
  const fresh = info.units.filter((u) => !u.built);
  const chosen = fresh.filter((u) => picked.has(u.id));
  const pages = chosen.reduce((n, u) => n + pageCount(u), 0);
  const fullyBuilt = !!existing && fresh.length === 0;
  const demos = existing ? info.units.reduce((n, u) => n + (planFor(`${existing}/${u.id}`)?.demos.length ?? 0), 0) : 0;
  const toggle = (id: string) => setSt((p) => (p.s === "ready" ? { ...p, picked: p.picked.includes(id) ? p.picked.filter((x) => x !== id) : [...p.picked, id] } : p));
  const allNew = fresh.length > 0 && chosen.length === fresh.length;
  const units = multi ? chosen.length : 1;
  const build = async () => {
    if (st.starting) return;
    setSt({ ...st, starting: true, startError: undefined });
    try {
      const res = await startBuild(st.upload, multi ? chosen.map((u) => u.id) : undefined);
      location.hash = buildHash(res.job);
    } catch (e) {
      setSt((p) => (p.s === "ready" ? { ...p, starting: false, startError: e instanceof ApiError ? e.message : "couldn't start the build" } : p));
    }
  };
  const label = multi
    ? chosen.length === 0
      ? existing
        ? "choose chapters to add"
        : "choose chapters"
      : `build ${plural(chosen.length, existing ? "new chapter" : "chapter")}`
    : "build";

  return (
    <div className={`upload-card${dragging ? " dragging" : ""}`} onKeyDown={onKeyDown}>
      <div className="upload-head">
        <div className="upload-titles">
          <h2 className="upload-title" tabIndex={-1} ref={heading}>
            {info.title}
          </h2>
          {info.author && <span className="upload-author">{info.author}</span>}
          <span className="upload-meta">
            {info.pages} pages · {multi ? `${info.units.length} chapters` : "paper"} · {info.kind === "scanned" ? "scanned pdf" : "text pdf"}
          </span>
        </div>
        <button className="btn icon ghost" aria-label="close" title="close (esc)" onClick={reset} disabled={st.starting}>
          <Cross />
        </button>
      </div>
      {dragging && <p className="upload-note">drop to replace this file</p>}

      {fullyBuilt ? (
        <>
          <p className="upload-note">already in your library — fully built{demos ? `, ${plural(demos, "demo")}` : ""}.</p>
          <div className="upload-actions">
            <a className="btn primary" href={hashFor({ book: existing })}>
              open it
            </a>
          </div>
        </>
      ) : (
        <>
          {multi && (
            <fieldset className="picker">
              <legend className="picker-head">
                <span>chapters</span>
                <span className="picker-count">
                  {existing ? `${info.units.length - fresh.length} built · ` : ""}
                  {chosen.length} {existing ? "new" : `of ${info.units.length}`} selected{pages ? ` · ${pages} pages` : ""}
                </span>
                {fresh.length > 0 && (
                  <button type="button" className="btn ghost small" onClick={() => setSt({ ...st, picked: allNew ? [] : fresh.map((u) => u.id) })}>
                    {allNew ? "none" : existing ? "all new" : "all"}
                  </button>
                )}
              </legend>
              <ul className="picker-list">
                {info.units.map((u) => (
                  <li key={u.id}>
                    <label className={`${u.built || picked.has(u.id) ? "on" : ""}${u.built ? " locked" : ""}`}>
                      <input type="checkbox" className="check" checked={u.built || picked.has(u.id)} disabled={u.built} onChange={() => toggle(u.id)} />
                      <span className="picker-title">{chapterLabel(u)}</span>
                      <span className="picker-built">{u.built ? "built" : ""}</span>
                      <span className="picker-pages">
                        pp. {u.pages[0]}–{u.pages[1]}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <p className="upload-note">
            {existing && !multi
              ? "already in your library — continuing builds only what's missing. "
              : existing
                ? "built chapters stay as they are. "
                : ""}
            {units > 0 || !multi
              ? `building uses the anthropic api: ${estimate(units)} for ${multi ? plural(units, existing ? "new chapter" : "chapter") : "this paper"}. you can stop it any time.`
              : "building uses the anthropic api — about $2 per chapter."}
          </p>
          {blocked && (
            <p className="upload-blocked" role="alert">
              {blocked}
            </p>
          )}
          {st.startError && (
            <p className="upload-blocked" role="alert">
              {st.startError}
            </p>
          )}
          <div className="upload-actions">
            <button className="btn primary" onClick={build} disabled={!!blocked || st.starting || (multi && chosen.length === 0)}>
              {st.starting ? (
                <>
                  <Spinner /> starting…
                </>
              ) : existing && !multi ? (
                "continue building"
              ) : (
                label
              )}
            </button>
            <button className="btn ghost" onClick={reset} disabled={st.starting}>
              cancel
            </button>
            {existing && (
              <a className="btn ghost" href={hashFor({ book: existing })}>
                open it
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
