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
import { callJson, MODELS, pool } from "../lib/claude";
import { Limit } from "../lib/limit";
import { emit } from "../lib/report";
import type { BookConfig, DemoSpec } from "../../src/types";
import { loadConvo, runConvo } from "./build";
import { anchorContext, anchorCrop, type Ctx, loadCtx, loadPlan, log, paths, pngBlock, tag, textSourceNote, writeJson } from "./common";
import { domainOf } from "./domains";

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
    model: MODELS.sonnet,
    effort: "medium",
    label: `verify:${tag(c.book.slug, c.unit.unit)}:${demo.id}`,
    system: reviewSystem(c.book),
    messages: [{ role: "user", content }],
    maxTokens: 16000,
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
  content.push({ type: "text", text: 'Fix every issue and reply with the complete corrected file as JSON { "code": ... }.' });
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
      convo.messages.push(feedback(results));
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
  emit({ type: "demo", unit, id: demo.id, phase: pass ? "pass" : "fail", round, beatsPassed: passed, beats: results.length, detail: pass ? undefined : results.find((r) => !r.pass)?.issues[0] });
  return { id: demo.id, component: demo.component, rounds: round, pass, beats: results };
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
