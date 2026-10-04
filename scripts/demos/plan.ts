// Plan step: read a unit (a chapter, or a whole paper) and ask Opus for a demo
// plan (demos, presets, controls, readouts, beats anchored to anchor ids).
// Output: src/demos/<slug>/<unit>/plan.json
//
// Fast path: the reply is streamed and every demo object is validated the
// moment it is complete. Trivial problems are fixed locally (beat order,
// heading anchors, missing preset values, out-of-range params); a demo that
// still has problems is repaired with a short follow-up that asks for that
// demo only. Accepted demos are handed to `onDemo` immediately, so building
// can start long before the plan is finished.

import fs from "node:fs";
import sharp from "sharp";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { call, roleModel, textOf, type Effort } from "../lib/claude";
import type { Anchor, BookConfig, ControlSpec, DemoPlan, DemoSpec, Expectation, Params, ParamValue, Unit, UnitText } from "../../src/types";
import { pagePng, rawUnitPath, unitTextPath } from "../books";
import type { RawUnit } from "../content/raw";
import { anchorLine, type Ctx, extractJson, loadCtx, log, pageImage, paths, pngBlock, setSpecSink, tag, writeJson } from "./common";
import { outlineCatalog as catalogText, templates as loadTemplates } from "./template";
import { domainOf } from "./domains";
import { emit } from "../lib/report";
import { anchorFigureBeats, configNumbers, demoCap, groundingProblems, groundingSource, isOcr, plannableAnchors, sanityGate, skipSectionReason, sourceNote, specNumbers, standInPhrase } from "./quality";

// --- Schema (mirrors DemoPlan in src/types.ts) ------------------------------

const ParamValueZ = z.union([z.number(), z.boolean(), z.string()]);
const ParamsZ = z.record(z.string(), ParamValueZ);

const ControlSpecZ = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("slider"),
    id: z.string(),
    label: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    unit: z.string().optional(),
  }),
  z.object({ type: z.literal("toggle"), id: z.string(), label: z.string() }),
  z.object({
    type: z.literal("select"),
    id: z.string(),
    label: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
  }),
]);

/** Lenient shape: structure only. Limits are checked after local fixes. */
const DemoSpecLoose = z.object({
  id: z.string(),
  title: z.string(),
  component: z.string(),
  brief: z.string(),
  presets: z.array(z.object({ id: z.string(), label: z.string(), params: ParamsZ })).min(1),
  controls: z.array(ControlSpecZ),
  readouts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      // [min, max]; null = open side. A malformed range is dropped, never a reason to reject.
      range: z
        .tuple([z.number().nullable(), z.number().nullable()])
        .transform(([lo, hi]): [number, number] => [lo ?? -OPEN_RANGE, hi ?? OPEN_RANGE])
        .optional()
        .catch(undefined),
    }),
  ),
  beats: z.array(z.object({ anchor: z.string(), preset: z.string(), caption: z.string(), params: ParamsZ.optional() })),
});

/** Stand-in for an open side of a readout range (JSON has no Infinity). */
const OPEN_RANGE = 1e15;

/** Bump to deliberately invalidate every cached plan (prompt wording changes alone must not). */
const PLAN_VERSION = "2";

/**
 * Prefix of plan-cache keys made by the current scheme. Keys without it come from older
 * schemes (which also hashed the prompt text, so any prompt edit re-planned every book);
 * run.ts adopts those instead of re-planning.
 */
export const PLAN_KEY_PREFIX = "p3:";

// --- Verbatim-copy detection -----------------------------------------------------

export function shingles(text: string, n: number): Set<string> {
  const w = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

// --- Local fixes + checks (one demo at a time) ---------------------------------

/** State shared across the demos of one plan (uniqueness constraints). */
export interface PlanState {
  ids: Set<string>;
  components: Set<string>;
  anchors: Set<string>;
}

function defaultValue(c: ControlSpec): ParamValue {
  if (c.type === "toggle") return false;
  if (c.type === "select") return c.options[0].value;
  const mid = (c.min + c.max) / 2;
  return Math.min(c.max, Math.max(c.min, Math.round((mid - c.min) / c.step) * c.step + c.min));
}

/** Coerce a value to what the control accepts; undefined if hopeless. */
function coerce(c: ControlSpec, v: ParamValue): ParamValue | undefined {
  if (c.type === "slider") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.min(c.max, Math.max(c.min, n)) : undefined;
  }
  if (c.type === "toggle") return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
  return c.options.some((o) => o.value === v) ? v : undefined;
}

/**
 * Fix what can be fixed without the model, in place. Returns the remaining
 * problems (empty = accept). Does not reserve ids/anchors in `state`.
 */
export interface CopyCheck {
  /** Displayed text (captions): any 9-word run shared with the book. */
  caption: (s: string) => boolean;
  /** The brief is an internal spec for the builder, never shown: only long runs (25 words) count as copying. */
  brief: (s: string) => boolean;
}

/** Cut text at a word boundary to at most `max` chars (no ellipsis: titles and captions read as written). */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

/** A long caption keeps its leading whole sentences that fit; else it is clipped at a word. */
function trimCaption(s: string, max: number): string {
  if (s.length <= max) return s;
  const sentences = s.match(/[^.?]+[.?]+(\s+|$)/g) ?? [];
  let out = "";
  for (const x of sentences) {
    if ((out + x).trim().length > max) break;
    out += x;
  }
  return out.trim() || clip(s, max);
}

/** Exported for tests. */
export function fixDemo(d: DemoSpec, c: Ctx, state: PlanState, copied: CopyCheck, opts: { briefMin?: number } = {}): string[] {
  const errs: string[] = [];
  const anchors = c.unit.anchors;
  const order = new Map(anchors.map((a, i) => [a.id, i]));

  // Identity.
  d.id = d.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo";
  while (state.ids.has(d.id)) d.id = `${d.id}-2`;
  d.component = d.component.replace(/[^A-Za-z0-9]/g, "");
  if (!/^[A-Z]/.test(d.component)) d.component = d.component.charAt(0).toUpperCase() + d.component.slice(1);
  if (!/^[A-Z][A-Za-z0-9]+$/.test(d.component)) d.component = d.id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
  while (state.components.has(d.component)) d.component = `${d.component}2`;
  d.title = clip(d.title.trim(), 48);
  if (d.brief.length < (opts.briefMin ?? 200)) errs.push("brief is too short (at least 150 words of implementable spec)");
  if (copied.brief(d.brief)) errs.push("brief copies long passages from the text; write it in your own words");

  // Controls, readouts, presets.
  const seenControl = new Set<string>();
  d.controls = d.controls.filter((x) => (seenControl.has(x.id) ? false : (seenControl.add(x.id), true)));
  // More than 6 controls: keep the first 6 (preset values for the rest stay as fixed params).
  d.controls = d.controls.slice(0, 6);
  for (const x of d.controls) if (x.type === "slider" && x.min > x.max) [x.min, x.max] = [x.max, x.min];
  const seenReadout = new Set<string>();
  d.readouts = d.readouts.filter((r) => (seenReadout.has(r.id) ? false : (seenReadout.add(r.id), true))).slice(0, 5);
  for (const r of d.readouts) {
    const [lo, hi] = r.range ?? [];
    if (!(typeof lo === "number" && typeof hi === "number" && lo < hi && (lo > -OPEN_RANGE || hi < OPEN_RANGE))) delete r.range;
  }
  if (!d.readouts.length) errs.push("needs at least one readout");
  const seenPreset = new Set<string>();
  d.presets = d.presets.filter((p) => (seenPreset.has(p.id) ? false : (seenPreset.add(p.id), true)));
  for (const p of d.presets) {
    for (const x of d.controls) {
      const v = x.id in p.params ? p.params[x.id] : undefined;
      const fixed = v === undefined ? undefined : coerce(x, v);
      p.params[x.id] = fixed ?? d.presets.find((q) => q !== p && q.params[x.id] !== undefined && coerce(x, q.params[x.id]) !== undefined)?.params[x.id] ?? defaultValue(x);
    }
  }

  // Beats: valid anchors (headings move to the next paragraph), reading order,
  // one beat per anchor across the plan, existing preset, coercible params.
  const used = new Set(state.anchors);
  const beats: DemoSpec["beats"] = [];
  for (const b of d.beats) {
    let idx = order.get(b.anchor);
    if (idx === undefined) continue; // unknown anchor: drop the beat
    while (idx < anchors.length && (anchors[idx].kind === "heading" || used.has(anchors[idx].id))) idx++;
    if (idx >= anchors.length || anchors[idx].section !== anchors[order.get(b.anchor)!].section) continue;
    b.anchor = anchors[idx].id;
    used.add(b.anchor);
    if (!seenPreset.has(b.preset)) b.preset = d.presets[0].id;
    if (b.params) {
      const preset = d.presets.find((p) => p.id === b.preset)!;
      const out: Params = {};
      for (const [k, v] of Object.entries(b.params)) {
        if (!(k in preset.params)) continue;
        const x = d.controls.find((cc) => cc.id === k);
        const fixed = x ? coerce(x, v) : v;
        if (fixed !== undefined) out[k] = fixed;
      }
      b.params = Object.keys(out).length ? out : undefined;
      if (!b.params) delete b.params;
    }
    b.caption = trimCaption(b.caption.replace(/!/g, ".").trim(), 260);
    if (/\bAI\b/.test(b.caption)) errs.push(`beat at ${b.anchor}: caption must not mention AI`);
    if (b.caption.length < 10) errs.push(`beat at ${b.anchor}: caption too short`);
    if (copied.caption(b.caption)) errs.push(`beat at ${b.anchor}: caption copies a sentence from the text; write it in your own words`);
    beats.push(b);
  }
  beats.sort((a, b) => order.get(a.anchor)! - order.get(b.anchor)!);
  d.beats = beats.slice(0, 6);
  if (d.beats.length < 2) errs.push(`only ${d.beats.length} usable beat(s) after dropping unknown/duplicate anchors; give 2–6 beats on valid, unused paragraph anchors`);
  return errs;
}

function reserve(d: DemoSpec, state: PlanState) {
  state.ids.add(d.id);
  state.components.add(d.component);
  for (const b of d.beats) state.anchors.add(b.anchor);
}

// --- Incremental parsing of the streamed reply -------------------------------------

/** Pulls complete objects out of the `"demos": [ … ]` array as text streams in. */
class DemoScanner {
  private buf = "";
  private i = 0;
  private inArray = false;
  private done = false;
  private depth = 0;
  private inStr = false;
  private esc = false;
  private start = -1;
  constructor(private onObject: (json: string) => void) {}

  push(delta: string) {
    this.buf += delta;
    if (this.done) return;
    if (!this.inArray) {
      const m = /"demos"\s*:\s*\[/.exec(this.buf);
      if (!m) return;
      this.inArray = true;
      this.i = m.index + m[0].length;
    }
    for (; this.i < this.buf.length; this.i++) {
      const ch = this.buf[this.i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === "\\") this.esc = true;
        else if (ch === '"') this.inStr = false;
        continue;
      }
      if (ch === '"') this.inStr = true;
      else if (ch === "{" || ch === "[") {
        if (this.depth === 0 && ch === "{") this.start = this.i;
        this.depth++;
      } else if (ch === "}" || ch === "]") {
        if (this.depth === 0 && ch === "]") {
          this.done = true;
          return;
        }
        this.depth--;
        if (this.depth === 0 && ch === "}" && this.start >= 0) {
          this.onObject(this.buf.slice(this.start, this.i + 1));
          this.start = -1;
        }
      }
    }
  }
}

// --- Prompt ------------------------------------------------------------------

/** "paper" for a single-unit born-digital book, else "chapter". */
export function unitNoun(book: BookConfig): string {
  return book.source.kind === "text" && book.units.length === 1 ? "paper" : "chapter";
}

function systemFor(book: BookConfig): string {
  const d = domainOf(book.domain);
  const noun = unitNoun(book);
  const src = sourceNote(book);
  return `You design interactive demos that accompany a ${noun} of "${book.title}" (${d.subject}).

The reader sees the original pages on the right and one demo on the left. As they scroll, the demo whose beat is anchored to the paragraph under their reading line becomes active, switches to that beat's preset/params and shows the beat's caption. Demos are drawn on a dark canvas in a minimal style (thin monochrome lines, one blue accent, small labels), with live numerical readouts below.

You get the ${noun} as (1) the page images — authoritative for equations, figures and wording — and (2) a list of paragraph anchors, each with its id, page, kind and ${src.name}. ${src.caveat} Anchor ids are the only valid beat anchors.

Write every caption and brief in your own words. Never copy sentences from the text; short phrases, symbols and equations are fine.

Your job: propose 3–7 demos for the ${noun} that genuinely aid understanding — about one per distinct idea worth seeing; a unit of 5+ pages usually has 5–6. Across all fields, good demos:
- let the reader see and manipulate exactly what the text describes, with readouts that check an equation or a quoted number;
- cover the ${noun} from start to end where it has substance, so the reader has a demo for most of the reading;
- are simple enough to implement well in a single React canvas component (~200–400 lines). Prefer one demo with several presets over several thin demos.

${d.planner}

Each demo has 2–6 beats. A beat anchors to one anchor id (a paragraph, equation, figure or table — not a heading) and sets the preset plus optional param overrides that match the numbers used in that paragraph ("text values"). Beats within a demo are in reading order. An anchor may hold at most one beat across the whole ${noun}. Spread beats so they sit where the reader would want to see that demo.

Field rules:
- id: kebab-case. component: PascalCase, unique. title: short (≤ 48 chars), sentence case (shown in small caps).
- brief: a precise, implementable spec for the engineer who will write the component without seeing the text: what is drawn (layout, labels using the text's symbols), the maths with equations and units, the simulation or computation method (seeds, sizes), what every control does, what each preset shows, how each readout is computed, and which figure it re-draws, if any (name it as the text does, e.g. "Fig. 13-3" or "Figure 2"). 150–400 words.
- controls: at most 6; sliders (with sensible min/max/step/unit), toggles, selects. Do NOT include play/pause/restart or a preset picker — the shell provides those.
- presets: every preset gives a value for every control id (it may also include extra fixed params not bound to a control).
- readouts: 1–5 short live values; labels may use $LaTeX$, e.g. "$T + U$". The component formats the values.
- captions: one or two plain sentences (≤ 260 chars) specific to the anchored paragraph that tell the reader what to look at. Use $LaTeX$ for symbols with sub/superscripts. No hype, no exclamation marks, no mention of AI. Example: "${d.captionExample}"

Write the demos in reading order (the demo whose first beat comes earliest first). Reply with only the JSON object, matching this TypeScript type:

interface DemoPlan {
  book: string;   // "${book.slug}"
  unit: string;   // the unit id given below
  demos: {
    id: string; title: string; component: string; brief: string;
    presets: { id: string; label: string; params: Record<string, number | boolean | string> }[];
    controls: (
      | { type: "slider"; id: string; label: string; min: number; max: number; step: number; unit?: string }
      | { type: "toggle"; id: string; label: string }
      | { type: "select"; id: string; label: string; options: { value: string; label: string }[] }
    )[];
    readouts: { id: string; label: string }[];
    beats: { anchor: string; preset: string; caption: string; params?: Record<string, number | boolean | string> }[];
  }[];
}`;
}

/** Sections that never get demos (and whose pages aren't worth sending). */
/** Section ids that never carry demos (the full rules, titles and kinds included: quality.ts skipSectionReason). */
export const SKIP_SECTION = /^(references|bibliography|acknowledg(e)?ments?|keywords|ccs-concepts|acm-reference-format|contents$|exercises-)/;

export interface PlanOpts {
  /** Planner effort (Opus 5.5). */
  effort?: Effort;
  /** Called for each demo as soon as it is accepted (before the plan is complete). */
  onDemo?: (spec: DemoSpec) => void;
  /** Write somewhere other than src/demos/<slug>/<unit>/plan.json (experiments). */
  out?: string;
}

/** Hash of everything the planner sees (for incremental runs). */
export function planInputHash(book: BookConfig, unitId: string, h: (...p: string[]) => string): string {
  // Same values whether built from the anchors step's raw file or the assembled unit
  // (outlineCtx rounds exactly like assemble), so the key doesn't change with the source.
  const c = outlineCtx(book, unitId);
  // Only what the planner reads: structure and text. Page-image details (sizes,
  // srcset variants) change when images are re-rendered and must not trigger a re-plan.
  const { title, sections, anchors } = c.unit;
  const pages = c.unit.pages.map((p) => p.label);
  // Not the prompt text: editing the prompt must not re-plan (and re-pay for) every existing book.
  return PLAN_KEY_PREFIX + h(PLAN_VERSION, JSON.stringify({ title, sections, anchors, pages }), JSON.stringify(c.text));
}

export async function planUnit(book: BookConfig, unitId: string, opts: PlanOpts = {}): Promise<DemoPlan> {
  const c = loadCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const noun = unitNoun(book);
  const out = opts.out ?? paths.plan(book.slug, unitId);

  // Inputs: pages that carry substance, downscaled; anchors outside skipped sections.
  const keep = plannableAnchors(c);
  sanityGate(c, keep);
  const pagesWithContent = new Set(keep.map((a) => a.page));
  const maxPx = book.source.kind === "text" ? 1100 : 1400;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `${book.title} — unit "${unitId}": ${c.unit.title}. The pages follow, in order.` },
  ];
  const images = await Promise.all(c.unit.pages.filter((p) => pagesWithContent.has(p.label)).map(async (p) => ({ p, img: await pageImage(c, p.label, maxPx) })));
  for (const { p, img } of images) if (img) content.push({ type: "text", text: `Page ${p.label}:` }, pngBlock(img));
  const sections = c.unit.sections.filter((s) => !skipSectionReason(s)).map((s) => `${s.id} ${s.title} (p.${s.page})`).join("\n");
  content.push({
    type: "text",
    text: `Sections:\n${sections}\n\nParagraph anchors in reading order (${sourceNote(book).name}; the page images are authoritative):\n\n${keep.map((a) => anchorLine(a, c.text, 600)).join("\n")}\n\nPropose the demo plan for this ${noun} (book "${book.slug}", unit "${unitId}").`,
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];

  const bookText = Object.values(c.text.text).join(" \n ");
  const captionRuns = shingles(bookText, 9);
  const briefRuns = shingles(bookText, 25);
  const copied: CopyCheck = {
    caption: (x) => [...shingles(x, 9)].some((r) => captionRuns.has(r)),
    brief: (x) => [...shingles(x, 25)].some((r) => briefRuns.has(r)),
  };
  const state: PlanState = { ids: new Set(), components: new Set(), anchors: new Set() };
  const accepted: DemoSpec[] = [];
  const dropped: { spec: DemoSpec; errors: string[] }[] = [];
  const repairs: Promise<void>[] = [];
  const order = new Map(c.unit.anchors.map((a, i) => [a.id, i]));

  const write = () => {
    const demos = [...accepted].sort((a, b) => order.get(a.beats[0].anchor)! - order.get(b.beats[0].anchor)!);
    writeJson(out, { book: book.slug, unit: unitId, demos });
  };

  // A demo that still has problems after the local fixes is repaired on its own, right away
  // (in parallel with the rest of the plan streaming in), so it never holds up other demos
  // and the plan doesn't wait for its end to start repairs. Same cached prefix as the plan.
  const repair = (spec: DemoSpec, errors: string[], round: number) => {
    if (round > 2) {
      dropped.push({ spec, errors });
      return;
    }
    log(`plan ${t}: repairing ${spec.id} (round ${round})`);
    const ask: Anthropic.Beta.BetaMessageParam = {
      role: "user",
      content: [
        ...(messages[0].content as Anthropic.Beta.BetaContentBlockParam[]),
        {
          type: "text",
          text: `You proposed this demo for the plan:\n${JSON.stringify(spec)}\n\nIt needs corrections before it can be used:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nAnchors already used by other demos (do not reuse): ${[...state.anchors].join(", ") || "none"}.\nReply with JSON {"demos": [ ... ]} containing only the corrected version of this demo.`,
        },
      ],
    };
    let got = false;
    const scan = new DemoScanner((json) => {
      try {
        got = true;
        consider(JSON.parse(json), round + 1);
      } catch {
        /* handled below */
      }
    });
    repairs.push(
      call({ ...roleModel("repair"), label: `plan-repair:${t}`, system: systemFor(book), messages: [ask], onText: (d) => scan.push(d) })
        .then(() => {
          if (!got) dropped.push({ spec, errors: [...errors, "the repair returned no demo"] });
        })
        .catch((e: Error) => {
          dropped.push({ spec, errors: [...errors, `repair failed: ${e.message}`] });
        }),
    );
  };

  const consider = (raw: unknown, round = 1) => {
    const parsed = DemoSpecLoose.safeParse(raw);
    if (!parsed.success) {
      log(`plan ${t}: unparseable demo (${parsed.error.issues[0]?.message ?? "?"})`);
      return;
    }
    const spec = parsed.data as DemoSpec;
    if (accepted.length >= 7) return;
    const errors = fixDemo(spec, c, state, copied);
    if (errors.length) return repair(spec, errors, round);
    reserve(spec, state);
    accepted.push(spec);
    write();
    log(`plan ${t}: + ${spec.id} (${spec.beats.length} beats)`);
    opts.onDemo?.(spec);
  };

  const scanner = new DemoScanner((json) => {
    try {
      consider(JSON.parse(json));
    } catch (e) {
      log(`plan ${t}: bad demo JSON (${(e as Error).message})`);
    }
  });
  const { message } = await call({
    model: roleModel("plan").model,
    effort: opts.effort ?? planEffort(),
    label: `plan:${t}`,
    system: systemFor(book),
    messages,
    onText: (d) => scanner.push(d),
  });

  // Safety net: if streaming parsing missed demos (unusual formatting), parse the whole reply.
  if (!accepted.length && !repairs.length) {
    const whole = extractJson(textOf(message)) as { demos?: unknown[] };
    for (const d of whole.demos ?? []) consider(d);
  }

  // Repairs may start further repairs (round 2): wait until none are left.
  for (let n = 0; n < repairs.length; n = repairs.length) await Promise.all(repairs.slice(n));
  for (const p of dropped) log(`plan ${t}: dropped ${p.spec.id}: ${p.errors.join("; ")}`);
  if (!accepted.length) throw new Error(`plan ${t}: no usable demos`);
  write();
  log(`plan ${t}: ${accepted.length} demos, ${accepted.reduce((s, d) => s + d.beats.length, 0)} beats → ${out}`);
  return { book: book.slug, unit: unitId, demos: accepted };
}

/** Planner/outline effort (see roleModel: Sonnet 5.5, medium unless YAGAMI_PLAN_EFFORT / YAGAMI_EFFORT say otherwise). */
export function planEffort(): Effort {
  return roleModel("outline").effort;
}


// =============================================================================
// Outline planning (default): a short outline, then every demo's full spec is
// written in parallel together with its code (see build.ts generateDemo).
// The legacy single-shot planner above stays available (YAGAMI_PLANNER=legacy).
//
// The outline needs only the anchors step's output (anchors + text layer), not the
// assembled page images: run.ts can start it as soon as anchors exist.
// =============================================================================

/** One demo as outlined: enough to write its spec and code without the whole plan. */
export interface OutlineDemo {
  id: string;
  title: string;
  component: string;
  /** What is drawn and manipulated (1–2 sentences). */
  idea: string;
  readouts: { id: string; label: string; measures: string }[];
  beats: { anchor: string; focus: string }[];
  /** A template id from the catalog when the demo is a template config; absent = custom code. */
  template?: string;
}

/**
 * One outlined demo as the model writes it. Compact on the wire (fewer, shorter keys;
 * readouts and beats as tuples): `{ id, t, tpl, idea, r: [[id, label, measures]], b: [[anchor, focus]] }`.
 * The older verbose shape (title/component/readouts/beats objects) is still accepted.
 */
const OutlineWireZ = z
  .object({
    id: z.string(),
    t: z.string().optional(),
    title: z.string().optional(),
    component: z.string().optional(),
    idea: z.string().optional().default(""),
    tpl: z.string().optional(),
    template: z.string().optional(),
    r: z.array(z.array(z.string())).optional(),
    readouts: z.array(z.object({ id: z.string(), label: z.string().optional().default(""), measures: z.string().optional().default("") })).optional(),
    b: z.array(z.array(z.string())).optional(),
    beats: z.array(z.object({ anchor: z.string(), focus: z.string().optional().default("") })).optional(),
  })
  .transform((w): OutlineDemo => {
    const title = (w.t ?? w.title ?? w.id).trim();
    const tpl = (w.tpl ?? w.template)?.trim();
    return {
      id: w.id,
      title,
      component: w.component ?? "",
      idea: w.idea,
      readouts: w.r ? w.r.filter((x) => x[0]).map(([id, label, measures]) => ({ id, label: label ?? id, measures: measures ?? "" })) : (w.readouts ?? []),
      beats: w.b ? w.b.filter((x) => x[0]).map(([anchor, focus]) => ({ anchor, focus: focus ?? "" })) : (w.beats ?? []),
      ...(tpl && tpl !== "custom" ? { template: tpl } : {}),
    };
  });

/** YAGAMI_TEMPLATES=off: every demo is generated as code (A/B benchmarks, debugging). */
export function templatesOff(): boolean {
  return process.env.YAGAMI_TEMPLATES === "off";
}

/** The legacy planner when YAGAMI_PLANNER=legacy (kept for A/B benchmarks). */
export function legacyPlanner(): boolean {
  return process.env.YAGAMI_PLANNER === "legacy";
}

// --- Context without the assembled unit ------------------------------------------

function readRaw(book: BookConfig, unitId: string): RawUnit | null {
  const f = rawUnitPath(book.slug, unitId);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as RawUnit) : null;
}

/**
 * The unit as the outline/planner sees it, built from the anchors step's raw file
 * (anchors + text) so it is available before page images are assembled. Anchor and
 * section geometry is rounded exactly like assemble does, so it equals the assembled
 * unit (and the plan-cache key is the same either way). Page images are not part of
 * it (`src` is empty): use outline images (below), or loadCtx after assemble.
 * Falls back to the assembled unit when the raw file is missing.
 */
export function outlineCtx(book: BookConfig, unitId: string): Ctx {
  const raw = readRaw(book, unitId);
  if (!raw) return loadCtx(book, unitId);
  const byPage = new Map(raw.pages.map((p) => [p.pdfPage, p]));
  const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const norm = (pdfPage: number, x: number, y: number) => {
    const c = byPage.get(pdfPage)!.crop;
    return { x: r4((x - c.left) / c.width), y: r4((y - c.top) / c.height) };
  };
  const anchors: Anchor[] = raw.anchors.map((a) => {
    const tl = norm(a.pdfPage, a.box.l, a.box.t);
    const br = norm(a.pdfPage, a.box.r, a.box.b);
    return { id: a.id, section: a.section, page: byPage.get(a.pdfPage)!.label, y: tl.y, y1: br.y, x: tl.x, x1: br.x, column: a.column, kind: a.kind };
  });
  const unit: Unit = {
    book: book.slug,
    unit: unitId,
    title: raw.title,
    sections: raw.sections.map((s) => ({ id: s.id, title: s.title, page: byPage.get(s.pdfPage)!.label, y: norm(s.pdfPage, 0, s.top).y })),
    pages: raw.pages.map((p) => ({ label: p.label, src: "", width: Math.round(p.crop.width / 2), height: Math.round(p.crop.height / 2) })),
    anchors,
  };
  const tfile = unitTextPath(book.slug, unitId);
  const parsed = fs.existsSync(tfile) ? (JSON.parse(fs.readFileSync(tfile, "utf8")) as UnitText | Record<string, string>) : {};
  // Older fixtures hold the bare id → text map.
  const text: UnitText = typeof parsed.text === "object" ? (parsed as UnitText) : { book: book.slug, unit: unitId, text: parsed as Record<string, string> };
  return { book, unit, text };
}

// --- Outline images: figure/table crops (text PDFs) or whole pages (scans) ---------------

/** Long side of a figure/table crop for text PDFs (cheap; the per-demo calls get full crops later). */
const FIGURE_PX = 560;
/** At most this many figure/table crops per outline part. */
const MAX_FIGURES = 8;
/** Long side of a whole page for scanned books (their OCR text is unreliable). */
const SCAN_PX = 1400;

/**
 * Images for an outline part, from the 300 dpi renders (available right after the render
 * step; original colours). Text PDFs: one small crop per figure/table anchor — the text
 * layer carries the rest. Scans: every page, since OCR text is noisy.
 */
export async function outlineImages(book: BookConfig, unitId: string, pages: string[], anchors: Anchor[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const raw = readRaw(book, unitId);
  if (!raw) return [];
  const byLabel = new Map(raw.pages.map((p) => [p.label, p]));
  const labelOf = new Map(raw.pages.map((p) => [p.pdfPage, p.label]));
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  const load = async (pdfPage: number, region: { left: number; top: number; width: number; height: number } | null, max: number) => {
    const file = pagePng(book.slug, pdfPage);
    if (!fs.existsSync(file)) return null;
    try {
      let img = sharp(file);
      if (region) {
        const meta = await img.metadata();
        const W = meta.width ?? 0;
        const H = meta.height ?? 0;
        const left = Math.max(0, Math.round(region.left));
        const top = Math.max(0, Math.round(region.top));
        const width = Math.min(W - left, Math.round(region.width));
        const height = Math.min(H - top, Math.round(region.height));
        if (width < 8 || height < 8) return null;
        img = sharp(file).extract({ left, top, width, height });
      }
      return await img.resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    } catch {
      return null;
    }
  };
  if (isOcr(book)) {
    for (const label of pages) {
      const p = byLabel.get(label);
      const buf = p && (await load(p.pdfPage, p.crop, SCAN_PX));
      if (buf) out.push({ type: "text", text: `Page ${label}:` }, pngBlock(buf));
    }
    return out;
  }
  const want = new Set(anchors.filter((a) => a.kind === "figure" || a.kind === "table").map((a) => a.id));
  const figs = raw.anchors.filter((a) => want.has(a.id)).slice(0, MAX_FIGURES);
  const bufs = await Promise.all(
    figs.map((a) => {
      const pad = 24;
      return load(a.pdfPage, { left: a.box.l - pad, top: a.box.t - pad, width: a.box.r - a.box.l + 2 * pad, height: a.box.b - a.box.t + 2 * pad }, FIGURE_PX);
    }),
  );
  figs.forEach((a, i) => {
    const buf = bufs[i];
    if (buf) out.push({ type: "text", text: `[${a.id}] (${a.kind}, p.${labelOf.get(a.pdfPage) ?? a.pdfPage}):` }, pngBlock(buf));
  });
  return out;
}

/** Which demos to choose (outline and direct planning). */
export const SELECTION_RULES = `Choosing demos, most important first (when the cap forces a choice, drop from the end of this list):
1. The unit's central object — what its title and opening name as the subject (a random walk in a chapter titled "Random Walks"; the P2c invariant and the two-phase protocol in Paxos) — always gets a demo of its own showing that object itself.
2. Mechanisms, algorithms, constructions and central definitions or theorems.
3. Worked examples that make a mechanism concrete.
4. Results tables, ablations, related work and appendices — only if the cap leaves room.
Never anchor a beat on exercises, problems or solutions, references, acknowledgements or front matter (contents, preface material, index). One demo per idea: never two demos of near-identical ideas. A beat whose caption names "Figure N" or "Table N" is anchored on that figure/table or on a paragraph that discusses it. Give a readout "range": [min, max] when its value has physical or mathematical bounds (errors and distances ≥ 0, probabilities in [0, 1], counts ≥ 0; null for an open side, e.g. [0, null]).`;

function outlineSystem(book: BookConfig, catalog: string): string {
  const d = domainOf(book.domain);
  const noun = unitNoun(book);
  const sees = isOcr(book)
    ? `You get the ${noun} as page images (authoritative: the text was made by OCR, so it is noisy — misread letters and digits — and its equations are garbage) and a list of paragraph anchors with id, page, kind and that OCR text.`
    : `You get the ${noun}'s paragraph anchors with id, page, kind and their text from the PDF's text layer (accurate, but maths is flattened to plain characters), plus small images of its figures and tables.`;
  return `You outline interactive demos that accompany a ${noun} of "${book.title}" (${d.subject}).

The reader sees the original pages and one demo beside them. As they scroll, the demo whose beat is anchored to the paragraph under their reading line becomes active. Each demo is one canvas component with presets, controls and live numerical readouts; its full spec and code are written later from your outline and the anchored paragraphs.

${sees} Anchor ids are the only valid beat anchors.

Propose demos that genuinely aid understanding — about one per distinct idea worth seeing. Good demos let the reader see and manipulate exactly what the text describes, with readouts that check an equation or a quoted number; together they cover the text from start to end where it has substance. Prefer one demo with several beats over several thin demos.

${SELECTION_RULES}

${d.planner}

Each demo has 2–6 beats in reading order; a beat anchors to one paragraph, equation, figure or table (never a heading); an anchor holds at most one beat.

Complexity budget: each demo is ONE idea that fits a compact component (≈200 lines): one scene, at most ~4 controls and 4 readouts, presets that vary parameters of the same scene. If an idea needs several scenes or many strategies, split it or drop it.

${
    catalog
      ? `Ready-made templates. When a demo's idea fits one of these well, mark it with that template id: it is then configured instead of coded (faster, cheaper, already tested). Never force a poor fit — a demo that needs a custom scene, interaction or drawing is "custom", and so is any demo where a template would only be a stand-in, the closest match or an approximation of what the text describes.
${catalog}

`
      : ""
  }Be terse: the detail comes later. Write in your own words. Reply with only this JSON (demos in reading order), no other text:

{"demos":[{"id":"kebab-case","t":"sentence-case title, ≤ 48 chars"${catalog ? `,"tpl":"<template id> or custom"` : ""},"idea":"≤ 25 words: what is drawn and manipulated","r":[["readoutId","short label, may use $LaTeX$","what it measures, ≤ 8 words"]],"b":[["<anchor id>","≤ 12 words: what this beat shows, with the text's numbers (name the figure/table it re-draws)"]]}]}`;
}

/**
 * Normalise one outlined demo against the unit and the demos accepted so far. Returns problems (empty = ok).
 * `allowed`: the anchors beats may use (default: every plannable anchor — no exercises, references or
 * front matter). A template mark whose idea admits a stand-in is dropped (the demo is coded instead);
 * beats that name a figure/table are moved next to it.
 */
export function fixOutline(o: OutlineDemo, c: Ctx, state: PlanState, templateIds: Set<string> = new Set(), allowed: Set<string> = plannableIds(c)): string[] {
  const errs: string[] = [];
  // Unknown or "custom" template marks mean the code path.
  if (o.template !== undefined && !templateIds.has(o.template)) delete o.template;
  const standIn = o.template !== undefined ? standInPhrase(o.idea) : null;
  if (standIn) {
    log(`outline ${tag(c.book.slug, c.unit.unit)}: ${o.id}: template ${o.template} would be a stand-in ("${standIn}"); coding it instead`);
    delete o.template;
    o.idea = `${o.idea} (Draw exactly what the text describes — no stand-in.)`;
  }
  const anchors = c.unit.anchors;
  const order = new Map(anchors.map((a, i) => [a.id, i]));
  o.id = o.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo";
  while (state.ids.has(o.id)) o.id = `${o.id}-2`;
  o.component = o.component.replace(/[^A-Za-z0-9]/g, "");
  if (!/^[A-Z][A-Za-z0-9]+$/.test(o.component)) o.component = o.id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
  if (!/^[A-Z]/.test(o.component)) o.component = `Demo${o.component}`;
  while (state.components.has(o.component)) o.component = `${o.component}2`;
  o.title = clip(o.title.trim(), 48);
  const seen = new Set<string>();
  o.readouts = o.readouts
    .map((r) => ({ ...r, id: r.id.replace(/[^A-Za-z0-9_]/g, "") || "value" }))
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, 5);
  const used = new Set(state.anchors);
  const named = o.beats.filter((b) => order.has(b.anchor)).map((b) => ({ anchor: b.anchor, text: b.focus, beat: b }));
  for (const note of anchorFigureBeats(named, c, used, allowed)) log(`outline ${tag(c.book.slug, c.unit.unit)}: ${o.id}: ${note}`);
  for (const x of named) x.beat.anchor = x.anchor;
  const beats: OutlineDemo["beats"] = [];
  for (const b of o.beats) {
    let idx = order.get(b.anchor);
    if (idx === undefined) continue;
    const section = anchors[idx].section;
    while (idx < anchors.length && (anchors[idx].kind === "heading" || used.has(anchors[idx].id))) idx++;
    if (idx >= anchors.length || anchors[idx].section !== section || !allowed.has(anchors[idx].id)) continue;
    b.anchor = anchors[idx].id;
    used.add(b.anchor);
    beats.push(b);
  }
  beats.sort((a, b) => order.get(a.anchor)! - order.get(b.anchor)!);
  o.beats = beats.slice(0, 6);
  if (o.beats.length < 2) errs.push(`only ${o.beats.length} usable beat(s)`);
  return errs;
}

const plannableCache = new WeakMap<Ctx, Set<string>>();

/** Ids of the anchors that may carry beats (cached per context). */
export function plannableIds(c: Ctx): Set<string> {
  let ids = plannableCache.get(c);
  if (!ids) plannableCache.set(c, (ids = new Set(plannableAnchors(c).map((a) => a.id))));
  return ids;
}

/** Content words of a title/idea, for spotting the same demo proposed twice. */
function words(s: string): Set<string> {
  const stop = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "with", "vs", "by", "its", "how", "what"]);
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

/** True when `o` looks like a demo already accepted (same template or near-identical title + idea). */
export function duplicateOf(o: OutlineDemo, accepted: OutlineDemo[]): OutlineDemo | undefined {
  const tw = words(o.title);
  const iw = words(`${o.title} ${o.idea}`);
  return accepted.find((x) => {
    const titleSim = overlap(tw, words(x.title));
    const ideaSim = overlap(iw, words(`${x.title} ${x.idea}`));
    return titleSim >= 0.8 || (ideaSim >= 0.7 && (o.template ?? "custom") === (x.template ?? "custom"));
  });
}

export interface OutlineOpts {
  effort?: Effort;
  /** false: never mark demos as templates (YAGAMI_TEMPLATES=off does the same). */
  templates?: boolean;
  /** Called for each outlined demo the moment it is accepted. */
  onDemo?: (o: OutlineDemo) => void;
  /** A prebuilt context (default: outlineCtx — works right after the anchors step). */
  ctx?: Ctx;
}

/** Content words of the unit title (its central object, e.g. "random", "walk"), singular. */
function titleWords(c: Ctx): string[] {
  return [...words(c.unit.title)].map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1")).filter((w) => !/^(chapter|part|section|unit|paper|introduction|simple|made|new|via|using|towards?)$/.test(w));
}

/** The prompt line that asks for the unit's central object. */
export function centralNote(c: Ctx, noun: string, split: boolean): string {
  return `The ${noun} is titled "${c.unit.title}": its central object (what the title names) must get a demo of its own showing that object itself${split ? " — in the part where it is introduced" : ""}, chosen before any results table or appendix.`;
}

/** Log a warning when no demo mentions the title's words (the central object may be missing). */
export function warnCentral(c: Ctx, demos: OutlineDemo[], who: string): boolean {
  const tw = titleWords(c);
  if (!tw.length) return true;
  const hit = demos.some((d) => {
    const dw = [...words(`${d.title} ${d.idea}`)].map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1"));
    return tw.some((w) => dw.includes(w));
  });
  if (!hit) emit({ type: "log", level: "warn", message: `${who}: no demo names the unit's central object ("${c.unit.title}")` });
  return hit;
}

/** At most this many parts per unit, outlined in parallel. */
const OUTLINE_MAX_PARTS = 3;
/** A split is used only if its largest part holds at most this share of the text (else it saves no time). */
const SPLIT_MAX_SHARE: Record<number, number> = { 2: 0.7, 3: 0.55 };
/** …and every part holds at least this share (no part is a scrap). */
const SPLIT_MIN_SHARE = 0.12;
/** Units with less text than this stay one part (splitting adds a call's overhead for little gain). */
const SPLIT_MIN_CHARS = 2500;

export interface OutlinePart {
  /** Page labels in this part, in order. */
  pages: string[];
  anchors: Ctx["unit"]["anchors"];
  /** Section ids in this part, in order. */
  sections: string[];
  /** Most demos this part may outline. */
  cap: number;
}

/** Best contiguous partition of `w` into `k` runs, minimising the largest run's sum. Returns run start indices. */
function partition(w: number[], k: number, allowed: (i: number) => boolean): number[] | null {
  const n = w.length;
  if (k > n) return null;
  const pre = [0];
  for (const x of w) pre.push(pre.at(-1)! + x);
  // best[j][i]: min over partitions of the first i items into j runs of the largest run; cut[j][i]: start of the last run.
  const best = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++)
    for (let i = j; i <= n; i++)
      for (let s = j - 1; s < i; s++) {
        if (s > 0 && !allowed(s)) continue;
        const v = Math.max(best[j - 1][s], pre[i] - pre[s]);
        if (v < best[j][i]) {
          best[j][i] = v;
          cut[j][i] = s;
        }
      }
  if (!Number.isFinite(best[k][n])) return null;
  const starts: number[] = [];
  for (let j = k, i = n; j > 0; j--) {
    const s = cut[j][i];
    starts.unshift(s);
    i = s;
  }
  return starts;
}

/**
 * Split a unit into 2–3 contiguous parts so its outline is written in parallel (outline time
 * is mostly output). Units with fewer than two sections, or little text, stay one part. Cuts
 * go at section boundaries; when one section dominates, at paragraph boundaries instead (never
 * right after a heading). A split is used only if it is balanced by text length. Demo caps are
 * shared out by text length (≥ 1 per part) from a total that depends on the unit's length.
 */
export function outlineParts(c: Ctx, keep: Ctx["unit"]["anchors"]): OutlinePart[] {
  const len = (a: Anchor) => (a.kind === "heading" ? 0 : (c.text.text[a.id] ?? "").length + 40);
  const pagesOf = (as: Anchor[]) => [...new Set(as.map((a) => a.page))];
  const sectionsOf = (as: Anchor[]) => [...new Set(as.map((a) => a.section))];
  // Most demos for the whole unit, by substantive length (splitting must not inflate the count).
  const cap = demoCap(c, keep);
  const whole = (): OutlinePart[] => [{ pages: pagesOf(keep), anchors: keep, sections: sectionsOf(keep), cap }];
  const content = (a: Anchor) => a.kind !== "heading" && a.kind !== "other";
  const total = keep.reduce((n, a) => n + len(a), 0);
  const substantive = new Set(keep.filter(content).map((a) => a.section));
  if (substantive.size < 2 || total < SPLIT_MIN_CHARS) return whole();

  const sectionStart = (i: number) => i > 0 && keep[i].section !== keep[i - 1].section;
  const paragraphCut = (i: number) => i > 0 && keep[i - 1].kind !== "heading";
  const w = keep.map(len);
  const ok = (starts: number[], k: number) => {
    const bounds = [...starts, keep.length];
    const sums = starts.map((s, j) => w.slice(s, bounds[j + 1]).reduce((n, x) => n + x, 0));
    const runs = starts.map((s, j) => keep.slice(s, bounds[j + 1]));
    return Math.max(...sums) <= SPLIT_MAX_SHARE[k] * total && Math.min(...sums) >= SPLIT_MIN_SHARE * total && runs.every((r) => r.some(content));
  };
  let starts: number[] | null = null;
  for (const k of [3, 2].filter((k) => k <= OUTLINE_MAX_PARTS)) {
    for (const allowed of [sectionStart, paragraphCut]) {
      const s = partition(w, k, allowed);
      if (s && ok(s, k)) {
        starts = s;
        break;
      }
    }
    if (starts) break;
  }
  if (!starts) return whole();
  const bounds = [...starts, keep.length];
  return shareCaps(c, starts.map((s, j) => keep.slice(s, bounds[j + 1])), cap);
}

/** Text length of an anchor for balancing parts (headings weigh nothing). */
function anchorLen(c: Ctx, a: Anchor): number {
  return a.kind === "heading" ? 0 : (c.text.text[a.id] ?? "").length + 40;
}

/** Parts from contiguous runs of anchors, sharing `cap` demos by text length (largest remainder, ≥ 1 each). */
function shareCaps(c: Ctx, runs: Anchor[][], cap: number): OutlinePart[] {
  const out: OutlinePart[] = runs.map((anchors) => ({ pages: [...new Set(anchors.map((a) => a.page))], anchors, sections: [...new Set(anchors.map((a) => a.section))], cap: 0 }));
  const sums = runs.map((r) => r.reduce((n, a) => n + anchorLen(c, a), 0));
  const total = sums.reduce((n, x) => n + x, 0) || 1;
  const share = sums.map((x) => (cap * x) / total);
  out.forEach((p, i) => (p.cap = Math.max(1, Math.floor(share[i]))));
  let left = cap - out.reduce((n, p) => n + p.cap, 0);
  for (const i of share.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    out[i].cap++;
    left--;
  }
  return out;
}

// --- Direct planning (YAGAMI_DIRECT=on): short units skip the outline --------------------
// Each group of sections goes straight to its demos in one call (scripts/demos/direct.ts).

/** Direct planning is opt-in until benchmarked (YAGAMI_DIRECT=on); never with the legacy planner. */
/**
 * Direct planning (no outline call) for short units — on by default (benchmarked: 3-page excerpt
 * 18.6 s / $0.17, 6-page csapp 30.3 s / $0.21, all demos first try). YAGAMI_DIRECT=off opts out.
 */
export function directEnabled(): boolean {
  return process.env.YAGAMI_DIRECT !== "off" && !legacyPlanner();
}

/** Longest unit (pages) planned directly (YAGAMI_DIRECT_MAX_PAGES, default 8). */
export function directMaxPages(): number {
  const n = Number(process.env.YAGAMI_DIRECT_MAX_PAGES ?? 8);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** This unit is planned directly (enabled, and short enough). */
export function useDirect(book: BookConfig, unitId: string): boolean {
  if (!directEnabled()) return false;
  const u = book.units.find((x) => x.id === unitId);
  return !!u && u.pages[1] - u.pages[0] + 1 <= directMaxPages();
}

/** At most this many groups per unit in direct mode (a group's reply is sequential; groups run in parallel). */
const DIRECT_MAX_GROUPS = 4;
/** A paragraph-split group holds at least this much text. */
const DIRECT_MIN_GROUP_CHARS = 1500;

/**
 * Groups for direct planning: the outline's section-balanced parts when the unit has them;
 * otherwise (one section, or no detected sections) a balanced split at paragraph boundaries
 * into up to 4 groups of at least ~1.5k characters, about two demos each. A group's reply
 * writes its demos one after another, so smaller groups finish sooner.
 */
export function directParts(c: Ctx, keep: Anchor[]): OutlinePart[] {
  const parts = outlineParts(c, keep);
  if (parts.length > 1) return parts;
  const cap = parts[0].cap;
  const w = keep.map((a) => anchorLen(c, a));
  const total = w.reduce((n, x) => n + x, 0);
  // Any non-heading anchor with text counts (a unit without detected sections, like an excerpt,
  // has its paragraphs filed as "other").
  const content = (a: Anchor) => a.kind !== "heading" && (c.text.text[a.id] ?? "").trim().length > 0;
  const k = Math.min(DIRECT_MAX_GROUPS, Math.ceil(cap / 2), Math.floor(total / DIRECT_MIN_GROUP_CHARS));
  for (let g = k; g >= 2; g--) {
    const starts = partition(w, g, (i) => i > 0 && keep[i - 1].kind !== "heading");
    if (!starts) continue;
    const bounds = [...starts, keep.length];
    const runs = starts.map((s, j) => keep.slice(s, bounds[j + 1]));
    if (runs.every((r) => r.some(content))) return shareCaps(c, runs, cap);
  }
  return parts;
}

/**
 * Stream the outline; every demo is normalised locally and handed to `onDemo` as soon as
 * it is complete (no repair calls: an unusable outline item is dropped). Units with two or
 * more sections are outlined in parallel parts (see outlineParts) sharing one id/anchor
 * registry; near-duplicate demos from different parts are dropped. Needs only the anchors
 * step's output. Returns the demos in reading order.
 */
export async function planOutline(book: BookConfig, unitId: string, opts: OutlineOpts = {}): Promise<{ demos: OutlineDemo[]; state: PlanState }> {
  const c = opts.ctx ?? outlineCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const noun = unitNoun(book);
  const keep = plannableAnchors(c);
  sanityGate(c, keep, `outline ${t}`);
  const parts = outlineParts(c, keep);
  const totalCap = parts.reduce((n, p) => n + p.cap, 0);
  const sectionTitle = new Map(c.unit.sections.map((s) => [s.id, s.title]));
  const sectionList = (ids: string[]) => ids.map((id) => `${id} ${sectionTitle.get(id) ?? ""}`.trim()).join("; ");
  const sections = c.unit.sections.filter((s) => !skipSectionReason(s)).map((s) => `${s.id} ${s.title} (p.${s.page})`).join("\n");

  const state: PlanState = { ids: new Set(), components: new Set(), anchors: new Set() };
  const demos: OutlineDemo[] = [];
  const catalog = opts.templates === false || templatesOff() ? [] : await loadTemplates();
  const templateIds = new Set(catalog.map((x) => x.id));
  const system = outlineSystem(book, templateIds.size ? await catalogText() : "");
  const { model } = roleModel("outline");
  if (parts.length > 1) log(`outline ${t}: ${parts.length} parts (${parts.map((p) => `${p.sections[0]}…${p.sections.at(-1)}, ≤${p.cap}`).join("; ")})`);

  const outlinePart = async (part: OutlinePart, i: number) => {
    let count = 0;
    const consider = (raw: unknown) => {
      const parsed = OutlineWireZ.safeParse(raw);
      if (!parsed.success || count >= part.cap || demos.length >= totalCap) return;
      const o = parsed.data;
      const errs = fixOutline(o, c, state, templateIds);
      if (errs.length) return log(`outline ${t}: dropped ${o.id}: ${errs.join("; ")}`);
      const dup = duplicateOf(o, demos);
      if (dup) return log(`outline ${t}: dropped ${o.id}: same idea as ${dup.id}`);
      state.ids.add(o.id);
      state.components.add(o.component);
      for (const b of o.beats) state.anchors.add(b.anchor);
      demos.push(o);
      count++;
      log(`outline ${t}: + ${o.id} (${o.beats.length} beats${o.template ? `, template ${o.template}` : ""}${parts.length > 1 ? `, part ${i + 1}` : ""})`);
      opts.onDemo?.(o);
    };
    const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: `${book.title} — unit "${unitId}": ${c.unit.title}.` }];
    content.push(...(await outlineImages(book, unitId, part.pages, part.anchors)));
    const others = parts.filter((_, j) => j !== i).map((p) => sectionList(p.sections));
    const scope =
      (parts.length > 1
        ? `This is part ${i + 1} of ${parts.length} (sections ${sectionList(part.sections)}); the other parts (${others.join(" | ")}) are outlined separately, in parallel — don't outline their ideas. Outline at most ${part.cap} demo${part.cap === 1 ? "" : "s"} (fewer is fine), anchored only to the paragraphs listed here.`
        : `Outline at most ${totalCap} demos for this ${noun} (fewer is fine).`) + ` ${centralNote(c, noun, parts.length > 1)}`;
    content.push({
      type: "text",
      text: `Sections of the whole ${noun}:\n${sections}\n\nParagraph anchors in reading order (${sourceNote(book).name}):\n\n${part.anchors.map((a) => anchorLine(a, c.text, 600)).join("\n")}\n\n${scope}`,
    });
    const scanner = new DemoScanner((json) => {
      try {
        consider(JSON.parse(json));
      } catch (e) {
        log(`outline ${t}: bad demo JSON (${(e as Error).message})`);
      }
    });
    const { message } = await call({
      model,
      effort: opts.effort ?? planEffort(),
      label: `plan:${t}${parts.length > 1 ? `:part${i + 1}` : ""}`,
      system,
      messages: [{ role: "user", content }],
      maxTokens: 16000,
      onText: (d) => scanner.push(d),
    });
    if (!count) {
      try {
        const whole = extractJson(textOf(message)) as { demos?: unknown[] };
        for (const d of whole.demos ?? []) consider(d);
      } catch {
        /* no JSON */
      }
    }
  };

  // Parts run in parallel; one failing part doesn't sink the others (its demos are just missing).
  const failed: string[] = [];
  await Promise.all(
    parts.map((p, i) =>
      outlinePart(p, i).catch((e: Error) => {
        if (parts.length === 1) throw e;
        failed.push(`part ${i + 1}: ${e.message}`);
        emit({ type: "log", level: "warn", message: `outline ${t}: part ${i + 1} failed: ${e.message}` });
      }),
    ),
  );
  if (!demos.length) throw new Error(`outline ${t}: no usable demos${failed.length ? ` (${failed.join("; ")})` : ""}`);
  const order = new Map(c.unit.anchors.map((a, i) => [a.id, i]));
  demos.sort((a, b) => order.get(a.beats[0].anchor)! - order.get(b.beats[0].anchor)!);
  warnCentral(c, demos, `outline ${t}`);
  log(`outline ${t}: ${demos.length} demos`);
  return { demos, state };
}

// --- Assembling the plan from per-demo specs ------------------------------------

/** Loose spec as written by the builder (expectations by anchor; converted to beat indices). */
export const GeneratedSpecZ = DemoSpecLoose.extend({
  brief: z.string().optional().default(""),
  // Loose on purpose: a bad expectation entry is dropped, it never rejects the spec.
  expect: z.array(z.unknown()).optional().catch(undefined),
});
export type GeneratedSpec = z.infer<typeof GeneratedSpecZ>;

/**
 * Collects the per-demo specs into plan.json as they arrive (written incrementally, in
 * reading order), running the same local fixes and checks as the single-shot planner.
 */
export class PlanAssembler {
  readonly c: Ctx;
  private readonly out: string;
  private readonly accepted = new Map<string, DemoSpec>();
  private readonly order: Map<string, number>;
  private readonly copied: CopyCheck;

  constructor(
    private readonly book: BookConfig,
    private readonly unitId: string,
    /** Outline reservations (ids, components, anchors) of every outlined demo. */
    private readonly outline: { demos: OutlineDemo[] },
    out?: string,
  ) {
    this.c = outlineCtx(book, unitId);
    this.out = out ?? paths.plan(book.slug, unitId);
    // The real plan's assembler owns plan.json until finish(); scratch assemblers don't.
    if (!out) setSpecSink(book.slug, unitId, (spec) => this.accept(spec));
    this.order = new Map(this.c.unit.anchors.map((a, i) => [a.id, i]));
    const bookText = Object.values(this.c.text.text).join(" \n ");
    const captionRuns = shingles(bookText, 9);
    const briefRuns = shingles(bookText, 25);
    this.copied = {
      caption: (x) => [...shingles(x, 9)].some((r) => captionRuns.has(r)),
      brief: (x) => [...shingles(x, 25)].some((r) => briefRuns.has(r)),
    };
  }

  /**
   * Validate and fix a generated spec for outline item `o` in place (identity is pinned to
   * the outline's id/component so progress events stay consistent). Returns problems left.
   */
  check(raw: unknown, o: OutlineDemo): { spec?: DemoSpec; errors: string[]; derived?: Set<number> } {
    const parsed = GeneratedSpecZ.safeParse(raw);
    if (!parsed.success) return { errors: [`the spec doesn't match the DemoSpec shape: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`] };
    const { expect: rawExpect, ...rest } = parsed.data;
    const spec = rest as DemoSpec;
    spec.id = o.id;
    spec.component = o.component;
    // Others' reservations: their outline anchors and whatever they actually used.
    const others = this.outline.demos.filter((x) => x.id !== o.id);
    const state: PlanState = {
      ids: new Set(others.map((x) => x.id)),
      components: new Set(others.map((x) => x.component)),
      anchors: new Set([...others.flatMap((x) => x.beats.map((b) => b.anchor)), ...[...this.accepted.values()].filter((d) => d.id !== o.id).flatMap((d) => d.beats.map((b) => b.anchor))]),
    };
    // The builder writes the code in the same reply, so the brief is only a short note for later fixes.
    spec.brief = (spec.brief ?? "").trim() || o.idea;
    const errors = fixDemo(spec, this.c, state, this.copied, { briefMin: 0 });
    spec.id = o.id;
    spec.component = o.component;
    const readoutIds = new Set(spec.readouts.map((r) => r.id));
    const expect: Expectation[] = [];
    // Expectations the builder derived from the text's quantities and explained ("why"): exempt from grounding.
    const derived = new Set<number>();
    for (const raw of rawExpect ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { anchor?: unknown; beat?: unknown; readout?: unknown; value?: unknown; tol?: unknown; why?: unknown };
      const beat = typeof e.anchor === "string" ? spec.beats.findIndex((b) => b.anchor === e.anchor) : typeof e.beat === "number" && Number.isInteger(e.beat) && e.beat >= 0 && e.beat < spec.beats.length ? e.beat : -1;
      const value = typeof e.value === "number" ? e.value : typeof e.value === "string" ? Number(e.value.replace(/[,\s]/g, "")) : NaN;
      if (beat < 0 || typeof e.readout !== "string" || !readoutIds.has(e.readout) || !Number.isFinite(value)) continue;
      const tol = typeof e.tol === "number" && e.tol >= 0 && e.tol <= 1 ? e.tol : undefined;
      if (typeof e.why === "string" && e.why.trim().length >= 3) derived.add(expect.length);
      expect.push({ beat, readout: e.readout, value, ...(tol !== undefined ? { tol } : {}) });
    }
    if (expect.length) spec.expect = expect;
    else delete spec.expect;
    return { spec, errors, derived };
  }

  /**
   * Grounding problems of a checked spec (and its template config, if any): numbers stated as the
   * text's that are neither printed in the unit/its figures and tables nor simply derived. Never a
   * reason to reject: callers ask for one correction and then proceed.
   */
  ground(spec: DemoSpec, o: OutlineDemo, derived?: Set<number>): string[] {
    try {
      const src = groundingSource(this.c, spec, [o.idea, ...o.beats.map((b) => b.focus)]);
      return groundingProblems(src, spec, [...configNumbers(spec.config), ...specNumbers(spec, derived)]);
    } catch (e) {
      log(`plan ${tag(this.book.slug, this.unitId)}: grounding check failed (${(e as Error).message})`);
      return [];
    }
  }

  accept(spec: DemoSpec) {
    this.accepted.set(spec.id, spec);
    this.write();
  }

  specs(): DemoSpec[] {
    return [...this.accepted.values()].sort((a, b) => this.order.get(a.beats[0].anchor)! - this.order.get(b.beats[0].anchor)!);
  }

  write() {
    writeJson(this.out, { book: this.book.slug, unit: this.unitId, demos: this.specs() });
  }

  /** Final plan (throws when nothing usable was produced). */
  finish(): DemoPlan {
    const demos = this.specs();
    if (!demos.length) throw new Error(`plan ${tag(this.book.slug, this.unitId)}: no usable demos`);
    this.write();
    setSpecSink(this.book.slug, this.unitId, null);
    return { book: this.book.slug, unit: this.unitId, demos };
  }
}
