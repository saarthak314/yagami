// Orchestrator: PDF pages → anchors → page images → demo plan → demos, for one
// book. Everything is reported through `emit` (the CLI renders it).
//
// Speed comes from streaming rather than stages: the planner hands over each
// demo the moment it is accepted, and every demo then runs as one task —
// build → typecheck → verify → revise — while other demos are still being
// planned or built. One Vite server and one Chromium are shared by all demos.
// Unchanged work is skipped (hash of inputs per step) unless `force` is set.

import fs from "node:fs";
import path from "node:path";
import type { BookConfig, DemoSpec } from "../src/types";
import { loadBook, unitJsonPath, unitOf } from "./books";
import { onCost, pool } from "./lib/claude";
import type { Emit, Stage } from "./lib/events";
import { Limit } from "./lib/limit";
import { emit, setEmit } from "./lib/report";
import { assembleUnit, anchorUnit, renderUnit } from "./content/index";
import { fileHash, hash, readCache, updateCache } from "./demos/cache";
import { loadCtx, loadPlan, paths } from "./demos/common";
import { buildDemo, loadConvo, reviseDemo } from "./demos/build";
import { planInputHash, planUnit } from "./demos/plan";
import { closeEnv, type DemoResult, previousVerdict, startEnv, type VerifyEnv, verifyDemo, writeReport } from "./demos/verify";

export type { Stage };

export interface RunOpts {
  /** Units to process (default: all units of the book). */
  units?: string[];
  /** Steps to run (default: render, anchors, assemble, plan, build, verify). */
  steps?: Stage[];
  /** Restrict build/verify/revise to these demo ids. */
  only?: string[];
  /** Coordinator note: revise the `only` demos with this feedback, then verify them. */
  note?: string;
  /** Verify → revise rounds per demo (default 2). */
  rounds?: number;
  /** Demos in flight at once across the whole run (default 8). */
  concurrency?: number;
  /** Redo steps even when their inputs are unchanged. */
  force?: boolean;
}

export interface RunResult {
  failures: string[];
  cost: number;
  seconds: number;
}

export const DEFAULT_STEPS: Stage[] = ["render", "anchors", "assemble", "plan", "build", "verify"];

export async function runBook(slug: string, opts: RunOpts, emitFn: Emit): Promise<RunResult> {
  const restore = setEmit(emitFn);
  const t0 = Date.now();
  let cost = 0;
  const off = onCost((c) => {
    cost += c;
    emit({ type: "cost", total: cost });
  });
  const failures: string[] = [];
  let env: Promise<VerifyEnv> | null = null;
  try {
    const book = loadBook(slug);
    const units = opts.units?.length ? opts.units : book.units.map((u) => u.id);
    for (const u of units) unitOf(book, u);
    const steps = new Set(opts.steps?.length ? opts.steps : DEFAULT_STEPS);
    emit({ type: "book", slug, title: book.title, units, domain: book.domain, kind: book.source.kind });

    // Content: cheap and local; do every unit first so the reader is usable early.
    const contentOk = new Set<string>();
    const codeHash = contentCodeHash();
    for (const unit of units) {
      try {
        // Skip pages + anchors when nothing they depend on changed (PDF, book settings, content code).
        const u = unitOf(book, unit);
        const key = hash(fileHash(book.source.pdf) ?? "", JSON.stringify([book.source, book.recolor, u.pages]), codeHash);
        if (!opts.force && readCache(slug, unit).content === key && fs.existsSync(unitJsonPath(slug, unit))) {
          for (const stage of ["render", "anchors", "assemble"] as const)
            if (steps.has(stage)) emit({ type: "stage", unit, stage, status: "skip", detail: "unchanged" });
          contentOk.add(unit);
          continue;
        }
        for (const [stage, fn] of [
          ["render", renderUnit],
          ["anchors", anchorUnit],
          ["assemble", assembleUnit],
        ] as const) {
          if (!steps.has(stage)) continue;
          emit({ type: "stage", unit, stage, status: "start" });
          await fn(book, unit);
          emit({ type: "stage", unit, stage, status: "done" });
        }
        if (["render", "anchors", "assemble"].every((s) => steps.has(s as Stage))) updateCache(slug, unit, (c) => void (c.content = key));
        contentOk.add(unit);
      } catch (e) {
        emit({ type: "stage", unit, stage: "anchors", status: "error", detail: (e as Error).message });
        failures.push(`${slug}/${unit} content: ${(e as Error).message}`);
      }
    }

    const demoLimit = new Limit(opts.concurrency ?? 8);
    const getEnv = () => (env ??= startEnv());
    const wantsDemos = steps.has("plan") || steps.has("build") || steps.has("verify") || !!opts.note;

    // Demo work: units in parallel (each streams its own plan), demos bounded globally.
    await pool([...contentOk], 3, async (unit) => {
      if (!wantsDemos) return;
      try {
        const results = await runUnitDemos(book, unit, steps, opts, demoLimit, getEnv);
        for (const r of results) if (!r.ok) failures.push(`${slug}/${unit} ${r.id}: ${r.why}`);
      } catch (e) {
        emit({ type: "stage", unit, stage: "plan", status: "error", detail: (e as Error).message });
        failures.push(`${slug}/${unit}: ${(e as Error).message}`);
      }
    });

    const seconds = (Date.now() - t0) / 1000;
    emit({ type: "done", seconds, cost, failures });
    return { failures, cost, seconds };
  } finally {
    off();
    if (env) await closeEnv(await env);
    setEmit(restore);
  }
}

interface DemoOutcome {
  id: string;
  ok: boolean;
  why?: string;
  result?: DemoResult;
}

async function runUnitDemos(
  book: BookConfig,
  unit: string,
  steps: Set<Stage>,
  opts: RunOpts,
  limit: Limit,
  getEnv: () => Promise<VerifyEnv>,
): Promise<DemoOutcome[]> {
  const slug = book.slug;
  const tasks: Promise<DemoOutcome>[] = [];
  const selected = (id: string) => !opts.only?.length || opts.only.includes(id);
  let built = 0;
  let verified = 0;
  let total = 0;
  const doBuild = steps.has("build");
  const doVerify = steps.has("verify");
  if (doBuild) emit({ type: "stage", unit, stage: "build", status: "start" });

  const enqueue = (spec: DemoSpec) => {
    if (!selected(spec.id)) return;
    total++;
    emit({ type: "demo", unit, id: spec.id, phase: "queued", beats: spec.beats.length, title: spec.title });
    tasks.push(
      limit.run(async () => {
        const out = await demoTask(book, unit, spec, steps, opts, getEnv);
        if (doBuild) emit({ type: "progress", unit, stage: "build", done: ++built, total, label: "demos" });
        if (doVerify) emit({ type: "progress", unit, stage: "verify", done: ++verified, total, label: "demos" });
        return out;
      }),
    );
  };

  // Plan (streamed) or reuse the existing plan.
  const planFile = paths.plan(slug, unit);
  // A re-plan streams into plan.json; keep the previous plan until it completes, and put
  // it back if the last run stopped mid-plan (the next step decides whether to re-plan).
  const planBackup = planFile.replace(/\.json$/, ".prev.json");
  if (fs.existsSync(planBackup)) fs.renameSync(planBackup, planFile);
  let demos: DemoSpec[];
  if (steps.has("plan")) {
    const inputHash = planInputHash(book, unit, hash);
    const cache = readCache(slug, unit);
    const upToDate = fs.existsSync(planFile) && !opts.force && (cache.plan === inputHash || cache.plan === undefined);
    if (upToDate) {
      emit({ type: "stage", unit, stage: "plan", status: "skip", detail: "unchanged" });
      if (cache.plan === undefined) updateCache(slug, unit, (c) => void (c.plan = inputHash));
      demos = loadPlan(slug, unit).demos;
      for (const d of demos) enqueue(d);
    } else {
      emit({ type: "stage", unit, stage: "plan", status: "start" });
      // Building/verifying overlaps planning: each demo starts as soon as it is accepted.
      if (doVerify) void getEnv();
      if (fs.existsSync(planFile)) fs.copyFileSync(planFile, planBackup);
      const plan = await planUnit(book, unit, { onDemo: enqueue });
      updateCache(slug, unit, (c) => void (c.plan = inputHash));
      fs.rmSync(planBackup, { force: true });
      demos = plan.demos;
      emit({ type: "stage", unit, stage: "plan", status: "done", detail: `${demos.length} demos` });
    }
  } else {
    demos = loadPlan(slug, unit).demos;
    for (const d of demos) enqueue(d);
  }
  emit({ type: "plan", unit, demos: demos.map((d) => ({ id: d.id, title: d.title, beats: d.beats.length })) });

  const outcomes = await Promise.all(tasks);
  if (doBuild) emit({ type: "stage", unit, stage: "build", status: "done" });
  const results = outcomes.map((o) => o.result).filter((r): r is DemoResult => !!r);
  if (results.length) writeReport(book, unit, results);
  if (doVerify) emit({ type: "stage", unit, stage: "verify", status: "done", detail: `${outcomes.filter((o) => o.ok).length}/${outcomes.length} demos pass` });
  return outcomes;
}

/** One demo: build (or reuse) → optional revise → verify (with fix rounds). */
async function demoTask(book: BookConfig, unit: string, spec: DemoSpec, steps: Set<Stage>, opts: RunOpts, getEnv: () => Promise<VerifyEnv>): Promise<DemoOutcome> {
  const slug = book.slug;
  const file = paths.component(slug, unit, spec.component);
  const specHash = hash(JSON.stringify(spec));
  try {
    if (steps.has("build")) {
      const cached = readCache(slug, unit).demos[spec.id];
      const haveCode = fs.existsSync(file) && !!loadConvo(slug, unit, spec.id);
      const upToDate = haveCode && !opts.force && (cached?.spec === specHash || cached?.spec === undefined);
      if (!upToDate) {
        const ok = await buildDemo(loadCtx(book, unit), spec);
        updateCache(slug, unit, (c) => void (c.demos[spec.id] = { spec: specHash, code: fileHash(file), verified: false }));
        if (!ok) {
          emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: "does not typecheck" });
          return { id: spec.id, ok: false, why: "build failed (typecheck)" };
        }
      } else if (cached?.spec === undefined) {
        updateCache(slug, unit, (c) => void (c.demos[spec.id] = { ...c.demos[spec.id], spec: specHash }));
      }
    }

    if (opts.note && opts.only?.includes(spec.id)) {
      const ok = await reviseDemo(book, unit, spec.id, opts.note);
      if (!ok) return { id: spec.id, ok: false, why: "revise failed (typecheck)" };
    }

    if (!steps.has("verify")) {
      emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "built (not verified)" });
      return { id: spec.id, ok: true };
    }

    const code = fileHash(file);
    const cached = readCache(slug, unit).demos[spec.id];
    if (!opts.force && code && !opts.note) {
      const adopted = cached?.code === undefined && previousVerdict(book, unit, spec.id) === true;
      if ((cached?.verified && cached.code === code) || adopted) {
        if (adopted) updateCache(slug, unit, (c) => void (c.demos[spec.id] = { ...c.demos[spec.id], code, verified: true }));
        emit({ type: "demo", unit, id: spec.id, phase: "pass", beatsPassed: spec.beats.length, beats: spec.beats.length, detail: "unchanged" });
        return { id: spec.id, ok: true };
      }
    }
    const result = await verifyDemo(await getEnv(), loadCtx(book, unit), spec, opts.rounds ?? 2);
    updateCache(slug, unit, (c) => void (c.demos[spec.id] = { ...c.demos[spec.id], code: fileHash(file), verified: result.pass }));
    return { id: spec.id, ok: result.pass, why: result.pass ? undefined : result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed", result };
  } catch (e) {
    emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: (e as Error).message });
    return { id: spec.id, ok: false, why: (e as Error).message };
  }
}

/** Hash of the content pipeline's source, so a change to the extractor re-runs it. */
function contentCodeHash(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith(".ts")) files.push(f);
    }
  };
  walk(path.resolve("scripts/content"));
  return hash(...files.sort().map((f) => fs.readFileSync(f)));
}
