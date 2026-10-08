// `#/build/<job>`: a build (or fix) as it happens — pages → plan → each demo with a
// state word, like the CLI. Reattaches after a reload: the server replays the job.
// One animation at a time: the spinner in the status line.

import { useEffect, useRef, useState } from "react";
import type { Library } from "../types";
import { ApiError, continueBook, JOB_GONE, onPlan, startFix, stopJob, useModelsView, type Health, type JobSummary } from "../lib/api";
import { isActive, phaseWord, shortReason, useJob, type JobDemo, type JobUnit } from "../lib/job";
import { assetUrl, isNumbered, loadUnit, planFor } from "../lib/data";
import { buildHash, hashFor } from "../lib/route";
import { Check, Cross, Spinner } from "../ui/icons";
import { blockedReason, ConnectButton } from "../library/Uploader";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a run cost: dollars on an api key; on a subscription nothing is charged, so no "$0.00". */
const money = (cost: number, health: Health | null | undefined) => (cost === 0 && onPlan(health) ? "on your plan" : `$${cost.toFixed(2)}`);

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Re-render every second while running (for the elapsed time). */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** Section to open a demo at: the section of its first step's paragraph ("3.2.1-p4" → "3.2.1"). */
function demoSection(book: string, unit: string, demo: string): string | undefined {
  const anchor = planFor(`${book}/${unit}`)?.demos.find((d) => d.id === demo)?.beats[0]?.anchor;
  return anchor?.replace(/-(p\d+|h)$/, "");
}

/** The book's first page once it exists; a static placeholder until then. */
function BuildCover({ slug, unit, ready }: { slug: string; unit?: string; ready: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!ready || !unit) return;
    let live = true;
    loadUnit(slug, unit)
      .then((u) => live && u.pages[0] && setSrc(assetUrl(u.pages[0].src)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug, unit, ready]);
  return <div className={`cover build-cover${loaded ? "" : " placeholder"}`}>{src && <img src={src} alt="" decoding="async" onLoad={() => setLoaded(true)} />}</div>;
}

type Outcome = "running" | "stopped" | "failed" | "ok" | "partial";

export function BuildView({ job, library, jobs, health }: { job: string; library: Library; jobs: JobSummary[]; health: Health | null | undefined }) {
  const state = useJob(job);
  const summary = jobs.find((j) => j.job === job);
  const slug = state.slug || summary?.slug || "";
  const book = library.books.find((b) => b.slug === slug);
  const finished = !!state.done || (!!summary && summary.status !== "running");
  const isFix = summary?.kind === "fix";
  useTick(!finished);

  const demos = state.demos;
  const ready = demos.filter((d) => d.phase === "pass").length;
  const failed = demos.filter((d) => d.phase === "fail");
  const stopped = summary?.status === "stopped" || state.done?.failures[0] === "stopped";
  // A run that ended before making any demo: its reason is the only failure.
  const runError = finished && !stopped && demos.length === 0 ? (state.done?.failures[0] ?? state.error ?? (summary?.status === "failed" ? "the build failed" : null)) : null;
  const outcome: Outcome = !finished ? "running" : stopped ? "stopped" : runError ? "failed" : failed.length ? "partial" : "ok";
  const planning = !isFix && state.units.some((u) => u.plan !== "done" && u.plan !== "error");
  const pagesReady = !!book || !!summary?.pagesReady || state.units.some((u) => u.pages === "done");
  const firstUnit = state.units.find((u) => u.pages === "done")?.id ?? state.units[0]?.id ?? book?.units[0]?.id;
  const elapsed = summary ? (summary.endedAt ?? Date.now()) - summary.startedAt : state.done ? state.done.seconds * 1000 : 0;
  const cost = state.done?.cost ?? (state.cost || summary?.cost || 0);
  const title = state.title || summary?.title || "";
  const multi = state.units.length > 1;

  useEffect(() => {
    const word = { running: isFix ? "fixing" : "building", stopped: "stopped", failed: "failed", ok: isFix ? "fixed" : "built", partial: "built" }[outcome];
    document.title = `${word}${title ? ` · ${title}` : ""} · yagami`;
  }, [outcome, isFix, title]);

  // Focus the title when the view opens (after "build"), and again when the run ends (after "stop").
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [!!title, finished]); // the ref target changes only with these

  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const models = useModelsView();
  // Something here needs a model (resume / retry, or fixing a failed demo): say why it can't, visibly.
  const canResume = finished && !isFix && (outcome === "stopped" || outcome === "failed");
  const wantsModel = canResume || (finished && !!book && failed.length > 0);
  const blocked = blockedReason(health, undefined, models, canResume ? "build" : "fix");

  const resume = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      const res = await continueBook(slug, state.units.map((u) => u.id));
      location.hash = buildHash(res.job);
    } catch (e) {
      setActionError(e instanceof ApiError ? (/no book/.test(e.message) ? "this book wasn't created yet — add the same pdf again from the library" : e.message) : "couldn't start it");
      setRetrying(false);
    }
  };

  // Waiting for another build: nothing of this one has started yet.
  const queued = outcome === "running" && !state.kind && !!state.note;
  // The one status line (sticky): "building · 3/6 ready · 4m 12s · $0.84 so far". A fix has one demo: no counts.
  const counts = demos.length && !isFix ? (planning ? `${ready} ready · planning…` : `${ready}/${demos.length} ready${failed.length && finished ? ` · ${failed.length} ${failed.length === 1 ? "needs" : "need"} a fix` : ""}`) : null;
  // No "$0.00" before anything is spent (or when nothing was); on a plan it says so instead.
  const showCost = cost > 0 || onPlan(health);
  // One hint under the actions, for the state the run is in (the model note replaces it when it applies).
  const hint =
    outcome === "running"
      ? book && pagesReady
        ? "it keeps running if you close this tab — open the book any time."
        : "it keeps running if you close this tab."
      : outcome === "stopped"
        ? "finished demos are kept — resume picks up where it stopped."
        : outcome === "partial" && book
          ? isFix
            ? "still wrong? describe what you see with fix."
            : "describe what's wrong with a failed demo and yagami revises it."
          : null;
  const showBlocked = wantsModel && !!blocked;
  // The run's own reason, unless the model note already says it.
  const reason = runError && !(showBlocked && blocked?.includes(shortReason(runError))) ? shortReason(runError) : null;
  const statusWord = {
    running: queued ? "queued" : isFix ? "fixing" : "building",
    stopped: "stopped",
    failed: "failed",
    ok: isFix ? "fixed" : "done",
    partial: isFix ? "not fixed" : "done",
  }[outcome];
  const fixedDemo = isFix ? demos[0] : undefined;
  const fixedSection = fixedDemo && slug ? demoSection(slug, fixedDemo.unit, fixedDemo.id) : undefined;

  if (state.error === JOB_GONE && !summary) {
    return (
      <main className="library build">
        <div className="library-inner">
          <a className="back" href="#/">
            ← library
          </a>
          <h1 className="build-title" tabIndex={-1} ref={titleRef}>
            this build isn't known any more
          </h1>
          <p className="build-hint">it may have finished before yagami restarted. books it made are in the library.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="library build">
      <div className={`build-bar ${outcome}`} role="status" aria-live="polite">
        <span className="build-bar-state">
          {outcome === "running" ? <Spinner /> : outcome === "ok" ? <Check /> : outcome === "stopped" ? <span className="dash" aria-hidden /> : <Cross />}
          {statusWord}
        </span>
        {counts && <span>{counts}</span>}
        <span>{duration(elapsed)}</span>
        {showCost && (
          <span>
            {money(cost, health)}
            {outcome === "running" && !(cost === 0 && onPlan(health)) ? " so far" : ""}
          </span>
        )}
      </div>
      <div className="library-inner">
        <a className="back" href="#/">
          ← library
        </a>
        <header className="build-head">
          {!isFix && <BuildCover slug={slug} unit={firstUnit} ready={pagesReady && !!book} />}
          <div className="build-head-text">
            {title ? (
              <h1 className="build-title" tabIndex={-1} ref={titleRef}>
                {title}
              </h1>
            ) : (
              <span className="skel static skel-title" aria-hidden />
            )}
            <p className="build-meta">
              {queued ? (
                <>{state.note}</>
              ) : state.kind ? (
                isFix ? (
                  <>{book ? `fix · ${book.title}` : "fix"}</>
                ) : (
                  <>
                    {multi ? plural(state.units.length, "chapter") : "paper"} · {state.kind === "scanned" ? "scanned pdf" : "text pdf"}
                  </>
                )
              ) : (
                <span className="skel static skel-line" aria-hidden />
              )}
            </p>
            <div className="build-actions">
              {fixedDemo && book && outcome !== "running" ? (
                <a className="btn primary" href={hashFor({ book: slug, unit: fixedDemo.unit, section: fixedSection })}>
                  open the demo
                </a>
              ) : pagesReady && book && firstUnit ? (
                <a className="btn primary" href={hashFor({ book: slug, unit: firstUnit })}>
                  open book
                </a>
              ) : (
                <button className="btn primary" disabled title="pages aren't ready yet">
                  open book
                </button>
              )}
              {outcome === "running" && (
                <button
                  className="btn"
                  disabled={stopping}
                  onClick={async () => {
                    setStopping(true);
                    try {
                      await stopJob(job);
                    } catch (e) {
                      setActionError(e instanceof ApiError ? e.message : "couldn't stop it");
                      setStopping(false);
                    }
                  }}
                >
                  {stopping ? "stopping…" : "stop"}
                </button>
              )}
              {!isFix && (outcome === "stopped" || outcome === "failed") && (
                <button className="btn" onClick={resume} disabled={retrying || !!blocked} aria-describedby={blocked ? "build-blocked" : undefined}>
                  {retrying ? "starting…" : outcome === "stopped" ? "resume" : "retry"}
                </button>
              )}
            </div>
            {reason && <p className="upload-blocked">{reason}</p>}
            {showBlocked ? (
              <p className="upload-blocked" id="build-blocked">
                {blocked}
                <ConnectButton health={health} models={models} />
              </p>
            ) : (
              hint && <p className="build-hint">{hint}</p>
            )}
            {actionError && <p className="upload-blocked">{actionError}</p>}
          </div>
        </header>

        <section className="build-body" aria-busy={outcome === "running"}>
          {state.note && outcome === "running" && !queued && <p className="upload-note">{state.note}</p>}
          {state.units.length === 0 && outcome === "running" && !queued && <SkeletonRows n={2} />}
          {state.units.map((u) => {
            const own = demos.filter((d) => d.unit === u.id);
            return (
              <div key={u.id} className="build-unit">
                {multi && <h2 className="build-unit-title">{unitTitle(book, u.id)}</h2>}
                {!isFix && <UnitSteps u={u} outcome={outcome} />}
                <ul className="build-demos">
                  {own.map((d) => (
                    <DemoRow key={d.id} d={d} slug={slug} finished={finished} health={health} hasBook={!!book} />
                  ))}
                  {!isFix && outcome === "running" && u.plan === "running" && own.length === 0 && <SkeletonRows n={3} asItems />}
                </ul>
              </div>
            );
          })}
          {isFix && demos.length === 0 && outcome === "running" && <SkeletonRows n={1} asItems />}
        </section>
      </div>
    </main>
  );
}

function unitTitle(book: Library["books"][number] | undefined, id: string) {
  const t = book?.units.find((x) => x.id === id)?.title ?? id;
  return isNumbered(id) && !t.startsWith(id) ? `${id}. ${t}` : t;
}

function SkeletonRows({ n, asItems = false }: { n: number; asItems?: boolean }) {
  const rows = Array.from({ length: n }, (_, i) => <span key={i} className="skel static skel-row" style={{ width: `${62 - i * 9}%` }} />);
  return asItems ? (
    <>
      {rows.map((r, i) => (
        <li key={i} className="build-demo skel-item" aria-hidden>
          <span className="glyph">
            <span className="dot" />
          </span>
          {r}
        </li>
      ))}
    </>
  ) : (
    <div className="skel-block" aria-hidden>
      {rows}
    </div>
  );
}

/** One line per chapter for what it's doing before (or instead of) its demos; nothing once pages and plan are done. */
function UnitSteps({ u, outcome }: { u: JobUnit; outcome: Outcome }) {
  const live = outcome === "running";
  // A step that was still going when the run ended didn't finish: show it as not done.
  const as = (s: JobUnit["pages"]): JobUnit["pages"] => (!live && s === "running" ? "pending" : s);
  const pages = as(u.pages);
  const plan = as(u.plan);
  if (pages === "done" && plan === "done") return null;
  const [step, word]: [JobUnit["pages"], string] =
    pages === "error"
      ? ["error", "pages failed"]
      : plan === "error"
        ? ["error", "plan failed"]
        : pages === "running"
          ? ["running", u.progress ? `reading pages · ${u.progress.done}/${u.progress.total}` : "reading pages"]
          : pages === "done" && plan === "running"
            ? ["running", "planning demos"]
            : ["pending", live ? (pages === "done" ? "waiting to plan" : "waiting") : "not started"];
  return (
    <ul className="build-steps">
      <StepRow step={step} word={word} progress={pages === "running" ? u.progress : undefined} />
    </ul>
  );
}

function StepRow({ step, word, progress }: { step: JobUnit["pages"]; word: string; progress?: { done: number; total: number } }) {
  return (
    <li className={`build-step ${step}`}>
      <span className="glyph">{step === "done" ? <Check /> : step === "error" ? <Cross /> : <span className="dot" />}</span>
      <span>{word}</span>
      {progress && progress.total > 0 && (
        <span className="bar small" aria-hidden>
          <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </span>
      )}
    </li>
  );
}

function DemoRow({ d, slug, finished, health, hasBook }: { d: JobDemo; slug: string; finished: boolean; health: Health | null | undefined; hasBook: boolean }) {
  const active = isActive(d) && !finished;
  const word = finished && isActive(d) ? "stopped" : phaseWord(d);
  const [fixing, setFixing] = useState(false);
  const [problem, setProblem] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const blocked = blockedReason(health, undefined, useModelsView());
  const close = () => {
    setFixing(false);
    requestAnimationFrame(() => opener.current?.focus());
  };
  const canFix = d.phase === "fail" && finished && hasBook;
  // Words only where they say something: what an active demo is doing, or that it was stopped.
  // Ready / failed / queued are the glyph and the row's tone (spoken for screen readers).
  const shown = active || (finished && isActive(d));
  return (
    <li className={`build-demo phase-${d.phase}${active ? " active" : ""}${finished && isActive(d) ? " halted" : ""}`}>
      <span className="glyph">{d.phase === "pass" ? <Check /> : d.phase === "fail" ? <Cross /> : <span className="dot" />}</span>
      <span className="build-demo-title">{d.title}</span>
      {canFix && !fixing ? (
        <button ref={opener} className="btn small" onClick={() => setFixing(true)} disabled={!!blocked} aria-describedby={blocked ? "build-blocked" : undefined} title={blocked ? undefined : "describe what's wrong and yagami revises it"}>
          fix<span className="sr-only"> {d.title} (failed)</span>
        </button>
      ) : (
        <span className="build-demo-state">
          {shown ? word : <span className="sr-only">{word}</span>}
          {d.round > 1 && active && <span className="attempt"> · attempt {d.round + 1}</span>}
        </span>
      )}
      {d.phase === "fail" && <span className="build-reason">{shortReason(d.detail) || "failed"}</span>}
      {fixing && (
        <form
          className="fix-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!problem.trim()) return;
            setSending(true);
            setError(null);
            try {
              const res = await startFix(slug, d.unit, d.id, problem.trim());
              location.hash = buildHash(res.job);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "couldn't start the fix");
              setSending(false);
            }
          }}
        >
          <label className="fix-label" htmlFor={`fix-${d.id}`}>
            what's wrong with it?
          </label>
          <textarea
            id={`fix-${d.id}`}
            className="fix-input"
            rows={2}
            autoFocus
            placeholder="e.g. the legend covers the curve"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          />
          {error && <p className="upload-blocked">{error}</p>}
          <div className="upload-actions">
            <button className="btn primary small" disabled={sending || !problem.trim()}>
              {sending ? "starting…" : "fix it"}
            </button>
            <button type="button" className="btn ghost small" onClick={close} disabled={sending}>
              cancel
            </button>
            <span className="upload-hint">{onPlan(health) ? "a fix uses your plan" : "a fix usually costs under $0.50"}</span>
          </div>
        </form>
      )}
    </li>
  );
}
