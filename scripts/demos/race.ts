// Race: a custom (code) demo is built twice at once — a quick low-effort draft and a careful
// medium-effort one, in separate conversations — and whichever first passes the checks (and the
// review, when one is wanted) is installed; the other's stream is aborted. A failing candidate is
// not fixed while the other is still running: once both have failed, the better one (fewest
// problems) is installed and the normal fix loop continues from it.
//
// Candidates live in a pseudo-unit next to the real one, src/demos/<slug>/<unit>~<id>~<name>/
// (same depth, so their imports resolve, and the app's registry + isolated mode render them as
// /?demo=<slug>/<unit>~<id>~<name>/<id>). The real component file and plan.json are only written
// when a candidate is installed (code via write-temp + rename). Pseudo-units are invisible to the
// reader: every consumer looks plans up by a real unit key.
//
// Candidate dirs under src/ are removed only when the run is over (cleanupRaces): the app's
// registry imports every plan.json it globbed eagerly, so deleting one while another demo's
// check page is loading would break that page.

import fs from "node:fs";
import path from "node:path";
import type { DemoSpec } from "../../src/types";
import { type Effort } from "../lib/claude";
import { emit } from "../lib/report";
import { AbortedError, buildDemo, generateDemo, loadConvo, saveConvo, saveSpec } from "./build";
import { type Ctx, log, paths, tag, writeJson } from "./common";
import type { OutlineDemo, PlanAssembler } from "./plan";
import { type CheckResult, checkDemo, type CheckedOpts, type DemoResult, reviewSheet, toResults, type VerifyEnv } from "./verify";
import { workDir } from "../books";

/**
 * Racing is off unless YAGAMI_RACE=on: benchmarked, a second (medium) draft per custom demo doubled the
 * first-build cost and its cache warm without reliably shortening runs.
 */
export function raceEnabled(): boolean {
  return process.env.YAGAMI_RACE === "on";
}

/** Candidate efforts (YAGAMI_RACE_EFFORTS="low,medium"): the quick draft first. */
function raceEfforts(): Effort[] {
  const list = (process.env.YAGAMI_RACE_EFFORTS ?? "low,medium").split(",").map((s) => s.trim());
  const ok = list.filter((e): e is Effort => ["low", "medium", "high", "xhigh", "max"].includes(e));
  return ok.length ? [...new Set(ok)] : ["low", "medium"];
}

export type RaceSubject =
  | { kind: "outline"; o: OutlineDemo; plan: PlanAssembler; others: OutlineDemo[] }
  | { kind: "spec"; spec: DemoSpec };

type Status = "pass" | "review" | "checks" | "build" | "nospec" | "aborted" | "error";

interface Candidate {
  name: string;
  effort: Effort;
  /** Pseudo-unit id: `<unit>~<demo id>~<name>`. */
  unit: string;
  status: Status;
  spec?: DemoSpec;
  check?: CheckResult;
  review?: { pass: boolean; issues: string[] };
  why?: string;
}

export interface RaceOutcome {
  /** The installed spec (real plan + unit), or undefined when no candidate produced a usable demo. */
  spec?: DemoSpec;
  /** The installed candidate passed the checks (and the review, when wanted) during the race. */
  passed: boolean;
  /** For the winner: a report entry built from its checks. */
  result?: DemoResult;
  /** For an installed candidate that failed: its check/review, to start the fix loop from. */
  initial?: CheckedOpts["initial"];
  /** The installed candidate builds (typechecks); false only when no candidate built. */
  built: boolean;
  why?: string;
  /** Name of the installed candidate (e.g. "low"), for logs. */
  winner?: string;
}

/** Losers still finishing in the background (aborting, or mid-check); awaited before the env closes. */
const background = new Set<Promise<unknown>>();
/** Candidate pseudo-units to remove when the run is over. */
const spent = new Map<string, string>(); // `${slug}/${unit}` → slug

export function raceIdle(): Promise<void> {
  return Promise.allSettled([...background]).then(() => undefined);
}

/** Remove every candidate of this process's races (call after raceIdle, when no check page is loading). */
export function cleanupRaces(): void {
  for (const [key, slug] of spent) {
    cleanCandidate(slug, key.slice(slug.length + 1));
    spent.delete(key);
  }
}

const pseudo = (unit: string, id: string, name: string) => `${unit}~${id}~${name}`;

/** Remove everything a candidate wrote: its component dir, conversation, screenshots, tsconfig. */
function cleanCandidate(slug: string, unit: string) {
  fs.rmSync(paths.demoDir(slug, unit), { recursive: true, force: true });
  fs.rmSync(workDir(slug, "demos", unit), { recursive: true, force: true });
  fs.rmSync(paths.verifyDir(slug, unit), { recursive: true, force: true });
  const tsc = paths.tscDir(slug);
  if (fs.existsSync(tsc)) for (const f of fs.readdirSync(tsc)) if (f.startsWith(`${unit}-`)) fs.rmSync(path.join(tsc, f), { force: true });
}

/** Remove leftovers of candidates from an interrupted run (they'd otherwise be typechecked with the app). */
export function cleanStaleCandidates(slug: string) {
  const dir = path.resolve("src/demos", slug);
  if (!fs.existsSync(dir)) return;
  for (const d of fs.readdirSync(dir)) if (d.includes("~")) cleanCandidate(slug, d);
}

/** Lower is better: a passing candidate, then one the review failed, then one the checks failed, … */
function rank(c: Candidate): number {
  const problems = c.status === "review" ? (c.review?.issues.length ?? 1) : c.status === "checks" ? (c.check?.notes.length ?? 1) : 0;
  const base = { pass: 0, review: 100, checks: 200, build: 300, nospec: 900, aborted: 900, error: 900 }[c.status];
  return base + Math.min(problems, 99);
}

async function runCandidate(
  c: Ctx,
  subject: RaceSubject,
  name: string,
  effort: Effort,
  signal: AbortSignal,
  getEnv: () => Promise<VerifyEnv>,
  opts: { verify: boolean; review: boolean; onChecking: () => void },
): Promise<Candidate> {
  const slug = c.book.slug;
  const id = subject.kind === "outline" ? subject.o.id : subject.spec.id;
  const unit = pseudo(c.unit.unit, id, name);
  const cand: Candidate = { name, effort, unit, status: "error" };
  cleanCandidate(slug, unit); // its own leftovers from an earlier run only
  spent.set(`${slug}/${unit}`, slug);
  const cc: Ctx = { ...c, unit: { ...c.unit, unit } };
  try {
    if (subject.kind === "outline") {
      const g = await generateDemo(cc, subject.o, subject.plan, subject.others, { effort, accept: false, quiet: true, signal });
      cand.spec = g.spec;
      if (!g.spec) return { ...cand, status: "nospec", why: g.why ?? "no usable spec" };
      if (!g.ok) return { ...cand, status: "build", why: g.why ?? "does not typecheck" };
    } else {
      cand.spec = subject.spec;
      if (!(await buildDemo(cc, subject.spec, { effort, quiet: true, signal }))) return { ...cand, status: "build", why: "does not typecheck" };
    }
    if (signal.aborted) return { ...cand, status: "aborted" };
    if (!opts.verify) return { ...cand, status: "pass" };
    // The candidate's own plan.json, so isolated mode can render it.
    writeJson(paths.plan(slug, unit), { book: slug, unit, demos: [cand.spec] });
    opts.onChecking();
    const check = await checkDemo(await getEnv(), cc, cand.spec!, paths.verifyDir(slug, unit));
    cand.check = check;
    if (!check.ok) return { ...cand, status: "checks", why: check.notes[0] };
    if (signal.aborted) return { ...cand, status: "aborted" };
    if (opts.review) {
      const r = await reviewSheet(cc, cand.spec!, check);
      cand.review = r;
      if (!r.pass) return { ...cand, status: "review", why: r.issues[0] };
    }
    return { ...cand, status: "pass" };
  } catch (e) {
    if (e instanceof AbortedError || signal.aborted) return { ...cand, status: "aborted" };
    return { ...cand, status: "error", why: (e as Error).message };
  }
}

/** Move a candidate's verify artefacts into the real verify dir and point its check at them. */
function moveArtefacts(from: string, to: string, check?: CheckResult): CheckResult | undefined {
  fs.mkdirSync(to, { recursive: true });
  const moved = (f: string) => (f && f.startsWith(from) ? path.join(to, path.relative(from, f)) : f);
  if (fs.existsSync(from))
    for (const f of fs.readdirSync(from)) {
      const src = path.join(from, f);
      if (fs.statSync(src).isFile()) fs.renameSync(src, path.join(to, f));
    }
  if (!check) return undefined;
  return { ...check, sheet: moved(check.sheet), shots: check.shots.map((s) => ({ ...s, shot: moved(s.shot) })) };
}

/** Install a candidate as the demo: code (atomically), spec, conversation and verify artefacts. */
function install(c: Ctx, subject: RaceSubject, cand: Candidate): CheckResult | undefined {
  const slug = c.book.slug;
  const unit = c.unit.unit;
  const spec = cand.spec!;
  const from = paths.component(slug, cand.unit, spec.component);
  const to = paths.component(slug, unit, spec.component);
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.tmp-${process.pid}`; // not *.tsx: the app's registry never sees it
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to);
  }
  if (subject.kind === "outline") subject.plan.accept(spec);
  else if (JSON.stringify(spec) !== JSON.stringify(subject.spec)) saveSpec(slug, unit, spec);
  const convo = loadConvo(slug, cand.unit, spec.id);
  if (convo) saveConvo({ ...convo, unit });
  return moveArtefacts(paths.verifyDir(slug, cand.unit), paths.verifyDir(slug, unit), cand.check);
}

/**
 * Race the candidates for one demo. `c` is the real unit's context (pages ready). Resolves as soon
 * as a candidate passes (the others are aborted and cleaned up in the background), or when all
 * have finished without a pass (the best is installed for the fix loop).
 */
export async function raceDemo(
  c: Ctx,
  subject: RaceSubject,
  getEnv: () => Promise<VerifyEnv>,
  opts: { verify: boolean; review: boolean },
): Promise<RaceOutcome> {
  const slug = c.book.slug;
  const unit = c.unit.unit;
  const t = tag(slug, unit);
  const id = subject.kind === "outline" ? subject.o.id : subject.spec.id;
  const efforts = raceEfforts();
  emit({ type: "demo", unit, id, phase: "building", detail: `racing ${efforts.join(" and ")}-effort drafts` });
  let checking = false;
  const onChecking = () => {
    if (checking) return;
    checking = true;
    emit({ type: "demo", unit, id, phase: "verifying", beats: subject.kind === "spec" ? subject.spec.beats.length : subject.o.beats.length });
  };
  const ctrls = efforts.map(() => new AbortController());
  const results: (Candidate | undefined)[] = efforts.map(() => undefined);
  let winner: Candidate | undefined;
  const runs = efforts.map((effort, i) =>
    runCandidate(c, subject, effort, effort, ctrls[i].signal, getEnv, { ...opts, onChecking }).then((r) => {
      results[i] = r;
      if (!winner && r.status === "pass") {
        winner = r;
        ctrls.forEach((ctl, j) => j !== i && ctl.abort());
      }
      return r;
    }),
  );

  // Done when a candidate passes, or when every candidate has finished.
  await new Promise<void>((resolve) => {
    let left = runs.length;
    for (const r of runs)
      void r.then((cand) => {
        left--;
        if (cand.status === "pass" || left === 0) resolve();
      });
  });

  const finish = (_installed: Candidate | undefined) => {
    // Losers may still be aborting or mid-check: the run waits for them (raceIdle) before it closes
    // the browser; their files (and the installed one's) are removed by cleanupRaces at the end.
    for (const r of runs) {
      const p = r.then(() => undefined);
      background.add(p);
      void p.finally(() => background.delete(p));
    }
  };

  if (winner) {
    const check = install(c, subject, winner);
    finish(winner);
    log(`race ${t} ${id}: ${winner.name} draft won`);
    const spec = winner.spec!;
    const result: DemoResult | undefined = check ? { id: spec.id, component: spec.component, rounds: 0, pass: true, beats: toResults(check, true, []) } : undefined;
    if (check) emit({ type: "demo", unit, id, phase: "pass", beatsPassed: spec.beats.length, beats: spec.beats.length, detail: `${winner.name}-effort draft` });
    return { spec, passed: true, result, built: true, winner: winner.name };
  }

  // No pass: install the best candidate that has a spec and code; the fix loop continues from it.
  const done = results.filter((r): r is Candidate => !!r);
  const best = [...done].filter((r) => r.spec && r.status !== "nospec" && r.status !== "aborted" && r.status !== "error").sort((a, b) => rank(a) - rank(b))[0];
  if (!best) {
    finish(undefined);
    const why = done.map((r) => `${r.name}: ${r.why ?? r.status}`).join("; ");
    log(`race ${t} ${id}: no usable draft (${why})`);
    return { passed: false, built: false, why: done.find((r) => r.why)?.why ?? "no usable draft" };
  }
  const check = install(c, subject, best);
  finish(best);
  log(`race ${t} ${id}: no draft passed; continuing with the ${best.name} draft (${best.status})`);
  if (best.status === "build") return { spec: best.spec, passed: false, built: false, why: best.why ?? "does not typecheck", winner: best.name };
  return { spec: best.spec, passed: false, built: true, initial: check ? { check, review: best.review } : undefined, why: best.why, winner: best.name };
}
