// A build job as the UI sees it: the pipeline's events folded into one state
// (mirrors the CLI's view: pages → plan → each demo with a state word).

import { useEffect, useReducer, useState } from "react";
import { followJob, listJobs, type JobSummary, type PipelineEvent } from "./api";

const PIPELINE_LOG = /^(render|anchors|ocr|assemble|plan|build|verify|revise|typecheck|tsc|content)\b[^:]*:/i;

export type Step = "pending" | "running" | "done" | "error";

export interface JobUnit {
  id: string;
  pages: Step;
  plan: Step;
  /** Pages rendered / anchored so far, when known. */
  progress?: { done: number; total: number };
  error?: string;
}

export interface JobDemo {
  id: string;
  unit: string;
  title: string;
  phase: Extract<PipelineEvent, { type: "demo" }>["phase"];
  round: number;
  /** Last review issue / failure reason. */
  detail?: string;
}

export interface JobState {
  slug: string;
  title: string;
  kind: "text" | "scanned" | null;
  units: JobUnit[];
  demos: JobDemo[];
  cost: number;
  /** Set once the final event arrived. */
  done: { seconds: number; cost: number; failures: string[] } | null;
  /** Lost connection, or the run errored before any demo. */
  error: string | null;
  /** The latest informational line (e.g. "waiting for another build to finish"). */
  note: string | null;
  /** Number of events applied (for "nothing yet" skeletons). */
  events: number;
}

export const emptyJob = (): JobState => ({ slug: "", title: "", kind: null, units: [], demos: [], cost: 0, done: null, error: null, note: null, events: 0 });

function unitOf(s: JobState, id: string): [JobUnit[], JobUnit] {
  const units = [...s.units];
  let i = units.findIndex((u) => u.id === id);
  if (i < 0) {
    units.push({ id, pages: "pending", plan: "pending" });
    i = units.length - 1;
  }
  const u = { ...units[i] };
  units[i] = u;
  return [units, u];
}

export function reduce(s: JobState, e: PipelineEvent | { type: "lost"; message: string }): JobState {
  if (e.type === "lost") return { ...s, error: e.message };
  const n = { ...s, events: s.events + 1 };
  switch (e.type) {
    case "book":
      return { ...n, note: null, slug: e.slug, title: e.title, kind: e.kind, units: e.units.map((id) => s.units.find((u) => u.id === id) ?? { id, pages: "pending", plan: "pending" }) };
    case "stage": {
      if (e.stage === "init") return e.status === "error" ? { ...n, error: e.detail ?? "failed" } : n;
      if (e.stage === "build" || e.stage === "verify" || e.stage === "serve") return n;
      const [units, u] = unitOf(s, e.unit);
      if (e.status === "error") {
        if (e.stage === "plan") u.plan = "error";
        else u.pages = "error";
        u.error = e.detail;
      } else if (e.stage === "plan") u.plan = e.status === "start" ? "running" : "done";
      else if (e.stage === "assemble") u.pages = e.status === "start" ? "running" : "done";
      else if (u.pages === "pending") u.pages = "running"; // render / anchors
      return { ...n, units };
    }
    case "progress": {
      if (e.stage === "build" || e.stage === "verify") return n;
      const [units, u] = unitOf(s, e.unit);
      u.progress = { done: e.done, total: e.total };
      return { ...n, units };
    }
    case "plan": {
      const known = new Map(s.demos.map((d) => [d.id, d]));
      const demos = [...s.demos];
      for (const d of e.demos)
        if (!known.has(d.id)) demos.push({ id: d.id, unit: e.unit, title: d.title, phase: "queued", round: 0 });
      return { ...n, demos };
    }
    case "demo": {
      const demos = [...s.demos];
      const i = demos.findIndex((d) => d.id === e.id && d.unit === e.unit);
      const prev = i >= 0 ? demos[i] : { id: e.id, unit: e.unit, title: e.title ?? e.id.replace(/-/g, " "), phase: "queued" as const, round: 0 };
      const next: JobDemo = {
        ...prev,
        title: e.title ?? prev.title,
        phase: e.phase,
        round: e.round ?? prev.round,
        detail: e.phase === "fail" ? (e.detail ?? prev.detail) : e.phase === "revising" || e.phase === "fixing" ? (e.detail ?? prev.detail) : e.phase === "pass" ? undefined : prev.detail,
      };
      if (i >= 0) demos[i] = next;
      else demos.push(next);
      return { ...n, demos };
    }
    case "cost":
      return { ...n, cost: e.total };
    case "log":
      // Pipeline step logs ("assemble: book/unit 3 pages, …") are for developers; only
      // user-facing notes (e.g. "waiting for another build to finish") are shown.
      if (e.level === "error") return { ...n, error: e.message };
      if (e.level === "info" && !PIPELINE_LOG.test(e.message)) return { ...n, note: e.message };
      return n;
    case "done":
      return { ...n, cost: e.cost, done: { seconds: e.seconds, cost: e.cost, failures: e.failures } };
  }
  return n;
}

/** State words, matching the CLI. */
export function phaseWord(d: JobDemo): string {
  switch (d.phase) {
    case "queued":
      return "queued";
    case "building":
      return "writing";
    case "typecheck":
      return "typechecking";
    case "fixing":
      return "fixing types";
    case "verifying":
      return d.round > 0 ? "retesting" : "testing";
    case "revising":
      return "revising";
    case "pass":
      return "ready";
    case "fail":
      return "failed";
  }
}

export const isActive = (d: JobDemo) => !["queued", "pass", "fail"].includes(d.phase);

/** First line of a failure reason, without the "<book>/<unit> <id>:" prefix the pipeline adds. */
export function shortReason(s: string | undefined): string {
  if (!s) return "";
  const line = s.split("\n")[0].replace(/^[\w./-]+ [\w-]+: /, "");
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

/** Follow one job: replayed events folded into state. */
export function useJob(job: string): JobState {
  const [state, dispatch] = useReducer(reduce, undefined, emptyJob);
  useEffect(() => {
    return followJob(job, dispatch, (error) => error && dispatch({ type: "lost", message: error }));
  }, [job]);
  return state;
}

/** Running and recent jobs: polled (fast while any is running) and refreshed on navigation. */
export function useJobs(enabled: boolean): JobSummary[] {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let t = 0;
    const tick = async () => {
      clearTimeout(t);
      const list = await listJobs();
      if (!live) return;
      setJobs((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
      clearTimeout(t);
      t = window.setTimeout(tick, list.some((j) => j.status === "running") ? 1500 : 6000);
    };
    const now = () => void tick();
    void tick();
    window.addEventListener("hashchange", now);
    window.addEventListener("focus", now);
    window.addEventListener("yagami:jobs", now);
    return () => {
      live = false;
      clearTimeout(t);
      window.removeEventListener("hashchange", now);
      window.removeEventListener("focus", now);
      window.removeEventListener("yagami:jobs", now);
    };
  }, [enabled]);
  return jobs;
}
