// Verify step: render every beat of a demo in a headless browser (isolated
// mode: /?demo=<book>/<unit>/<id>&beat=<i>), screenshot it, and have Sonnet
// review the screenshots against the text. Failing demos go back to their
// build conversation with the issues and screenshots, up to `rounds` times.
// Output: work/<slug>/verify/<unit>/*.png and report.json.
//
// One VerifyEnv (a Vite dev server + one Chromium) is shared by every demo in a
// run; the beats of a demo are shot in parallel pages, bounded by a page limit.

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { callJson, pool, roleModel } from "../lib/claude";
import { Limit } from "../lib/limit";
import { emit } from "../lib/report";
import type { BookConfig, DemoSpec, Expectation, ReadoutSpec } from "../../src/types";
import { demoRegions, loadConvo, regionsBlock, runConvo, saveSpec, toFixTurn } from "./build";
import { anchorContext, anchorCrop, type Ctx, loadCtx, loadPlan, log, paths, pngBlock, tag, textSourceNote, writeJson } from "./common";
import { domainOf } from "./domains";
import { staticAudit } from "./rules";

const HOST = "127.0.0.1";
/** Preferred port; other local projects often hold it, so any free port is the fallback. */
const PORT = 5192;
const VIEWPORT = { width: 560, height: 760 };
/** Screenshot times after the demo reports ready. */
const SHOT_A_MS = 400;
const SHOT_B_MS = 1400;

interface BeatShot {
  beat: number;
  anchor: string;
  ready: boolean;
  errors: string[];
  readouts: Record<string, string>;
  /** Fraction of stage pixels that changed between the two screenshots. */
  changed: number;
  shots: [string, string];
}

export interface BeatResult extends BeatShot {
  pass: boolean;
  issues: string[];
}

export interface DemoResult {
  id: string;
  component: string;
  rounds: number;
  pass: boolean;
  beats: BeatResult[];
  /** Non-fatal notes, e.g. expectations dropped because they disagreed with a reviewed demo. */
  warnings?: string[];
}

const ReviewSchema = z.object({
  beats: z.array(z.object({ beat: z.number(), pass: z.boolean(), issues: z.array(z.string()) })),
});

// --- Environment ---------------------------------------------------------------

export interface VerifyEnv {
  server: ViteDevServer;
  browser: Browser;
  baseUrl: string;
  pages: Limit;
}

async function startServer(): Promise<{ server: ViteDevServer; baseUrl: string }> {
  for (const port of [PORT, 0]) {
    const server = await createServer({
      // No HMR: files are written while other demos are being shot; each page load gets fresh modules anyway.
      server: { host: HOST, port, strictPort: true, hmr: false },
      optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "katex"] },
      logLevel: "silent",
      clearScreen: false,
    });
    try {
      await server.listen();
    } catch {
      await server.close();
      continue;
    }
    const addr = server.httpServer?.address();
    return { server, baseUrl: `http://${HOST}:${addr && typeof addr === "object" ? addr.port : port}` };
  }
  throw new Error("could not start the Vite dev server");
}

export async function startEnv(maxPages = 8): Promise<VerifyEnv> {
  const [{ server, baseUrl }, browser] = await Promise.all([startServer(), chromium.launch()]);
  // Warm up: first load triggers dependency optimisation; do it once before shooting.
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "load" }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.close();
  return { server, browser, baseUrl, pages: new Limit(maxPages) };
}

export async function closeEnv(env: VerifyEnv): Promise<void> {
  await env.browser.close().catch(() => undefined);
  await env.server.close().catch(() => undefined);
}

// --- Shooting --------------------------------------------------------------------

async function stageDiff(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return 1;
  const ch = ra.info.channels;
  let diff = 0;
  for (let i = 0; i < ra.data.length; i += ch) {
    if (Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2]) > 24) diff++;
  }
  return diff / (ra.data.length / ch);
}

async function shootBeat(page: Page, env: VerifyEnv, c: Ctx, demo: DemoSpec, beat: number, outDir: string): Promise<BeatShot> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Download the React DevTools/.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const shots: [string, string] = [path.join(outDir, `${demo.id}-${beat}-a.png`), path.join(outDir, `${demo.id}-${beat}-b.png`)];
  let ready = false;
  const load = async () => {
    try {
      await page.goto(`${env.baseUrl}/?demo=${c.book.slug}/${c.unit.unit}/${demo.id}&beat=${beat}`, { waitUntil: "load" });
      await page.waitForFunction(() => (globalThis as unknown as { __demoReady?: boolean }).__demoReady === true, null, { timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  };
  ready = await load();
  // A demo file written moments ago can still be missing from Vite's module graph:
  // invalidate and reload once before treating a missing stage as a real failure.
  if (!ready || (await page.locator("canvas").count()) === 0) {
    env.server.moduleGraph.invalidateAll();
    await page.waitForTimeout(400);
    errors.length = 0;
    ready = await load();
  }
  if (!ready) errors.push("demo did not become ready within 20s (window.__demoReady never set)");
  await page.waitForTimeout(SHOT_A_MS);
  const stage = page.locator("[data-stage] canvas, canvas").first();
  const hasStage = (await stage.count()) > 0;
  await page.screenshot({ path: shots[0] });
  const s1 = hasStage ? await stage.screenshot().catch(() => null) : null;
  await page.waitForTimeout(SHOT_B_MS - SHOT_A_MS);
  await page.screenshot({ path: shots[1] });
  const s2 = hasStage ? await stage.screenshot().catch(() => null) : null;
  const changed = s1 && s2 ? await stageDiff(s1, s2) : 0;
  if (!hasStage) errors.push("no <canvas> stage rendered");

  const appErrors = await page.evaluate(() => (globalThis as unknown as { __demoErrors?: unknown[] }).__demoErrors ?? []).catch(() => []);
  for (const e of appErrors) errors.push(`app: ${typeof e === "string" ? e : JSON.stringify(e)}`);
  const readouts = await page
    .$$eval("[data-readout]", (els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-readout") ?? "", (el.textContent ?? "").trim()])))
    .catch(() => ({}) as Record<string, string>);
  return { beat, anchor: demo.beats[beat].anchor, ready, errors: [...new Set(errors)], readouts, changed, shots };
}

/** Shoot every beat of a demo in parallel pages (bounded by env.pages). */
async function shootDemo(env: VerifyEnv, c: Ctx, demo: DemoSpec, outDir: string): Promise<BeatShot[]> {
  // HMR is off, so Vite doesn't re-expand the app's import.meta.glob when demo files or
  // plan.json are written mid-run. Invalidate so the next page load sees the files on disk.
  env.server.moduleGraph.invalidateAll();
  return Promise.all(
    demo.beats.map((_, i) =>
      env.pages.run(async () => {
        const page = await env.browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
        try {
          return await shootBeat(page, env, c, demo, i, outDir);
        } finally {
          await page.close().catch(() => undefined);
        }
      }),
    ),
  );
}

// --- Deterministic checks --------------------------------------------------------
//
// Run before any model review: everything a script can decide (errors, a blank
// stage, broken readouts, values the text pins down, overlapping or clipped
// labels) is decided here and fed back to the builder as precise notes, so a
// model review is only spent on what needs judgement.

/** Text box recorded by the kit's Stage in isolated mode (CSS px, stage coordinates). */
interface TextBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated?: boolean;
}

/** Bounds of a filled/stroked shape on the stage (CSS px), from the kit's isolated-mode instrumentation. */
export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "fill" | "stroke";
  closed?: boolean;
}

/** A later state of a beat: the demo run forward (deterministic frames) to about `t` seconds. */
export interface LaterSample {
  t: number;
  readouts: Record<string, string>;
  /** Full demo-pane screenshot at that time. */
  shot: string;
  /** Fraction of stage pixels that differ from the ~1 s frame. */
  changedFrom1s: number;
  text: TextBox[];
  shapes: ShapeBox[];
}

/** One beat rendered for the checks: a settled screenshot at ~1 s, later samples, and what the page reports. */
export interface CheckShot {
  beat: number;
  anchor: string;
  ready: boolean;
  errors: string[];
  readouts: Record<string, string>;
  /** Fraction of stage pixels that changed over the last ~0.4 s before the screenshot. */
  changed: number;
  /** Fraction of stage pixels that differ from the background. */
  ink: number;
  /** Full demo-pane screenshot at the settle time. */
  shot: string;
  text: TextBox[];
  /** Text boxes ~0.4 s earlier: an overlap must be present in both samples (moving labels cross others briefly). */
  textBefore?: TextBox[];
  stage: { w: number; h: number } | null;
  /** Shapes drawn in the ~1 s frame. */
  shapes?: ShapeBox[];
  /** The beat run on to ~6 s and ~16 s, so step-throughs show their later and final states. */
  later?: LaterSample[];
  /** What the stage wrote, sampled every second from ~1 s to the last sample (only when it changed). */
  timeline?: { t: number; text: string }[];
}

export interface CheckResult {
  /** Every deterministic check passed. */
  ok: boolean;
  /** Machine-written, actionable notes (empty when ok). */
  notes: string[];
  /** Checks passed and a model review is still wanted (the orchestrator decides whether to spend it). */
  needsReview: boolean;
  shots: CheckShot[];
  /** All beats tiled into one image (for the model review). */
  sheet: string;
}

/** Settle time before the screenshot; the stage is sampled twice ~0.4 s apart to measure motion. */
const SETTLE_MS = 1000;
const MOTION_GAP_MS = 400;
/**
 * After the ~1 s frame each beat is run forward (deterministic 30 fps frames) and sampled again:
 * step-throughs often reach their key state late, so checks and review see ~6 s and ~16 s too.
 */
const LATER_SAMPLES = [6, 16];

/** Thresholds (tuned on the existing library; see work/qa/checks/report.json). */
export const CHECK_LIMITS = {
  /** A stage is blank when it draws no labels and less than this fraction of its pixels differ from the background… */
  blankInk: 0.0015,
  /** …or, even with labels, when almost nothing is drawn at all. */
  blankInkHard: 0.0002,
  /** Labels may overhang the stage edge by this much (px) before they count as clipped. */
  edgeSlack: 1.5,
  /** Two labels overlap when their boxes intersect by more than this in both directions (px)… */
  overlapPx: 2.5,
  /** …and the intersection covers at least this share of the smaller box. */
  overlapShare: 0.2,
  /** Default relative tolerance for expected values. */
  tol: 0.02,
  /** A shape is cut off when it overhangs the stage edge by more than this (px)… */
  shapeOverhang: 6,
  /** …unless it spans most of the stage in that direction (background, ground or axis lines). */
  shapeSpanShare: 0.8,
  /** Stage pixels that may change between samples while still counting as "nothing changes". */
  staticDiff: 0.0015,
};

async function inkFraction(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  // Background = the most common colour among the four corners.
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * ch;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const corners = [at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1)];
  const bg = corners.sort((a, b) => corners.filter((c) => c.join() === b.join()).length - corners.filter((c) => c.join() === a.join()).length)[0];
  let ink = 0;
  for (let i = 0; i < data.length; i += ch) if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 30) ink++;
  return ink / (data.length / ch);
}

async function shootSettled(page: Page, env: VerifyEnv, c: Ctx, demo: DemoSpec, beat: number, outDir: string): Promise<CheckShot> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Download the React DevTools/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const shot = path.join(outDir, `${demo.id}-${beat}.png`);
  const load = async () => {
    try {
      await page.goto(`${env.baseUrl}/?demo=${c.book.slug}/${c.unit.unit}/${demo.id}&beat=${beat}`, { waitUntil: "load" });
      await page.waitForFunction(() => (globalThis as unknown as { __demoReady?: boolean }).__demoReady === true, null, { timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  };
  let ready = await load();
  // A demo file written moments ago can still be missing from Vite's module graph: reload once.
  if (!ready || (await page.locator("canvas").count()) === 0) {
    env.server.moduleGraph.invalidateAll();
    await page.waitForTimeout(400);
    errors.length = 0;
    ready = await load();
  }
  if (!ready) errors.push("demo did not become ready within 20s (window.__demoReady never set)");
  const stage = page.locator("[data-stage] canvas, canvas").first();
  const hasStage = (await stage.count()) > 0;
  await page.waitForTimeout(SETTLE_MS - MOTION_GAP_MS);
  const s1 = hasStage ? await stage.screenshot().catch(() => null) : null;
  const textBefore = await page.evaluate(() => (globalThis as unknown as { __stageText?: TextBox[] }).__stageText ?? []).catch(() => [] as TextBox[]);
  await page.waitForTimeout(MOTION_GAP_MS);
  const s2 = hasStage ? await stage.screenshot().catch(() => null) : null;
  await page.screenshot({ path: shot });
  const changed = s1 && s2 ? await stageDiff(s1, s2) : 0;
  const ink = s2 ? await inkFraction(s2) : 0;
  if (!hasStage) errors.push("no <canvas> stage rendered");
  const info = await page
    .evaluate(() => {
      const w = globalThis as unknown as { __demoErrors?: unknown[]; __stageText?: TextBox[]; __stageSize?: { w: number; h: number } };
      return { appErrors: w.__demoErrors ?? [], text: w.__stageText ?? [], stage: w.__stageSize ?? null };
    })
    .catch(() => ({ appErrors: [] as unknown[], text: [] as TextBox[], stage: null }));
  for (const e of info.appErrors) errors.push(`app: ${typeof e === "string" ? e : JSON.stringify(e)}`);
  // The shell shows non-finite readouts as "—" and marks them data-broken: report those as NaN.
  const readNow = () =>
    page
      .$$eval("[data-readout]", (els) =>
        Object.fromEntries(els.map((el) => [el.getAttribute("data-readout") ?? "", el.getAttribute("data-broken") ? "NaN" : (el.textContent ?? "").trim()])),
      )
      .catch(() => ({}) as Record<string, string>);
  const readouts = await readNow();
  const shapes = await page.evaluate(() => (globalThis as unknown as { __stageShapes?: ShapeBox[] }).__stageShapes ?? []).catch(() => [] as ShapeBox[]);

  // Run the beat on and sample its later states (step-throughs reach their key state late).
  const later: LaterSample[] = [];
  // The stage's own words over time (step captions like "3/5 · …"): the reviewer sees states the
  // three frames miss. Advancing in 1 s steps is the same deterministic run as one big step.
  const timeline: { t: number; text: string }[] = [];
  const note = (t: number, boxes: TextBox[]) => {
    const text = stageWords(boxes);
    if (text && timeline[timeline.length - 1]?.text !== text) timeline.push({ t, text });
  };
  note(SETTLE_MS / 1000, info.text);
  if (ready && hasStage) {
    let at = SETTLE_MS / 1000;
    for (const t of LATER_SAMPLES) {
      let failed = false;
      while (at < t) {
        const step = Math.min(1, t - at);
        try {
          const boxes = await page.evaluate((sec) => {
            const w = globalThis as unknown as { __stageAdvance?: (s: number) => void; __stageText?: TextBox[] };
            w.__stageAdvance?.(sec);
            return w.__stageText ?? [];
          }, step);
          at += step;
          note(Math.round(at), boxes);
        } catch (e) {
          errors.push(`runtime error while running on to t≈${t} s: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}`);
          failed = true;
          break;
        }
      }
      if (failed) break;
      await page.waitForTimeout(250); // the shell publishes readouts at 10 Hz
      const st = await stage.screenshot().catch(() => null);
      const file = path.join(outDir, `${demo.id}-${beat}-t${t}.png`);
      await page.screenshot({ path: file });
      const got = await page
        .evaluate(() => {
          const w = globalThis as unknown as { __stageText?: TextBox[]; __stageShapes?: ShapeBox[] };
          return { text: w.__stageText ?? [], shapes: w.__stageShapes ?? [] };
        })
        .catch(() => ({ text: [] as TextBox[], shapes: [] as ShapeBox[] }));
      later.push({ t, readouts: await readNow(), shot: file, changedFrom1s: s2 && st ? await stageDiff(s2, st) : 0, text: got.text, shapes: got.shapes });
    }
  }
  return { beat, anchor: demo.beats[beat].anchor, ready, errors: [...new Set(errors)], readouts, changed, ink, shot, text: info.text, textBefore, stage: info.stage, shapes, later, timeline };
}

/** Stage text in reading order (top to bottom, left to right), as one line. */
function stageWords(boxes: TextBox[]): string {
  const words = [...boxes].sort((a, b) => Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x).map((b) => b.text.trim()).filter(Boolean);
  const line = words.join(" · ");
  return line.length > 400 ? line.slice(0, 399) + "…" : line;
}

const SUPER: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };

/**
 * Every number in a readout's text, in order: handles unicode minus, thousands
 * separators, e-notation, "×10^k" / "×10ᵏ" / "·10^k", and "%" (both the shown
 * value and the fraction are candidates).
 */
export function numbersIn(text: string): number[] {
  const t = text
    .replace(/[−‒–]/g, "-")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (m) => "^" + [...m].map((ch) => SUPER[ch]).join(""))
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d)[   ](\d{3})(?!\d)/g, "$1$2");
  const out: number[] = [];
  const re = /(-?\d+(?:\.\d+)?|-?\.\d+)(?:[eE]([+-]?\d+))?(?:\s*[×x·*]\s*10\s*\^\s*\(?([+-]?\d+)\)?)?(\s*%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    let v = Number(m[1]);
    if (m[2]) v *= 10 ** Number(m[2]);
    if (m[3]) v *= 10 ** Number(m[3]);
    if (!Number.isFinite(v)) continue;
    out.push(v);
    if (m[4]) out.push(v / 100);
  }
  return out;
}

const close = (got: number, want: number, tol: number) => (tol === 0 ? Math.abs(got - want) < 1e-9 * Math.max(1, Math.abs(want)) : Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-12));

/** A readout that shows no usable value (never published, or a broken number). */
const BROKEN = /\b(NaN|Infinity|undefined|null)\b/;

function boxesOverlap(a: TextBox, b: TextBox): { x: number; y: number } | null {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= CHECK_LIMITS.overlapPx || iy <= CHECK_LIMITS.overlapPx) return null;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  if (minArea <= 0 || (ix * iy) / minArea < CHECK_LIMITS.overlapShare) return null;
  return { x: Math.round(Math.max(a.x, b.x) + ix / 2), y: Math.round(Math.max(a.y, b.y) + iy / 2) };
}

/** Overlapping label pairs on one frame; `key` identifies the pair with digits ignored. */
function overlapsOf(text: TextBox[]): { a: string; b: string; x: number; y: number; key: string }[] {
  const flat = text.filter((b) => !b.rotated && b.w > 0 && b.h > 0);
  const out: { a: string; b: string; x: number; y: number; key: string }[] = [];
  const norm = (t: string) => t.replace(/\d/g, "#");
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i];
      const b = flat[j];
      // The same string drawn twice at the same spot (e.g. a shadow pass) is not a collision.
      if (a.text === b.text && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2) continue;
      const o = boxesOverlap(a, b);
      if (o) out.push({ a: a.text, b: b.text, ...o, key: [norm(a.text), norm(b.text)].sort().join("\u0000") });
    }
  return out;
}

const q = (s: string) => `"${s.length > 40 ? s.slice(0, 39) + "…" : s}"`;

/** A readout label without $LaTeX$, commands or punctuation, lower-cased (for matching against captions). */
const plainLabel = (s: string) =>
  s
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-z]+/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The valid range of a readout: its spec `range`, else one its label makes certain (a probability is in
 * [0, 1]; an error rate, accuracy, utilization or fraction shown in % is in [0, 100]; a count is ≥ 0).
 * Conservative: anything a label doesn't pin down has no implied range.
 */
export function readoutRange(r: ReadoutSpec, text: string): { range: [number, number]; implied: boolean } | null {
  if (r.range && r.range.length === 2 && r.range.every((v) => typeof v === "number")) return { range: r.range, implied: false };
  const l = plainLabel(`${r.label} ${r.id}`);
  const raw = r.label.toLowerCase();
  const pct = /%/.test(text);
  if (/\b(probability|probabilities|likelihood|chance)\b/.test(l) || /(^|[^a-z\\])p\s*\(/.test(raw)) return { range: pct ? [0, 100] : [0, 1], implied: true };
  if (pct && /\b(error|accuracy|utili[sz]ation|occupancy|fraction|share)\b/.test(l)) return { range: [0, 100], implied: true };
  if (/\b(fraction|share)\b/.test(l)) return { range: pct ? [0, 100] : [0, 1], implied: true };
  if (/^(number of|count)\b/.test(l) || /^#/.test(r.label.trim())) return { range: [0, Infinity], implied: true };
  return null;
}

/** Captions that describe something happening over time (conservative: verbs of a process, not of the reader's actions). */
const PROCESS =
  /\b(one after another|one at a time|one by one|step by step|steps? through|stepping through|frame by frame|over time|as time (goes on|passes)|animat(es|ed|ing)|simulat(es|ed|ing)|travel(s|led|ling|ing)|propagat(es|ed|ing)|in turn)\b/i;
/** Captions that tell the reader to change something: the stage then waits for the reader, legitimately static. */
const READER_ACTION =
  /(^|[.!?:;]\s+)(drag|change|choose|pick|set|move|slide|raise|lower|increase|decrease|toggle|switch|lengthen|shorten|turn|select|try|push|pull|click|press|vary|adjust|compare|step)\b/i;

/**
 * Readout texts that say "no value yet" in words (a state never reached). Not "—": a readout that
 * doesn't apply to a beat shows that legitimately.
 */
const NULLISH = /^(none|not yet|nothing|pending|waiting|undecided|unknown)$/i;
const STOPWORDS = new Set(["value", "values", "current", "total", "number", "count", "readout", "this", "that", "with", "from", "after", "each"]);

/** Number words captions use for simple fractions. */
const WORD_NUMS: [RegExp, number][] = [
  [/^one half$|^a half$|^half$/i, 0.5],
  [/^one third$|^a third$/i, 1 / 3],
  [/^two thirds$/i, 2 / 3],
  [/^one quarter$|^a quarter$|^one fourth$/i, 0.25],
  [/^three quarters$|^three fourths$/i, 0.75],
];
const NUM_RE = String.raw`(-?\d+(?:\.\d+)?(?:\s*%)?|one half|a half|half|one third|a third|two thirds|one quarter|a quarter|one fourth|three quarters|three fourths)`;
const wordNum = (t: string): number[] => {
  for (const [re, v] of WORD_NUMS) if (re.test(t.trim())) return [v];
  return numbersIn(t);
};
const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, 0.05 * Math.abs(b));

/** Shapes partly visible and cut off by a stage edge (not ones spanning the stage, like a ground line). */
function clippedShapes(shapes: ShapeBox[], W: number, H: number): { side: string; cx: number; cy: number; desc: string }[] {
  const m = CHECK_LIMITS.shapeOverhang;
  const out: { side: string; cx: number; cy: number; desc: string }[] = [];
  for (const b of shapes) {
    // Filled or outlined shapes only (boxes, bars, discs): an open line running off the stage is usually deliberate.
    if ((b.kind !== "fill" && !b.closed) || !(b.w >= 0 && b.h >= 0)) continue;
    const visible = b.x < W && b.x + b.w > 0 && b.y < H && b.y + b.h > 0;
    if (!visible) continue;
    const cx = Math.round(b.x + b.w / 2);
    const cy = Math.round(b.y + b.h / 2);
    // A band across the stage (background, ground, a full-width panel) runs off it on purpose.
    if (b.w > CHECK_LIMITS.shapeSpanShare * W || b.h > CHECK_LIMITS.shapeSpanShare * H) continue;
    const span = `x ${Math.round(b.x)}–${Math.round(b.x + b.w)}, y ${Math.round(b.y)}–${Math.round(b.y + b.h)}`;
    if (b.x < -m) out.push({ side: "left", cx, cy, desc: `the left edge (${span} on a ${W}×${H} stage)` });
    else if (b.x + b.w > W + m) out.push({ side: "right", cx, cy, desc: `the right edge (${span} on a ${W}×${H} stage)` });
    else if (b.y < -m) out.push({ side: "top", cx, cy, desc: `the top edge (${span} on a ${W}×${H} stage)` });
    else if (b.y + b.h > H + m) out.push({ side: "bottom", cx, cy, desc: `the bottom edge (${span} on a ${W}×${H} stage)` });
  }
  return out;
}

/** Per-beat findings for one rendered beat (without the beat prefix, so equal findings group across beats). */
export function findings(demo: DemoSpec, s: CheckShot, expect: Expectation[]): string[] {
  const out: string[] = [];
  if (!s.ready) return ["the demo did not render (no __demoReady within 20 s)"];
  for (const e of s.errors) out.push(`runtime error: ${e}`);
  // Sparse stages (a few dots and small labels) are fine: blank means no labels and almost no ink.
  if (s.stage && (s.ink < CHECK_LIMITS.blankInkHard || (s.ink < CHECK_LIMITS.blankInk && s.text.length === 0))) out.push("the stage is blank (nothing drawn after 1 s)");

  // Readouts.
  const shown = demo.readouts.map((r) => ({ r, text: s.readouts[r.id] }));
  for (const { r, text } of shown) {
    if (text === undefined) out.push(`readout ${q(r.label)} (${r.id}) is missing from the page`);
    else if (BROKEN.test(text)) out.push(`readout ${q(r.label)} (${r.id}) shows ${q(text)}`);
  }
  if (shown.length && shown.every(({ text }) => text === undefined || text === "—" || text === "")) out.push("no readout was published (setReadouts was never called with these ids)");
  for (const e of expect.filter((x) => x.beat === s.beat)) {
    const spec = demo.readouts.find((r) => r.id === e.readout);
    const label = spec ? `${q(spec.label)} (${e.readout})` : e.readout;
    const text = s.readouts[e.readout];
    if (text === undefined) continue; // already reported as missing
    const nums = numbersIn(text);
    const tol = e.tol ?? CHECK_LIMITS.tol;
    if (!nums.some((n) => close(n, e.value, tol))) out.push(`readout ${label} shows ${q(text)}, the text gives ${e.value}${tol ? ` (±${Math.round(tol * 1000) / 10}%)` : " (exact)"}`);
  }

  // Readouts outside their valid range (spec `range`, else implied by the label), at any sampled time.
  const samples: { t: string; readouts: Record<string, string> }[] = [{ t: "1 s", readouts: s.readouts }, ...(s.later ?? []).map((l) => ({ t: `${l.t} s`, readouts: l.readouts }))];
  for (const r of demo.readouts) {
    for (const smp of samples) {
      const text = smp.readouts[r.id];
      if (text === undefined || text === "—" || BROKEN.test(text)) continue;
      const rr = readoutRange(r, text);
      if (!rr) continue;
      const nums = numbersIn(text);
      const [lo, hi] = rr.range;
      const eps = (v: number) => 1e-9 * Math.max(1, Math.abs(v));
      if (nums.length && nums.every((n) => n < lo - eps(lo) || n > hi + eps(hi))) {
        out.push(`readout ${q(r.label)} (${r.id}) shows ${q(text)} at ${smp.t}, outside its valid range [${lo}, ${hi === Infinity ? "∞" : hi}]${rr.implied ? " (implied by its label)" : ""}`);
        break;
      }
    }
  }

  const caption = demo.beats[s.beat]?.caption ?? "";
  const later = s.later ?? [];
  // The caption describes a process, but neither the stage nor any readout changes over ~16 s.
  const proc = PROCESS.exec(caption);
  if (proc && !READER_ACTION.test(caption) && later.length === LATER_SAMPLES.length) {
    const stageStatic = later.every((l) => l.changedFrom1s < CHECK_LIMITS.staticDiff) && s.changed < CHECK_LIMITS.staticDiff;
    const readoutsStatic = demo.readouts.every((r) => later.every((l) => l.readouts[r.id] === s.readouts[r.id]));
    if (stageStatic && readoutsStatic) out.push(`the caption describes a process (${q(proc[0])}) but neither the stage nor any readout changes over ~${LATER_SAMPLES[LATER_SAMPLES.length - 1]} s`);
  }
  // A readout that never shows a value while the caption talks about it ("… its value is chosen" / "chosen: none").
  for (const r of demo.readouts) {
    const vals = samples.map((smp) => smp.readouts[r.id]).filter((v): v is string => v !== undefined);
    if (vals.length < samples.length || !vals.every((v) => NULLISH.test(v.trim()))) continue;
    const keys = plainLabel(r.label)
      .split(" ")
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    for (const k of keys) {
      const m = new RegExp(`(?:^|\\W)((?:\\S+\\s+){0,3})${escRe(k)}\\w*`, "i").exec(caption);
      if (!m) continue;
      if (/\b(no|not|never|nothing|without|none|yet|until|before|unless)\b/i.test(m[1])) continue;
      out.push(`readout ${q(r.label)} (${r.id}) shows ${q(vals[0])} at every sampled time (1–${LATER_SAMPLES[LATER_SAMPLES.length - 1]} s), but the caption speaks of it (${q(k)})`);
      break;
    }
  }
  // A caption that states a readout's value outright ("the sum readout stays at 1") must agree with it.
  for (const r of demo.readouts) {
    const label = plainLabel(r.label);
    if (label.length < 3) continue;
    const re = new RegExp(`\\b${label.split(" ").map(escRe).join("\\s+")}(?:\\s+readout)?\\s+(?:reads|shows|stays at|stays|settles (?:at|on|to)|reaches|equals|is|=|≈)\\s+(?:about\\s+|exactly\\s+|roughly\\s+)?${NUM_RE}`, "i");
    const m = re.exec(caption);
    if (!m) continue;
    // Not "144 crops reaches …" (the label as a noun after a number), not "2πGμ" (a symbol, not a value).
    if (/\d\s*$/.test(caption.slice(0, m.index))) continue;
    const after = caption.slice(m.index + m[0].length);
    if (/^(?:[\p{L}π\\^(_]|\.\d|\s*[×·*/^])/u.test(after)) continue;
    // A percentage in the caption is only compared with a percentage readout.
    if (/%/.test(m[1]) && !samples.some((smp) => /%/.test(smp.readouts[r.id] ?? ""))) continue;
    const want = wordNum(m[1]);
    if (!want.length) continue;
    const got = samples.flatMap((smp) => (smp.readouts[r.id] === undefined ? [] : numbersIn(smp.readouts[r.id])));
    if (got.length && !want.some((w) => got.some((g) => near(g, w)))) {
      const shown = [...new Set(samples.map((smp) => smp.readouts[r.id]).filter(Boolean))].slice(0, 3).join(", ");
      out.push(`the caption says ${q(r.label)} is ${m[1]}, but the readout shows ${q(shown)}`);
    }
  }

  // Shapes cut off by the stage edge, in both the ~1 s frame and the last sample (layout, not motion).
  if (s.stage && s.shapes && later.length) {
    const lastShapes = later[later.length - 1].shapes;
    const a = clippedShapes(s.shapes, s.stage.w, s.stage.h);
    const b = clippedShapes(lastShapes, s.stage.w, s.stage.h);
    const seen = new Set<string>();
    for (const c of a) {
      if (!b.some((d) => d.side === c.side && Math.hypot(d.cx - c.cx, d.cy - c.cy) < 20)) continue;
      const key = `${c.side}:${Math.round(c.cx / 20)}:${Math.round(c.cy / 20)}`;
      if (seen.has(key) || seen.size >= 3) continue;
      seen.add(key);
      out.push(`a drawn shape is cut off at ${c.desc}`);
    }
  }

  // Labels: clipped at the stage edge, or overlapping each other.
  if (s.stage) {
    const W = s.stage.w;
    const H = s.stage.h;
    const k = CHECK_LIMITS.edgeSlack;
    for (const b of s.text) {
      const where = b.x < -k ? `the left edge (x=${Math.round(b.x)})` : b.x + b.w > W + k ? `the right edge (x=${Math.round(b.x + b.w)} > ${W})` : b.y < -k ? `the top edge (y=${Math.round(b.y)})` : b.y + b.h > H + k ? `the bottom edge (y=${Math.round(b.y + b.h)} > ${H})` : null;
      if (where) out.push(`label ${q(b.text)} is clipped at ${where}`);
    }
    // Overlaps that persist: present in both samples (~0.4 s apart) for the same pair of labels
    // (digits ignored, values change) at about the same place. A label riding on a moving
    // object that crosses another one for a moment is not a layout problem.
    const before = s.textBefore ? overlapsOf(s.textBefore) : null;
    for (const o of overlapsOf(s.text)) {
      if (before && !before.some((p) => p.key === o.key && Math.hypot(p.x - o.x, p.y - o.y) < 12)) continue;
      out.push(`labels ${q(o.a)} and ${q(o.b)} overlap at (${o.x},${o.y})`);
    }
  }
  return [...new Set(out)];
}

/** Group equal findings across beats: "beats 1,3: …". */
function groupNotes(perBeat: { beat: number; notes: string[] }[]): string[] {
  const by = new Map<string, number[]>();
  for (const { beat, notes } of perBeat) for (const n of notes) by.set(n, [...(by.get(n) ?? []), beat]);
  return [...by.entries()].map(([n, beats]) => `${beats.length > 1 ? "beats" : "beat"} ${beats.join(",")}: ${n}`);
}

/**
 * Tile the beat screenshots into one image (downscaled): one row per beat, its frames at ~1 s and at
 * each later sample left to right (a step-through only shows its key state late), each labelled.
 */
async function contactSheet(shots: CheckShot[], file: string, scale = 0.4): Promise<string> {
  const rowsIn = shots
    .filter((s) => fs.existsSync(s.shot))
    .map((s) => [{ shot: s.shot, label: `beat ${s.beat} · ~1 s` }, ...(s.later ?? []).filter((l) => fs.existsSync(l.shot)).map((l) => ({ shot: l.shot, label: `beat ${s.beat} · ~${l.t} s` }))]);
  if (!rowsIn.length) return "";
  const tw = Math.round(VIEWPORT.width * scale);
  const th = Math.round(VIEWPORT.height * scale);
  const cols = Math.max(...rowsIn.map((r) => r.length));
  const gap = 8;
  const label = 18;
  const tiles = await Promise.all(
    rowsIn.flatMap((row, ri) =>
      row.map(async (cell, ci) => {
        const img = await sharp(cell.shot).resize(tw, th, { fit: "contain", background: "#0a0a0a" }).png().toBuffer();
        const cap = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${label}"><text x="2" y="13" font-family="sans-serif" font-size="12" fill="#a1a1a1">${cell.label}</text></svg>`);
        const left = ci * (tw + gap);
        const top = ri * (th + label + gap);
        return [
          { input: cap, left, top },
          { input: img, left, top: top + label },
        ];
      }),
    ),
  );
  await sharp({ create: { width: cols * tw + (cols - 1) * gap, height: rowsIn.length * (th + label) + (rowsIn.length - 1) * gap, channels: 3, background: "#000000" } })
    .composite(tiles.flat())
    .png()
    .toFile(file);
  return file;
}

/** Wall-clock limit for one demo's stress audit (it budgets ~3 s of frames; more means it hung). */
const STRESS_TIMEOUT_MS = 30000;

/**
 * Stress audit (no model): the demo is driven by hand in isolated mode `&stress=1` — long runs
 * of every beat, every preset, every control value and extreme combinations, pause/restart,
 * resizes — and every crash, broken readout or blank stage comes back as a note.
 * Set YAGAMI_STRESS=off to skip it.
 */
async function stressDemo(env: VerifyEnv, c: Ctx, demo: DemoSpec): Promise<string[]> {
  if (process.env.YAGAMI_STRESS === "off") return [];
  return env.pages.run(async () => {
    const page = await env.browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${env.baseUrl}/?demo=${c.book.slug}/${c.unit.unit}/${demo.id}&stress=1`, { waitUntil: "load" });
      await page.waitForFunction(() => (globalThis as unknown as { __stress?: { done: boolean } }).__stress?.done === true, null, { timeout: STRESS_TIMEOUT_MS });
      const r = await page.evaluate(() => (globalThis as unknown as { __stress?: { notes: string[] } }).__stress?.notes ?? []);
      return r;
    } catch (e) {
      // A demo that never finishes the audit loops forever or is far too slow per frame.
      return [`stress: the demo didn't finish the stress run within ${STRESS_TIMEOUT_MS / 1000} s (an endless loop, or frames far too slow): ${String((e as Error).message ?? e).split("\n")[0].slice(0, 120)}`];
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/** Render every beat once (settled) and run the deterministic checks (incl. the static and stress audits). No model calls. */
export async function checkDemo(env: VerifyEnv, c: Ctx, demo: DemoSpec, outDir = paths.verifyDir(c.book.slug, c.unit.unit)): Promise<CheckResult> {
  fs.mkdirSync(outDir, { recursive: true });
  env.server.moduleGraph.invalidateAll();
  // Code first: risky patterns are cheap to find and explain (generated components only).
  const file = demo.template ? null : paths.component(c.book.slug, c.unit.unit, demo.component);
  const codeNotes = file && fs.existsSync(file) ? staticAudit(fs.readFileSync(file, "utf8")) : [];
  const [shots, stressNotes] = await Promise.all([
    Promise.all(
      demo.beats.map((_, i) =>
        env.pages.run(async () => {
          const page = await env.browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
          try {
            return await shootSettled(page, env, c, demo, i, outDir);
          } finally {
            await page.close().catch(() => undefined);
          }
        }),
      ),
    ),
    stressDemo(env, c, demo),
  ]);
  const expect = (demo.expect ?? []).filter((e) => e.beat >= 0 && e.beat < demo.beats.length);
  const notes = [...codeNotes, ...groupNotes(shots.map((s) => ({ beat: s.beat, notes: findings(demo, s, expect) }))), ...stressNotes];
  const sheet = await contactSheet(shots, path.join(outDir, `${demo.id}-sheet.png`));
  return { ok: notes.length === 0, notes, needsReview: notes.length === 0, shots, sheet };
}

// --- Review -----------------------------------------------------------------

function reviewSystem(book: BookConfig): string {
  const d = domainOf(book.domain);
  return `You review ${d.demoNoun}s that accompany "${book.title}". Each demo is a canvas animation in a minimal dark UI (thin monochrome lines, one blue accent, small-caps title, caption, controls and numeric readouts below the stage). For each beat you get two screenshots taken ~1 s apart while the demo runs, the beat's caption, the anchored paragraph (a crop of the page plus its ${textSourceNote(book).name}), the demo brief and the readout values.

The screenshots are snapshots in the middle of an animation. Running totals and positions are partial at that moment: do not expect final values. Judge consistency at the snapshot instead: a cumulative readout should match its "predicted from the current state" counterpart, a moving element should be where the process puts it.

Default to pass. Fail a beat only when you are confident ${d.reviewer} would agree it is a real problem:
- the stage does not show what the caption and paragraph describe, or contradicts the text;
${d.reviewChecks}
- broken rendering: blank or nearly empty stage, objects off-screen or clipped, overlapping or illegible labels, NaN/Infinity/undefined readouts, a stage that is frozen although the demo should be animating;
- runtime errors.
Do not fail for taste, minor spacing, partial mid-animation values or things the brief does not ask for. If unsure, pass. Issues (at most 3 per beat) must be concrete and actionable for the engineer: what is wrong, where, and what it should be. Use an empty issues list when a beat passes.`;
}

async function review(c: Ctx, demo: DemoSpec, shots: BeatShot[]): Promise<BeatResult[]> {
  // Hard failures (no render) need no model call.
  if (shots.every((s) => !s.ready)) return shots.map((s) => ({ ...s, pass: false, issues: s.errors }));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `Demo "${demo.title}" (${demo.id}).\n\nBrief:\n${demo.brief}\n\nControls: ${JSON.stringify(demo.controls)}\nReadouts: ${JSON.stringify(demo.readouts)}` },
  ];
  const crops = await Promise.all(
    shots.map(async (s) => {
      const anchor = c.unit.anchors.find((a) => a.id === demo.beats[s.beat].anchor);
      return anchor ? anchorCrop(c, anchor) : null;
    }),
  );
  shots.forEach((s, k) => {
    const b = demo.beats[s.beat];
    content.push({
      type: "text",
      text: `\n## Beat ${s.beat}\nPreset: ${b.preset}${b.params ? `, params ${JSON.stringify(b.params)}` : ""}\nCaption: ${b.caption}\nParagraph (${textSourceNote(c.book).name}):\n${anchorContext(c, b.anchor, 0, 0)}\nReadouts: ${JSON.stringify(s.readouts)}\nStage pixels changed between screenshots: ${(s.changed * 100).toFixed(1)}%\nRuntime errors: ${s.errors.length ? s.errors.join("; ") : "none"}`,
    });
    if (crops[k]) content.push({ type: "text", text: "Anchored region of the page:" }, pngBlock(crops[k]!));
    content.push({ type: "text", text: `Screenshot at ${SHOT_A_MS / 1000} s:` }, pngBlock(fs.readFileSync(s.shots[0])));
    content.push({ type: "text", text: `Screenshot at ${SHOT_B_MS / 1000} s:` }, pngBlock(fs.readFileSync(s.shots[1])));
  });
  content.push({ type: "text", text: `Review every beat (${shots.map((s) => s.beat).join(", ")}). Reply as JSON.` });
  const { data } = await callJson(ReviewSchema, {
    ...roleModel("review"),
    label: `verify:${tag(c.book.slug, c.unit.unit)}:${demo.id}`,
    system: reviewSystem(c.book),
    messages: [{ role: "user", content }],
    maxTokens: 16000,
    // Each review is seen once: caching it would only add the cache-write surcharge.
    cache: false,
  });
  return shots.map<BeatResult>((s) => {
    const r = data.beats.find((x) => x.beat === s.beat);
    const hard = !s.ready || s.errors.length > 0;
    const issues = [...s.errors, ...(r?.issues ?? (r ? [] : ["reviewer returned no verdict"]))];
    return { ...s, pass: !hard && (r?.pass ?? false), issues };
  });
}

// --- Fix loop -----------------------------------------------------------------

function feedback(results: BeatResult[]): Anthropic.Beta.BetaMessageParam {
  const failing = results.filter((r) => !r.pass);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `The demo was rendered in a headless browser (560×760 viewport) and reviewed. These beats failed:\n\n${failing
        .map((r) => `Beat ${r.beat}:\n${r.issues.map((i) => `- ${i}`).join("\n")}\nReadouts: ${JSON.stringify(r.readouts)}`)
        .join("\n\n")}\n\nScreenshots of the failing beats follow.`,
    },
  ];
  for (const r of failing.slice(0, 4)) if (r.shots[1] && fs.existsSync(r.shots[1])) content.push({ type: "text", text: `Beat ${r.beat}:` }, pngBlock(fs.readFileSync(r.shots[1])));
  content.push({ type: "text", text: 'Fix every issue and reply with the complete corrected file in one ```tsx block.' });
  return { role: "user", content };
}

export async function verifyDemo(env: VerifyEnv, c: Ctx, demo: DemoSpec, rounds: number): Promise<DemoResult> {
  const slug = c.book.slug;
  const unit = c.unit.unit;
  const t = tag(slug, unit);
  const outDir = paths.verifyDir(slug, unit);
  fs.mkdirSync(outDir, { recursive: true });
  const file = paths.component(slug, unit, demo.component);
  let results: BeatResult[] = [];
  let best: { code: string; results: BeatResult[]; passed: number } | null = null;
  let round = 0;
  try {
    for (; ; round++) {
      emit({ type: "demo", unit, id: demo.id, phase: "verifying", round, beats: demo.beats.length });
      const shots = await shootDemo(env, c, demo, outDir);
      results = await review(c, demo, shots);
      const passed = results.filter((r) => r.pass).length;
      log(`verify ${t} ${demo.id}: round ${round}: ${passed}/${results.length} beats pass`);
      // Keep the best version seen, so a bad fix round can't make the demo worse.
      if (fs.existsSync(file) && (!best || passed >= best.passed)) best = { code: fs.readFileSync(file, "utf8"), results, passed };
      if (passed === results.length || round >= rounds) break;
      const convo = loadConvo(slug, unit, demo.id);
      if (!convo) {
        log(`verify ${t} ${demo.id}: no build conversation to continue; skipping fixes`);
        break;
      }
      toFixTurn(convo, feedback(results).content as Anthropic.Beta.BetaContentBlockParam[]);
      await runConvo(convo, 3, "revising", round + 1);
    }
    if (best && best.passed > results.filter((r) => r.pass).length) {
      log(`verify ${t} ${demo.id}: restoring best version (${best.passed}/${results.length})`);
      fs.writeFileSync(file, best.code);
      results = best.results;
    }
  } catch (e) {
    log(`verify ${t} ${demo.id}: error ${(e as Error).message}`);
    if (!results.length) results = demo.beats.map((b, i) => ({ beat: i, anchor: b.anchor, ready: false, errors: [(e as Error).message], readouts: {}, changed: 0, shots: ["", ""] as [string, string], pass: false, issues: [(e as Error).message] }));
  }
  const passed = results.filter((r) => r.pass).length;
  const pass = results.length > 0 && passed === results.length;
  let latest = demo; // fix turns may have saved a corrected spec
  try {
    latest = loadPlan(slug, unit).demos.find((d) => d.id === demo.id) ?? demo;
  } catch {}
  setFlag(slug, unit, latest, pass ? undefined : flagReason(results));
  emit({ type: "demo", unit, id: demo.id, phase: pass ? "pass" : "fail", round, beatsPassed: passed, beats: results.length, detail: pass ? undefined : results.find((r) => !r.pass)?.issues[0] });
  return { id: demo.id, component: demo.component, rounds: round, pass, beats: results };
}

// --- Contact-sheet review + the checked verify loop --------------------------------
//
// The deterministic checks run first; a demo that passes them is shown to the model as a
// single contact sheet of all beats. Every version that passes the checks is reviewed —
// including one produced by a fix round — and a demo still failing after all rounds is
// flagged in its spec (the reader says so) with the best version kept.

/**
 * Each finding carries a severity and its evidence; only evidenced blockers fail a demo.
 * Calibrated on 10 papers against an expert audit (work/qa/e2e/audit3): an unstructured reviewer
 * flagged 65% of demos, but its flags barely tracked the demos that were really wrong. It failed
 * demos for findings it called "acceptable" itself, for things it misread in small frames, for loop
 * restarts and for its own recomputations, and it missed scenarios that weren't the paper's.
 */
const SheetReviewSchema = z.object({
  issues: z.array(
    z.object({
      beat: z.number().nullable(),
      severity: z.enum(["blocker", "minor"]),
      kind: z.enum(["caption-vs-stage", "number", "paper", "other"]),
      /** The claim that is wrong, quoted (caption, readout label, or the paper). */
      claim: z.string(),
      /** What contradicts it, quoted from the readouts, the stage text or the paper. */
      evidence: z.string(),
      text: z.string(),
    }),
  ),
});

type SheetIssue = z.infer<typeof SheetReviewSchema>["issues"][number];

/** Words a reviewer uses when it doesn't really think something is wrong. */
const HEDGE = /\b(this matches|which matches|so the caption is (correct|accurate|fine|right)|acceptable|is consistent|are consistent|not a (real )?(problem|blocker|issue)|no contradiction|please verify|may want to|could be clearer|downgrad\w*|arguabl\w*|minor|nitpick|technically correct|fine as is|seems? (fine|correct|ok))\b/i;

/** Blockers that carry a quoted claim and contradicting evidence and don't hedge (the rest count as minor). */
export function realBlockers(issues: SheetIssue[]): SheetIssue[] {
  return issues.filter((i) => i.severity === "blocker" && i.claim.trim().length >= 6 && i.evidence.trim().length >= 6 && !HEDGE.test(`${i.text} ${i.evidence}`));
}

function sheetSystem(book: BookConfig): string {
  const d = domainOf(book.domain);
  return `You review ${d.demoNoun}s that accompany "${book.title}". For every beat you get: its caption, preset and params; the anchored paragraph (marked ">>>") with its neighbours; the readouts at ~1, ~${LATER_SAMPLES.join(" and ~")} s; the text the stage itself drew, sampled every second (step labels such as "3/5 · …" tell you which state it is in); and one image with the demo at ~1, ~${LATER_SAMPLES.join(" and ~")} s. Referenced tables come as text.

A script already checked layout and numbers: no runtime errors, no blank stage, no clipped or overlapping labels, readouts present and the values the text pins down correct. Do not re-check those. Your job is what needs understanding:
- does each beat show what its caption claims (the right objects, behaviour and outcome)?
- is the scenario the paper's own (its example, its method, numbers from the right table/row), and does it make the paper's point?
${d.reviewChecks}

How to read the evidence:
- The frames are three snapshots of a running, often looping animation. A frame may land mid-step or on a restart. Use the stage-text timeline to see the states in between before saying the stage "never" shows something.
- Read values from the readouts and stage text (exact) rather than from the images (small).
- Do not recompute with parameters you assume. Use only the numbers in the params, readouts, stage text and the paper.

Classify every finding:
- "blocker": the demo would teach the reader something false. Examples: a stated number contradicts the paper or the readouts; the behaviour or outcome contradicts what the paragraph says; the caption's central claim is contradicted by what the stage shows (for example "both signatures valid" while the stage text says "invalid"), or no state in the timeline shows it; the scenario is not the paper's and changes its point (wrong table, wrong method, a different example that proves something else).
- "minor": everything else. That includes a true statement from the paper that the stage doesn't draw, rounding, partial values mid-animation, wording, legibility, style, and anything you consider acceptable.
A blocker must quote the claim ("claim": the caption's or label's words, or the paper's) and the evidence that contradicts it ("evidence": the readout, stage text or paper words, with the time if it matters). If you can't quote both, it is minor. At most 4 blockers. "text" says what is wrong and what it should be. Reply as JSON { "issues": [{ "beat": number | null, "severity": "blocker" | "minor", "kind": "caption-vs-stage" | "number" | "paper" | "other", "claim": string, "evidence": string, "text": string }] }. Use an empty list when the demo is right.`;
}

/** One row per beat, its frames at ~1 s and the later samples, at a scale the reviewer can read. */
async function beatStrip(s: CheckShot, file: string, scale = 0.6): Promise<string | null> {
  const cells = [s.shot, ...(s.later ?? []).map((l) => l.shot)].filter((f) => fs.existsSync(f));
  if (!cells.length) return null;
  const tw = Math.round(VIEWPORT.width * scale);
  const th = Math.round(VIEWPORT.height * scale);
  const gap = 8;
  const tiles = await Promise.all(cells.map(async (f, i) => ({ input: await sharp(f).resize(tw, th, { fit: "contain", background: "#0a0a0a" }).png().toBuffer(), left: i * (tw + gap), top: 0 })));
  await sharp({ create: { width: cells.length * tw + (cells.length - 1) * gap, height: th, channels: 3, background: "#000000" } })
    .composite(tiles)
    .png()
    .toFile(file);
  return file;
}

/** One model review of a demo that passed the deterministic checks. */
export async function reviewSheet(c: Ctx, demo: DemoSpec, check: CheckResult): Promise<{ pass: boolean; issues: string[] }> {
  const regions = demoRegions(c, [demo.brief, ...demo.beats.map((b) => b.caption)], demo.beats.map((b) => b.anchor));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `Demo "${demo.title}" (${demo.id}).\n\nBrief:\n${demo.brief}\n\nControls: ${JSON.stringify(demo.controls)}\nReadouts: ${JSON.stringify(demo.readouts)}${regionsBlock(regions)}` },
  ];
  const times = ["~1 s", ...LATER_SAMPLES.map((t) => `~${t} s`)];
  for (const s of check.shots) {
    const b = demo.beats[s.beat];
    const timeline = (s.timeline ?? []).map((x) => `  ${x.t} s: ${x.text}`).join("\n");
    content.push({
      type: "text",
      text: `\n## Beat ${s.beat}\nPreset: ${b.preset}${b.params ? `, params ${JSON.stringify(b.params)}` : ""}\nCaption: ${b.caption}\nParagraph (${textSourceNote(c.book).name}):\n${anchorContext(c, b.anchor, 1, 1)}\nReadouts at ~1 s: ${JSON.stringify(s.readouts)}${(s.later ?? []).map((l) => `\nReadouts at ~${l.t} s: ${JSON.stringify(l.readouts)}`).join("")}\nStage text over time (only changes):\n${timeline || "  (the stage draws no text)"}`,
    });
    const strip = await beatStrip(s, path.join(path.dirname(s.shot), `${demo.id}-${s.beat}-strip.png`));
    if (strip) content.push({ type: "text", text: `Beat ${s.beat} at ${times.slice(0, 1 + (s.later?.length ?? 0)).join(", ")} (left to right):` }, pngBlock(fs.readFileSync(strip)));
  }
  content.push({ type: "text", text: "Review the demo. Reply as JSON." });
  const { data } = await callJson(SheetReviewSchema, {
    ...roleModel("review"),
    label: `verify:${tag(c.book.slug, c.unit.unit)}:${demo.id}`,
    system: sheetSystem(c.book),
    messages: [{ role: "user", content }],
    maxTokens: 8000,
    cache: false,
  });
  const blockers = realBlockers(data.issues).map((i) => {
    const text = `${i.text} (caption/paper: "${i.claim.trim()}"; shown: "${i.evidence.trim()}")`;
    return i.beat === null || /\bbeats?\s+\d/i.test(i.text) ? text : `Beat ${i.beat}: ${text}`;
  });
  return { pass: blockers.length === 0, issues: blockers };
}

/** Feedback for the builder from deterministic notes (and, after a review, its issues). */
function checkFeedback(notes: string[], check: CheckResult, from: "checks" | "review"): Anthropic.Beta.BetaMessageParam {
  const lead =
    from === "checks"
      ? "The demo was rendered in a headless browser (560×760 viewport) and checked automatically. These problems were found:"
      : "The demo was rendered in a headless browser and reviewed. The reviewer found:";
  const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: `${lead}\n\n${notes.map((n) => `- ${n}`).join("\n")}` }];
  if (notes.some(isExpectNote))
    content.push({
      type: "text",
      text: 'An expected value comes from your spec, not from the checker. Re-check it against the text: if the readout is right and the expectation is wrong, correct the expectation instead of the code — add a ```json block {"expect": [{ "beat": <index>, "readout": "<id>", "value": <number>, "tol"?: <relative> }, …]} with the full corrected list (and no code if nothing else needs fixing).',
    });
  if (notes.some((n) => /\) changes nothing: /.test(n)))
    content.push({ type: "text", text: 'A control that changes nothing: wire it into the code, or — if the demo doesn\'t need it — remove it from the spec with a ```json block {"drop": ["<control id>"]} (its preset and beat values go with it).' });
  if (from === "review")
    content.push({
      type: "text",
      text: 'Decide per problem what is wrong. If the stage is right and a caption claims more than it shows, correct the caption — add a ```json block {"beats": [{ "caption"?, "preset"?, "params"? }, …]} with one entry per beat in order (an empty {} keeps a beat as it is); captions say what this beat\'s stage actually shows. If a beat should start from another preset or params, change them there too. Change the code only when the behaviour or the numbers are wrong.',
    });
  if (check.sheet && fs.existsSync(check.sheet)) content.push({ type: "text", text: "All beats as rendered:" }, pngBlock(fs.readFileSync(check.sheet)));
  content.push({ type: "text", text: `Fix every problem (keep everything else as it is). Reply with the code changes${from === "review" ? " and/or the spec block; no code if only the spec changes" : ""}.` });
  return { role: "user", content };
}

export function toResults(check: CheckResult, pass: boolean, issues: string[]): BeatResult[] {
  return check.shots.map((s) => {
    const mine = issues.filter((i) => new RegExp(`\\bbeats? [\\d,]*\\b${s.beat}\\b`).test(i));
    return { beat: s.beat, anchor: s.anchor, ready: s.ready, errors: s.errors, readouts: s.readouts, changed: s.changed, shots: [s.shot, s.shot] as [string, string], pass: pass && s.ready && !s.errors.length, issues: pass ? [] : mine.length ? mine : issues };
  });
}

/**
 * Checked verify loop: deterministic checks (free) until they pass or `rounds` fix rounds are spent;
 * every version that passes them gets one contact-sheet model review (`review: false` skips it), and a
 * failed review spends a fix round too. A demo still failing at the end keeps its best version and is
 * flagged (`spec.flagged`). Same result shape as verifyDemo.
 */
/** A deterministic note about an expected readout value (grouped form: "beat(s) …: readout … shows …, the text gives …"). */
function isExpectNote(n: string): boolean {
  return /readout .* shows .*, the text gives /.test(n);
}

/** Expectations named by expect-mismatch notes (beats + readout id), to drop on the last round. */
function mismatchedExpectations(demo: DemoSpec, notes: string[]): Expectation[] {
  const out: Expectation[] = [];
  for (const n of notes) {
    const m = /^beats? ([\d,]+): readout .*\((\w+)\) shows /.exec(n);
    if (!m) continue;
    const beats = new Set(m[1].split(",").map(Number));
    for (const e of demo.expect ?? []) if (e.readout === m[2] && beats.has(e.beat)) out.push(e);
  }
  return out;
}

export interface CheckedOpts {
  rounds?: number;
  /**
   * Results already in hand for the demo as it stands (a race candidate that was installed after
   * both candidates failed): round 0 uses them instead of checking and reviewing again.
   */
  initial?: { check: CheckResult; review?: { pass: boolean; issues: string[] } };
  /** false: skip the model review (deterministic checks only). */
  review?: boolean;
  /**
   * Custom fix step instead of the code conversation (template demos edit their config):
   * returns the updated spec, or null when nothing usable came back.
   */
  fix?: (notes: string[], check: CheckResult, from: "checks" | "review", round: number) => Promise<DemoSpec | null>;
}

/**
 * Set or clear a demo's `flagged` note in its plan (one line). Returns the spec as saved; no write when
 * nothing changes.
 */
export function setFlag(slug: string, unit: string, demo: DemoSpec, reason: string | undefined): DemoSpec {
  const line = reason?.replace(/\s+/g, " ").trim();
  const flagged = line ? (line.length > 200 ? line.slice(0, 199) + "…" : line) : undefined;
  if (demo.flagged === flagged) return demo;
  const next: DemoSpec = { ...demo };
  if (flagged) next.flagged = flagged;
  else delete next.flagged;
  saveSpec(slug, unit, next);
  return next;
}

/** The first failing issue of a result, for `flagged`. */
function flagReason(results: BeatResult[]): string {
  return results.find((r) => !r.pass)?.issues[0] ?? "did not pass verification";
}

export async function verifyDemoChecked(env: VerifyEnv, c: Ctx, demo: DemoSpec, opts: CheckedOpts = {}): Promise<DemoResult> {
  const rounds = opts.rounds ?? 2;
  const slug = c.book.slug;
  const unit = c.unit.unit;
  const t = tag(slug, unit);
  const outDir = paths.verifyDir(slug, unit);
  const file = paths.component(slug, unit, demo.component);
  const codeNow = () => (opts.fix ? null : fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  /** What a review judged: the spec (a template's config lives there) and the component code. */
  const versionKey = (d: DemoSpec) => {
    const { flagged: _f, ...rest } = d;
    return JSON.stringify(rest) + "\n" + (codeNow() ?? "");
  };
  let reviewFixes = 0;
  const reviews = new Map<string, { pass: boolean; issues: string[] }>();
  let round = 0;
  let results: BeatResult[] = [];
  let lastScore = -1;
  /** Best version seen (review pass > checks pass > fewer check notes), restored if the demo ends failing. */
  let best: { demo: DemoSpec; code: string | null; results: BeatResult[]; score: number } | null = null;
  const consider = (score: number) => {
    lastScore = score;
    if (!best || score > best.score) best = { demo, code: codeNow(), results, score };
  };
  const warnings: string[] = [];
  /** Expectations were dropped on the last round: the model review decides instead. */
  let dropped = false;
  let pass = false;
  try {
    for (; ; round++) {
      emit({ type: "demo", unit, id: demo.id, phase: "verifying", round, beats: demo.beats.length });
      const given = round === 0 ? opts.initial : undefined;
      const check = given ? given.check : await checkDemo(env, c, demo, outDir);
      // Last round, and the only problems left are expected values: a wrong expectation must not
      // sink a demo that is otherwise fine. Drop those expectations and let the review decide.
      if (!check.ok && round >= rounds && check.notes.length && check.notes.every(isExpectNote)) {
        const bad = new Set(mismatchedExpectations(demo, check.notes));
        if (bad.size) {
          demo = { ...demo, expect: (demo.expect ?? []).filter((e) => !bad.has(e)) };
          if (!demo.expect?.length) delete demo.expect;
          saveSpec(slug, unit, demo);
          for (const n of check.notes) warnings.push(`expectation dropped: ${n}`);
          log(`verify ${t} ${demo.id}: dropped ${bad.size} expectation(s) that disagree with the demo; reviewing instead`);
          dropped = true;
          check.ok = true;
          check.notes = [];
        }
      }
      if (!check.ok) {
        log(`verify ${t} ${demo.id}: round ${round}: ${check.notes.length} check notes`);
        results = toResults(check, false, check.notes);
        consider(1 - Math.min(check.notes.length, 999) / 1000);
        if (opts.fix) {
          const next = round < rounds ? await opts.fix(check.notes, check, "checks", round + 1) : null;
          if (!next) break;
          demo = next;
          continue;
        }
        const convo = round < rounds ? loadConvo(slug, unit, demo.id) : null;
        if (!convo) break;
        toFixTurn(convo, checkFeedback(check.notes, check, "checks").content as Anthropic.Beta.BetaContentBlockParam[]);
        await runConvo(convo, 3, "revising", round + 1);
        demo = convo.spec; // a fix turn may have corrected the spec's expectations
        continue;
      }
      if (opts.review === false && !dropped) {
        results = toResults(check, true, []);
        pass = true;
        break;
      }
      // Every version that passes the checks is reviewed — a fix that only satisfies the checker
      // must not ship unreviewed. The same version is never reviewed twice.
      const key = versionKey(demo);
      const r = reviews.get(key) ?? given?.review ?? (await reviewSheet(c, demo, check));
      reviews.set(key, r);
      log(`verify ${t} ${demo.id}: round ${round}: checks pass, review ${r.pass ? "pass" : `fail (${r.issues.length})`}`);
      results = toResults(check, r.pass, r.issues);
      consider(r.pass ? 3 : 2);
      if (r.pass) {
        pass = true;
        break;
      }
      // At most one revision on review findings: a second failing review flags the demo instead of
      // spending more rounds (the checks' own fix rounds are separate).
      if (reviewFixes >= 1) break;
      reviewFixes++;
      if (opts.fix) {
        const next = round < rounds ? await opts.fix(r.issues, check, "review", round + 1) : null;
        if (!next || versionKey(next) === key) break;
        demo = next;
        continue;
      }
      const convo = round < rounds ? loadConvo(slug, unit, demo.id) : null;
      if (!convo) break;
      // A revision on the review's findings; the next round re-checks it and, if it passes, reviews it again.
      toFixTurn(convo, checkFeedback(r.issues, check, "review").content as Anthropic.Beta.BetaContentBlockParam[]);
      await runConvo(convo, 3, "revising", round + 1);
      demo = convo.spec;
      if (versionKey(demo) === key) break;
    }
  } catch (e) {
    log(`verify ${t} ${demo.id}: error ${(e as Error).message}`);
    if (!results.length) results = demo.beats.map((b, i) => ({ beat: i, anchor: b.anchor, ready: false, errors: [(e as Error).message], readouts: {}, changed: 0, shots: ["", ""] as [string, string], pass: false, issues: [(e as Error).message] }));
  }
  pass = pass && results.length > 0 && results.every((r) => r.pass);
  const kept = best as { demo: DemoSpec; code: string | null; results: BeatResult[]; score: number } | null;
  if (!pass && kept && kept.score > lastScore) {
    // A fix round made it worse: keep the best version seen.
    log(`verify ${t} ${demo.id}: restoring the best version seen`);
    if (kept.code !== null) fs.writeFileSync(file, kept.code);
    demo = kept.demo;
    saveSpec(slug, unit, demo);
    results = kept.results;
  }
  // Never ship a failing demo silently: the reader shows the flag; a passing demo clears it.
  demo = setFlag(slug, unit, demo, pass ? undefined : flagReason(results));
  if (!pass) log(`verify ${t} ${demo.id}: flagged: ${demo.flagged}`);
  const passed = results.filter((r) => r.pass).length;
  emit({ type: "demo", unit, id: demo.id, phase: pass ? "pass" : "fail", round, beatsPassed: passed, beats: results.length, detail: pass ? undefined : results.find((r) => !r.pass)?.issues[0] });
  return { id: demo.id, component: demo.component, rounds: round, pass, beats: results, ...(warnings.length ? { warnings } : {}) };
}

/** Merge results into work/<slug>/verify/<unit>/report.json (keeps other demos of the current plan). */
export function writeReport(book: BookConfig, unitId: string, results: DemoResult[]): string {
  const plan = loadPlan(book.slug, unitId);
  const reportFile = path.join(paths.verifyDir(book.slug, unitId), "report.json");
  const prev = fs.existsSync(reportFile) ? (JSON.parse(fs.readFileSync(reportFile, "utf8")) as { demos: DemoResult[] }).demos : [];
  const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id) && plan.demos.some((d) => d.id === p.id)), ...results];
  writeJson(reportFile, { book: book.slug, unit: unitId, at: new Date().toISOString(), demos: merged });
  return reportFile;
}

/** Previous verdict for a demo from report.json (for adopting legacy results into the cache). */
export function previousVerdict(book: BookConfig, unitId: string, id: string): boolean | undefined {
  const reportFile = path.join(paths.verifyDir(book.slug, unitId), "report.json");
  if (!fs.existsSync(reportFile)) return undefined;
  const r = (JSON.parse(fs.readFileSync(reportFile, "utf8")) as { demos: DemoResult[] }).demos.find((d) => d.id === id);
  return r?.pass;
}

/** Verify a unit's demos with a private environment (standalone use; scripts/run.ts shares one env). */
export async function verifyUnit(book: BookConfig, unitId: string, opts: { only?: string[]; rounds?: number; concurrency?: number } = {}): Promise<DemoResult[]> {
  const c = loadCtx(book, unitId);
  const plan = loadPlan(book.slug, unitId);
  const demos = plan.demos.filter((d) => !opts.only?.length || opts.only.includes(d.id));
  const env = await startEnv();
  try {
    const results = await pool(demos, opts.concurrency ?? 8, (d) => verifyDemo(env, c, d, opts.rounds ?? 2));
    writeReport(book, unitId, results);
    return results;
  } finally {
    await closeEnv(env);
  }
}
