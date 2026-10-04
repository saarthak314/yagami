// Orchestrator: PDF pages → anchors → page images → demo plan → demos, for one
// book. Everything is reported through `emit` (the CLI renders it).
//
// Speed comes from streaming rather than stages: a short outline hands over each
// demo the moment it is outlined, and every demo then runs as one task — spec +
// code in one reply → typecheck → deterministic checks → (one) review — while
// other demos are still being outlined or built. One Vite server and one
// Chromium are shared by all demos.
// Unchanged work is skipped (hash of inputs per step) unless `force` is set.

import fs from "node:fs";
import path from "node:path";
import type { BookConfig, DemoSpec, Domain } from "../src/types";
import { loadBook, unitJsonPath, unitOf } from "./books";
import { onCost, pool } from "./lib/claude";
import type { Emit, Stage } from "./lib/events";
import { Limit } from "./lib/limit";
import { emit, setEmit, withEmit } from "./lib/report";
import { assembleUnit, assembleVariants, anchorUnit, renderUnit } from "./content/index";
import { fileHash, hash, readCache, updateCache } from "./demos/cache";
import { loadCtx, loadPlan, paths, setSpecSink } from "./demos/common";
import { buildDemo, buildEffort, generateDemo, loadConvo, reviseDemo, warmBuilder } from "./demos/build";
import { cleanStaleCandidates, cleanupRaces, raceDemo, raceEnabled, raceIdle } from "./demos/race";
import { legacyPlanner, type OutlineDemo, PlanAssembler, PLAN_KEY_PREFIX, planInputHash, planOutline, planUnit, useDirect } from "./demos/plan";
import { planDirect, warmDirect } from "./demos/direct";
import { type CheckedOpts, closeEnv, type DemoResult, previousVerdict, setFlag, startEnv, type VerifyEnv, verifyDemoChecked, writeReport } from "./demos/verify";
import { fixEffort } from "./lib/claude";
import { generateTemplateDemo, reviseTemplate, skipsReview, templateArtifact, warmTemplates } from "./demos/template";

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
  /** Demos in flight at once across the whole run (default 12, or YAGAMI_CONCURRENCY). */
  concurrency?: number;
  /** Redo steps even when their inputs are unchanged. */
  force?: boolean;
  /**
   * The book's subject, still being detected (see startBook). Content steps run meanwhile;
   * planning and building wait for it, since the subject picks their prompts.
   */
  domain?: Promise<Domain>;
}

export interface RunResult {
  failures: string[];
  cost: number;
  seconds: number;
}

export const DEFAULT_STEPS: Stage[] = ["render", "anchors", "assemble", "plan", "build", "verify"];

/**
 * Demos in flight at once across the run (each holds its slot for spec+code, checks and review).
 * 12 keeps a two-chapter book's demos from queueing while staying well inside API rate limits;
 * YAGAMI_CONCURRENCY overrides.
 */
const DEMO_PARALLEL = 12;
/** Units making demos side by side; their demos are bounded globally by `concurrency`. */
const UNIT_PARALLEL = 3;
/** Units whose pages are being made at once (rendering and OCR already use every core per unit). */
const CONTENT_PARALLEL = 2;

export async function runBook(slug: string, opts: RunOpts, emitFn: Emit): Promise<RunResult> {
  // Events and costs are scoped to this run, so books running side by side in one process stay separate.
  return withEmit(emitFn, () => runBookScoped(slug, opts, emitFn));
}

async function runBookScoped(slug: string, opts: RunOpts, emitFn: Emit): Promise<RunResult> {
  const restore = setEmit(emitFn); // process-wide fallback for code outside the run's async context
  const t0 = Date.now();
  let cost = 0;
  // Every API label carries the book slug ("build:<slug>/<unit>:<id>", "build-warm:<slug>"), so only
  // this book's calls count towards its cost.
  const mine = (label: string) => label.includes(`:${slug}/`) || label.endsWith(`:${slug}`) || label.includes(`:${slug}:`);
  const off = onCost((c, label) => {
    if (!mine(label)) return;
    cost += c;
    emit({ type: "cost", total: cost });
  });
  const failures: string[] = [];
  let env: Promise<VerifyEnv> | null = null;
  try {
    const book = loadBook(slug);
    cleanStaleCandidates(slug); // drafts left by an interrupted race
    const units = opts.units?.length ? opts.units : book.units.map((u) => u.id);
    for (const u of units) unitOf(book, u);
    const steps = new Set(opts.steps?.length ? opts.steps : DEFAULT_STEPS);
    emit({ type: "book", slug, title: book.title, units, domain: book.domain, kind: book.source.kind });

    // The subject (still being detected for a new book) picks the demo prompts: content runs meanwhile.
    const domainReady = opts.domain
      ? opts.domain.then(
          (d) => void (book.domain = d),
          () => undefined, // detection failed: the local guess in book.domain stands
        )
      : Promise.resolve();
    const demoLimit = new Limit(opts.concurrency ?? (Number(process.env.YAGAMI_CONCURRENCY) || DEMO_PARALLEL));
    const getEnv = () => (env ??= startEnv());
    const wantsDemos = steps.has("plan") || steps.has("build") || steps.has("verify") || !!opts.note;

    // A run that will make demos (fresh book, force, a fix) starts the browser and warms the
    // builder's prompt cache now, overlapping the content steps instead of waiting for them.
    const makesDemos = wantsDemos && (!!opts.force || !!opts.note || units.some((u) => !fs.existsSync(paths.plan(slug, u))));
    if (makesDemos && steps.has("verify")) void getEnv();
    // Every effort the builder will run at: the race's drafts, and fix turns.
    // Direct planning (short units, YAGAMI_DIRECT=on) warms its own prompt (builder + templates + direct
    // block) instead of the builder's first-draft effort, which it then doesn't need.
    const direct = units.every((u) => useDirect(book, u));
    const builderEfforts = [...new Set([...(raceEnabled() ? ["low" as const, "medium" as const] : direct ? [] : [buildEffort()]), fixEffort()])];
    if (makesDemos && steps.has("plan") && steps.has("build") && !legacyPlanner())
      void domainReady.then(() => Promise.all([...builderEfforts.map((e) => warmBuilder(book, e)), ...(units.some((u) => useDirect(book, u)) ? [warmDirect(book)] : [])]));

    // Sharper page variants render in the background once a unit's base pages are ready.
    const codeHash = contentCodeHash();
    const background: Promise<void>[] = [];
    const variantsLater = (unit: string, key: string) => {
      if (!steps.has("assemble") || readCache(slug, unit).variants === key) return;
      if (hasAllVariants(slug, unit)) return updateCache(slug, unit, (c) => void (c.variants = key)); // made before this cache existed
      background.push(
        assembleVariants(book, unit)
          .then(() => updateCache(slug, unit, (c) => void (c.variants = key)))
          .catch((e: Error) => emit({ type: "log", level: "warn", message: `sharper pages for ${unit} failed: ${e.message}` })),
      );
    };

    /**
     * Pages + anchors for one unit (skipped when unchanged). Opens two gates: `anchors` once the
     * raw anchors, text and page renders exist (the outline can start: it works from those), and
     * `pages` once the unit JSON + page images exist (demos can be generated and checked).
     */
    const content = async (unit: string, g: Gates): Promise<boolean> => {
      const ok = await contentSteps(unit, g);
      g.anchors.resolve(ok);
      g.pages.resolve(ok);
      return ok;
    };
    const contentSteps = async (unit: string, g: Gates): Promise<boolean> => {
      try {
        // Skip pages + anchors when nothing they depend on changed (PDF, book settings, content code).
        const u = unitOf(book, unit);
        const key = hash(fileHash(book.source.pdf) ?? "", JSON.stringify([book.source, book.recolor, u.pages]), codeHash);
        if (!opts.force && readCache(slug, unit).content === key && fs.existsSync(unitJsonPath(slug, unit))) {
          for (const stage of ["render", "anchors", "assemble"] as const)
            if (steps.has(stage)) emit({ type: "stage", unit, stage, status: "skip", detail: "unchanged" });
          variantsLater(unit, key);
          return true;
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
          if (stage === "anchors") g.anchors.resolve(true);
        }
        if (["render", "anchors", "assemble"].every((s) => steps.has(s as Stage))) {
          updateCache(slug, unit, (c) => {
            c.content = key;
            delete c.variants; // the base pages were redone: their variants must be too
          });
          variantsLater(unit, key);
        }
        return true;
      } catch (e) {
        emit({ type: "stage", unit, stage: "anchors", status: "error", detail: (e as Error).message });
        failures.push(`${slug}/${unit} content: ${(e as Error).message}`);
        return false;
      }
    };

    // Pages for every unit (cheap, local; bounded, earliest unit first) so the whole book is
    // readable early. Each unit's demos start as soon as its own pages are ready; up to
    // UNIT_PARALLEL units make demos side by side, sharing one global demo limit.
    const contentLimit = new Limit(CONTENT_PARALLEL);
    const gates = new Map(units.map((u) => [u, { anchors: gate(), pages: gate() }]));
    const pagesReady = new Map(units.map((u, i) => [u, contentLimit.run(() => content(u, gates.get(u)!), i)]));
    // The outline only needs the anchors step's output (raw anchors, text, page renders), so it
    // starts before the page images exist; the legacy planner needs the assembled unit.
    const early = !legacyPlanner();
    await pool(units, UNIT_PARALLEL, async (unit, i) => {
      const g = gates.get(unit)!;
      if (!(await (early ? g.anchors.promise : g.pages.promise)) || !wantsDemos) return;
      await domainReady;
      try {
        const results = await runUnitDemos(book, unit, steps, opts, demoLimit, getEnv, i, g.pages.promise);
        for (const r of results) if (!r.ok) failures.push(`${slug}/${unit} ${r.id}: ${r.why}`);
      } catch (e) {
        emit({ type: "stage", unit, stage: "plan", status: "error", detail: (e as Error).message });
        failures.push(`${slug}/${unit}: ${(e as Error).message}`);
      }
    });

    await Promise.all(pagesReady.values());
    await Promise.all(background); // usually long done: variants are quicker than demos
    const seconds = (Date.now() - t0) / 1000;
    emit({ type: "done", seconds, cost, failures });
    return { failures, cost, seconds };
  } finally {
    off();
    await raceIdle(); // losing drafts still aborting or mid-check use the browser
    if (env) await closeEnv(await env);
    cleanupRaces(); // no check page is loading any more: candidate dirs can go
    setEmit(restore);
  }
}

interface Gate {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}
interface Gates {
  anchors: Gate;
  pages: Gate;
}

/** A promise that can be resolved from outside (first resolution wins). */
function gate(): Gate {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { promise, resolve };
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
  /** Lower runs first when demos wait for a slot (the unit's position in the book). */
  priority = 0,
  /** The unit JSON + page images exist (the outline may start before; demo work waits for this). */
  pages: Promise<boolean> = Promise.resolve(true),
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
        const out = (await pages) ? await demoTask(book, unit, spec, steps, opts, getEnv) : { id: spec.id, ok: false, why: "the pages could not be made" };
        if (doBuild) emit({ type: "progress", unit, stage: "build", done: ++built, total, label: "demos" });
        if (doVerify) emit({ type: "progress", unit, stage: "verify", done: ++verified, total, label: "demos" });
        return out;
      }, priority),
    );
  };

  /** An outlined demo: spec + code in one conversation, then the checked verify loop. */
  const enqueueOutlined = (o: OutlineDemo, plan: PlanAssembler, outlined: OutlineDemo[], prefill?: string) => {
    if (!selected(o.id)) return;
    total++;
    emit({ type: "demo", unit, id: o.id, phase: "queued", beats: o.beats.length, title: o.title });
    tasks.push(
      limit.run(async () => {
        const out = (await pages) ? await generatedTask(book, unit, o, plan, outlined, steps, opts, getEnv, prefill) : { id: o.id, ok: false, why: "the pages could not be made" };
        if (doBuild) emit({ type: "progress", unit, stage: "build", done: ++built, total, label: "demos" });
        if (doVerify) emit({ type: "progress", unit, stage: "verify", done: ++verified, total, label: "demos" });
        return out;
      }, priority),
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
    // Plans keyed by an older scheme (or not at all) are adopted, not re-planned.
    const legacy = cache.plan === undefined || !cache.plan.startsWith(PLAN_KEY_PREFIX);
    const upToDate = fs.existsSync(planFile) && !opts.force && (cache.plan === inputHash || legacy);
    if (upToDate) {
      emit({ type: "stage", unit, stage: "plan", status: "skip", detail: "unchanged" });
      if (cache.plan !== inputHash) updateCache(slug, unit, (c) => void (c.plan = inputHash));
      demos = loadPlan(slug, unit).demos;
      for (const d of demos) enqueue(d);
    } else {
      emit({ type: "stage", unit, stage: "plan", status: "start" });
      // Building/verifying overlaps planning: each demo starts as soon as it is accepted.
      if (doVerify) void getEnv();
      if (fs.existsSync(planFile)) fs.copyFileSync(planFile, planBackup);
      if (legacyPlanner()) {
        const plan = await planUnit(book, unit, { onDemo: enqueue });
        updateCache(slug, unit, (c) => void (c.plan = inputHash));
        fs.rmSync(planBackup, { force: true });
        demos = plan.demos;
        emit({ type: "stage", unit, stage: "plan", status: "done", detail: `${demos.length} demos` });
      } else {
        // Outline first (short, streamed); each outlined demo immediately gets its own
        // spec + code conversation. plan.json fills in as specs are accepted.
        const outlined: OutlineDemo[] = [];
        const assembler = new PlanAssembler(book, unit, { demos: outlined });
        const direct = useDirect(book, unit);
        // Write the builder prompt to the cache while the outline streams (demos then only read it).
        if (doBuild && !direct) void warmBuilder(book, buildEffort());
        try {
          if (direct)
            // Short unit: no outline — groups write their demos in full (spec + config or code) directly.
            await planDirect(book, unit, {
              onDemo: (o, prefill) => {
                outlined.push(o);
                enqueueOutlined(o, assembler, outlined, prefill);
              },
            });
          else
            await planOutline(book, unit, {
              onDemo: (o) => {
                // Warm the template prompt when the outline marks its first template demo.
                if (o.template && doBuild) void warmTemplates(book);
                outlined.push(o);
                enqueueOutlined(o, assembler, outlined);
              },
            });
          emit({ type: "stage", unit, stage: "plan", status: "done", detail: `${outlined.length} demos` });
          emit({ type: "plan", unit, demos: outlined.map((o) => ({ id: o.id, title: o.title, beats: o.beats.length })) });
          const outcomes = await Promise.all(tasks);
          const plan = assembler.finish();
          updateCache(slug, unit, (c) => void (c.plan = inputHash));
          fs.rmSync(planBackup, { force: true });
          return finishUnit(outcomes, plan.demos.length);
        } finally {
          setSpecSink(slug, unit, null);
        }
      }
    }
  } else {
    demos = loadPlan(slug, unit).demos;
    for (const d of demos) enqueue(d);
  }
  emit({ type: "plan", unit, demos: demos.map((d) => ({ id: d.id, title: d.title, beats: d.beats.length })) });
  return finishUnit(await Promise.all(tasks), demos.length);

  function finishUnit(outcomes: DemoOutcome[], _planned: number): DemoOutcome[] {
    if (doBuild) emit({ type: "stage", unit, stage: "build", status: "done" });
    const results = outcomes.map((o) => o.result).filter((r): r is DemoResult => !!r);
    if (results.length) writeReport(book, unit, results);
    if (doVerify) emit({ type: "stage", unit, stage: "verify", status: "done", detail: `${outcomes.filter((o) => o.ok).length}/${outcomes.length} demos pass` });
    return outcomes;
  }
}

/** One demo: build (or reuse) → optional revise → verify (with fix rounds). */
async function demoTask(book: BookConfig, unit: string, spec: DemoSpec, steps: Set<Stage>, opts: RunOpts, getEnv: () => Promise<VerifyEnv>): Promise<DemoOutcome> {
  if (spec.template) return templateTask(book, unit, spec, steps, opts, getEnv);
  const slug = book.slug;
  const file = paths.component(slug, unit, spec.component);
  const specHash = hash(JSON.stringify(spec));
  try {
    if (steps.has("build")) {
      const cached = readCache(slug, unit).demos[spec.id];
      const haveCode = fs.existsSync(file) && !!loadConvo(slug, unit, spec.id);
      const upToDate = haveCode && !opts.force && (cached?.spec === specHash || cached?.spec === undefined);
      if (!upToDate && raceEnabled() && !opts.note) {
        // Quick and careful drafts race; the first to pass the checks (+ review) is installed.
        const race = await raceDemo(loadCtx(book, unit), { kind: "spec", spec }, getEnv, { verify: steps.has("verify"), review: true });
        // A demo that passed the race is no longer flagged by an earlier failed run.
        const final = race.passed && steps.has("verify") ? setFlag(slug, unit, race.spec ?? spec, undefined) : (race.spec ?? spec);
        updateCache(slug, unit, (c) => void (c.demos[spec.id] = { spec: hash(JSON.stringify(final)), code: fileHash(file), verified: race.passed && steps.has("verify") }));
        if (!race.built) {
          emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: race.why ?? "does not typecheck" });
          return { id: spec.id, ok: false, why: race.why ?? "build failed (typecheck)" };
        }
        if (race.passed) {
          if (!steps.has("verify")) emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "built (not verified)" });
          return { id: spec.id, ok: true, result: race.result };
        }
        const result = await verifyDemoChecked(await getEnv(), loadCtx(book, unit), final, { rounds: opts.rounds ?? 2, initial: race.initial });
        const after = currentSpec(slug, unit, final);
        updateCache(slug, unit, (c) => void (c.demos[spec.id] = { spec: hash(JSON.stringify(after)), code: fileHash(file), verified: result.pass }));
        return { id: spec.id, ok: result.pass, why: result.pass ? undefined : (result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed"), result };
      }
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
    const result = await verifyDemoChecked(await getEnv(), loadCtx(book, unit), spec, { rounds: opts.rounds ?? 2 });
    const final = currentSpec(slug, unit, spec);
    updateCache(slug, unit, (c) => void (c.demos[spec.id] = { ...c.demos[spec.id], spec: hash(JSON.stringify(final)), code: fileHash(file), verified: result.pass }));
    return { id: spec.id, ok: result.pass, why: result.pass ? undefined : result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed", result };
  } catch (e) {
    emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: (e as Error).message });
    return { id: spec.id, ok: false, why: (e as Error).message };
  }
}

/** One outlined demo: spec + code in one reply (generateDemo), then the checked verify loop. */
async function generatedTask(
  book: BookConfig,
  unit: string,
  o: OutlineDemo,
  plan: PlanAssembler,
  outlined: OutlineDemo[],
  steps: Set<Stage>,
  opts: RunOpts,
  getEnv: () => Promise<VerifyEnv>,
  /** The demo's first reply, already written (direct planning). */
  prefill?: string,
): Promise<DemoOutcome> {
  const slug = book.slug;
  // The real unit (pages + images exist now): crops for the model come from it. plan.c may be the
  // outline's provisional context, built before the page images.
  const c = loadCtx(book, unit);
  try {
    if (o.template) {
      const tg = await generateTemplateDemo(c, o, plan, outlined, { prefill });
      if (tg.spec) {
        updateCache(slug, unit, (c) => void (c.demos[tg.spec!.id] = { spec: hash(JSON.stringify(tg.spec)), code: artifactHash(slug, unit, tg.spec!), verified: false }));
        return verifyTemplate(book, unit, tg.spec, steps, opts, getEnv, (s) => plan.accept(s));
      }
      // No valid config: this demo is built as code after all (a fresh build; the prefill was a config).
      delete o.template;
      prefill = undefined;
    }
    if (raceEnabled() && !prefill) {
      const race = await raceDemo(c, { kind: "outline", o, plan, others: outlined }, getEnv, { verify: steps.has("verify"), review: true });
      if (!race.spec) {
        emit({ type: "demo", unit, id: o.id, phase: "fail", detail: race.why });
        return { id: o.id, ok: false, why: race.why ?? "no usable spec" };
      }
      const spec = race.passed && steps.has("verify") ? setFlag(slug, unit, race.spec, undefined) : race.spec;
      const file = paths.component(slug, unit, spec.component);
      updateCache(slug, unit, (cc) => void (cc.demos[spec.id] = { spec: hash(JSON.stringify(spec)), code: fileHash(file), verified: race.passed && steps.has("verify") }));
      if (!race.built) {
        emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: "does not typecheck" });
        return { id: spec.id, ok: false, why: race.why ?? "build failed (typecheck)" };
      }
      if (race.passed) {
        if (!steps.has("verify")) emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "built (not verified)" });
        return { id: spec.id, ok: true, result: race.result };
      }
      const result = await verifyDemoChecked(await getEnv(), c, spec, { rounds: opts.rounds ?? 2, initial: race.initial });
      const final = plan.specs().find((d) => d.id === spec.id) ?? spec;
      updateCache(slug, unit, (cc) => void (cc.demos[spec.id] = { spec: hash(JSON.stringify(final)), code: fileHash(file), verified: result.pass }));
      return { id: spec.id, ok: result.pass, why: result.pass ? undefined : (result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed"), result };
    }
    const g = await generateDemo(c, o, plan, outlined, { prefill });
    if (!g.spec) {
      emit({ type: "demo", unit, id: o.id, phase: "fail", detail: g.why });
      return { id: o.id, ok: false, why: g.why ?? "no usable spec" };
    }
    const spec = g.spec;
    const file = paths.component(slug, unit, spec.component);
    updateCache(slug, unit, (c) => void (c.demos[spec.id] = { spec: hash(JSON.stringify(spec)), code: fileHash(file), verified: false }));
    if (!g.ok) {
      emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: "does not typecheck" });
      return { id: spec.id, ok: false, why: g.why ?? "build failed (typecheck)" };
    }
    if (!steps.has("verify")) {
      emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "built (not verified)" });
      return { id: spec.id, ok: true };
    }
    const result = await verifyDemoChecked(await getEnv(), c, spec, { rounds: opts.rounds ?? 2 });
    // Verification may have corrected the spec (expectations): cache the final one.
    const final = plan.specs().find((d) => d.id === spec.id) ?? spec;
    updateCache(slug, unit, (c) => void (c.demos[spec.id] = { spec: hash(JSON.stringify(final)), code: fileHash(file), verified: result.pass }));
    return { id: spec.id, ok: result.pass, why: result.pass ? undefined : (result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed"), result };
  } catch (e) {
    emit({ type: "demo", unit, id: o.id, phase: "fail", detail: (e as Error).message });
    return { id: o.id, ok: false, why: (e as Error).message };
  }
}

/** Cache key for what a demo renders: its component file, or a template demo's template + config. */
function artifactHash(slug: string, unit: string, spec: DemoSpec): string | undefined {
  const t = templateArtifact(spec);
  return t ? hash(t) : fileHash(paths.component(slug, unit, spec.component));
}

/** A template demo from an existing plan: nothing to build; optional config fix (`yagami fix`); verify. */
async function templateTask(book: BookConfig, unit: string, spec: DemoSpec, steps: Set<Stage>, opts: RunOpts, getEnv: () => Promise<VerifyEnv>): Promise<DemoOutcome> {
  const slug = book.slug;
  try {
    let current = spec;
    if (opts.note && opts.only?.includes(spec.id)) {
      const next = await reviseTemplate(loadCtx(book, unit), current, opts.note, latestSheet(slug, unit, spec.id));
      if (!next) {
        emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: "the config could not be fixed" });
        return { id: spec.id, ok: false, why: "revise failed (config)" };
      }
      current = next;
    }
    if (!steps.has("verify")) {
      emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "configured (not verified)" });
      return { id: spec.id, ok: true };
    }
    const code = artifactHash(slug, unit, current);
    const cached = readCache(slug, unit).demos[spec.id];
    if (!opts.force && !opts.note) {
      const adopted = cached?.code === undefined && previousVerdict(book, unit, spec.id) === true;
      if ((cached?.verified && cached.code === code) || adopted) {
        if (adopted) updateCache(slug, unit, (c) => void (c.demos[spec.id] = { ...c.demos[spec.id], code, verified: true }));
        emit({ type: "demo", unit, id: spec.id, phase: "pass", beatsPassed: current.beats.length, beats: current.beats.length, detail: "unchanged" });
        return { id: spec.id, ok: true };
      }
    }
    return verifyTemplate(book, unit, current, steps, opts, getEnv);
  } catch (e) {
    emit({ type: "demo", unit, id: spec.id, phase: "fail", detail: (e as Error).message });
    return { id: spec.id, ok: false, why: (e as Error).message };
  }
}

/**
 * Verify a template demo: deterministic checks, then a contact-sheet review of every version that
 * passes them; their notes (and a review's) become config-fix turns.
 */
async function verifyTemplate(
  book: BookConfig,
  unit: string,
  spec: DemoSpec,
  steps: Set<Stage>,
  opts: RunOpts,
  getEnv: () => Promise<VerifyEnv>,
  save?: (s: DemoSpec) => void,
): Promise<DemoOutcome> {
  const slug = book.slug;
  if (!steps.has("verify")) {
    emit({ type: "demo", unit, id: spec.id, phase: "pass", detail: "configured (not verified)" });
    return { id: spec.id, ok: true };
  }
  const c = loadCtx(book, unit);
  let current = spec;
  const checked: CheckedOpts = {
    rounds: opts.rounds ?? 2,
    review: !skipsReview(spec),
    fix: async (notes, check, _from, round) => {
      const next = await reviseTemplate(c, current, notes.map((n) => `- ${n}`).join("\n"), check.sheet || null, { save, round });
      if (next) current = next;
      return next;
    },
  };
  const result = await verifyDemoChecked(await getEnv(), c, current, checked);
  current = currentSpec(slug, unit, current);
  updateCache(slug, unit, (cc) => void (cc.demos[current.id] = { spec: hash(JSON.stringify(current)), code: artifactHash(slug, unit, current), verified: result.pass }));
  return { id: current.id, ok: result.pass, why: result.pass ? undefined : (result.beats.find((b) => !b.pass)?.issues[0] ?? "verify failed"), result };
}

/** A demo's spec as it stands now (the plan being assembled, else plan.json), after any mid-run corrections. */
function currentSpec(slug: string, unit: string, spec: DemoSpec): DemoSpec {
  try {
    return loadPlan(slug, unit).demos.find((d) => d.id === spec.id) ?? spec;
  } catch {
    return spec;
  }
}

/** The newest contact sheet of a demo, for a fix request. */
function latestSheet(slug: string, unit: string, id: string): string | null {
  const f = path.join(paths.verifyDir(slug, unit), `${id}-sheet.png`);
  return fs.existsSync(f) ? f : null;
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

/** Every page of the unit already lists its sharper variants (srcset) and the files exist. */
function hasAllVariants(slug: string, unit: string): boolean {
  try {
    const doc = JSON.parse(fs.readFileSync(unitJsonPath(slug, unit), "utf8")) as { pages: { srcset?: { src: string }[] }[] };
    return doc.pages.length > 0 && doc.pages.every((p) => (p.srcset?.length ?? 0) > 1 && p.srcset!.every((v) => fs.existsSync(path.join("public", v.src))));
  } catch {
    return false;
  }
}
