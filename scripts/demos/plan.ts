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

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { call, roleModel, textOf, type Effort } from "../lib/claude";
import type { BookConfig, ControlSpec, DemoPlan, DemoSpec, Expectation, Params, ParamValue } from "../../src/types";
import { anchorLine, type Ctx, extractJson, loadCtx, log, pageImage, paths, pngBlock, setSpecSink, tag, textSourceNote, writeJson } from "./common";
import { outlineCatalog as catalogText, templates as loadTemplates } from "./template";
import { domainOf } from "./domains";
import { emit } from "../lib/report";

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
  readouts: z.array(z.object({ id: z.string(), label: z.string() })),
  beats: z.array(z.object({ anchor: z.string(), preset: z.string(), caption: z.string(), params: ParamsZ.optional() })),
});

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
  const src = textSourceNote(book);
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
const SKIP_SECTION = /^(references|bibliography|acknowledg(e)?ments?|keywords|ccs-concepts|acm-reference-format)/;

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
  const c = loadCtx(book, unitId);
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
  const keep = c.unit.anchors.filter((a) => !SKIP_SECTION.test(a.section));
  const pagesWithContent = new Set(keep.map((a) => a.page));
  const maxPx = book.source.kind === "text" ? 1100 : 1400;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `${book.title} — unit "${unitId}": ${c.unit.title}. The pages follow, in order.` },
  ];
  const images = await Promise.all(c.unit.pages.filter((p) => pagesWithContent.has(p.label)).map(async (p) => ({ p, img: await pageImage(c, p.label, maxPx) })));
  for (const { p, img } of images) if (img) content.push({ type: "text", text: `Page ${p.label}:` }, pngBlock(img));
  const sections = c.unit.sections.filter((s) => !SKIP_SECTION.test(s.id)).map((s) => `${s.id} ${s.title} (p.${s.page})`).join("\n");
  content.push({
    type: "text",
    text: `Sections:\n${sections}\n\nParagraph anchors in reading order (${textSourceNote(book).name}; the page images are authoritative):\n\n${keep.map((a) => anchorLine(a, c.text, 600)).join("\n")}\n\nPropose the demo plan for this ${noun} (book "${book.slug}", unit "${unitId}").`,
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
// Outline planning (default): a short Opus outline, then every demo's full spec
// is written in parallel together with its code (see build.ts generateDemo).
// The legacy single-shot planner above stays available (YAGAMI_PLANNER=legacy).
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

const OutlineDemoZ = z.object({
  id: z.string(),
  title: z.string(),
  component: z.string(),
  idea: z.string(),
  readouts: z.array(z.object({ id: z.string(), label: z.string(), measures: z.string().optional().default("") })),
  beats: z.array(z.object({ anchor: z.string(), focus: z.string().optional().default("") })),
  template: z.string().optional(),
});

/** YAGAMI_TEMPLATES=off: every demo is generated as code (A/B benchmarks, debugging). */
export function templatesOff(): boolean {
  return process.env.YAGAMI_TEMPLATES === "off";
}

/** The legacy planner when YAGAMI_PLANNER=legacy (kept for A/B benchmarks). */
export function legacyPlanner(): boolean {
  return process.env.YAGAMI_PLANNER === "legacy";
}

function outlineSystem(book: BookConfig, catalog: string): string {
  const d = domainOf(book.domain);
  const noun = unitNoun(book);
  const src = textSourceNote(book);
  return `You outline interactive demos that accompany a ${noun} of "${book.title}" (${d.subject}).

The reader sees the original pages on the right and one demo on the left. As they scroll, the demo whose beat is anchored to the paragraph under their reading line becomes active. Each demo is one React canvas component with presets, controls and live numerical readouts; an engineer writes its full spec and code later from your outline, the anchored paragraphs and page crops.

You get the ${noun} as page images (authoritative for equations, figures and wording) and a list of paragraph anchors with id, page, kind and ${src.name}. ${src.caveat} Anchor ids are the only valid beat anchors.

Propose 3–7 demos that genuinely aid understanding — about one per distinct idea worth seeing; a unit of 5+ pages usually has 5–6. Good demos let the reader see and manipulate exactly what the text describes, with readouts that check an equation or a quoted number; together they cover the ${noun} from start to end where it has substance; each is simple enough for one component (~200–400 lines). Prefer one demo with several beats over several thin demos.

${d.planner}

Each demo has 2–6 beats in reading order; a beat anchors to one paragraph, equation, figure or table (never a heading); an anchor holds at most one beat across the whole ${noun}.

Complexity budget: each demo is ONE idea that fits a compact component (≈200 lines): one scene, at most ~4 controls and 4 readouts, presets that vary parameters of the same scene rather than switching between different scenes. If an idea needs several scenes, comparisons of many strategies or a big simulation, split it into separate demos or drop it.

${
    catalog
      ? `Ready-made templates. When a demo's idea fits one of these well, mark it with that template id: it is then configured instead of coded (faster, cheaper, already tested). Never force a poor fit — a demo that needs a custom scene, interaction or drawing is "custom".
${catalog}

`
      : ""
  }Keep the outline short — the detail comes later. Write in your own words. Reply with only this JSON (demos in reading order):

{ "demos": [ {
  "id": "kebab-case",
  "title": "sentence case, ≤ 48 chars",
  "component": "PascalCase, unique",
  "idea": "≤ 40 words: what is drawn, what the reader manipulates, which figure it re-draws if any",
  "readouts": [ { "id": "camelCase", "label": "short, may use $LaTeX$", "measures": "≤ 15 words" } ],
  "beats": [ { "anchor": "<anchor id>", "focus": "≤ 20 words: what this beat shows, with the text's numbers" } ]${catalog ? `,
  "template": "<template id> or custom"` : ""}
} ] }`;
}

/** Normalise one outlined demo against the unit and the demos accepted so far. Returns problems (empty = ok). */
function fixOutline(o: OutlineDemo, c: Ctx, state: PlanState, templateIds: Set<string> = new Set()): string[] {
  const errs: string[] = [];
  // Unknown or "custom" template marks mean the code path.
  if (o.template !== undefined && !templateIds.has(o.template)) delete o.template;
  const anchors = c.unit.anchors;
  const order = new Map(anchors.map((a, i) => [a.id, i]));
  o.id = o.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo";
  while (state.ids.has(o.id)) o.id = `${o.id}-2`;
  o.component = o.component.replace(/[^A-Za-z0-9]/g, "");
  if (!/^[A-Z][A-Za-z0-9]+$/.test(o.component)) o.component = o.id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
  while (state.components.has(o.component)) o.component = `${o.component}2`;
  o.title = clip(o.title.trim(), 48);
  const seen = new Set<string>();
  o.readouts = o.readouts
    .map((r) => ({ ...r, id: r.id.replace(/[^A-Za-z0-9_]/g, "") || "value" }))
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, 5);
  const used = new Set(state.anchors);
  const beats: OutlineDemo["beats"] = [];
  for (const b of o.beats) {
    let idx = order.get(b.anchor);
    if (idx === undefined) continue;
    const section = anchors[idx].section;
    while (idx < anchors.length && (anchors[idx].kind === "heading" || used.has(anchors[idx].id))) idx++;
    if (idx >= anchors.length || anchors[idx].section !== section) continue;
    b.anchor = anchors[idx].id;
    used.add(b.anchor);
    beats.push(b);
  }
  beats.sort((a, b) => order.get(a.anchor)! - order.get(b.anchor)!);
  o.beats = beats.slice(0, 6);
  if (o.beats.length < 2) errs.push(`only ${o.beats.length} usable beat(s)`);
  return errs;
}

export interface OutlineOpts {
  effort?: Effort;
  /** false: never mark demos as templates (YAGAMI_TEMPLATES=off does the same). */
  templates?: boolean;
  /** Called for each outlined demo the moment it is accepted. */
  onDemo?: (o: OutlineDemo) => void;
}

/** Units with more content pages than this are outlined in parallel parts (one call per part). */
const OUTLINE_PART_PAGES = 5;
/** At most this many parts (each part gets ≥ 2 of the unit's demos). */
const OUTLINE_MAX_PARTS = 3;
/** Demos per unit. */
const MAX_DEMOS = 7;

interface OutlinePart {
  /** Page labels in this part, in order. */
  pages: string[];
  anchors: Ctx["unit"]["anchors"];
  /** Most demos this part may outline. */
  cap: number;
}

/**
 * Split a unit's content pages into contiguous parts of about OUTLINE_PART_PAGES pages,
 * cutting at section starts where possible, so long units are outlined in parallel and
 * outline time doesn't grow with length. Demo caps are shared out by page count.
 */
export function outlineParts(c: Ctx, keep: Ctx["unit"]["anchors"]): OutlinePart[] {
  const pages = c.unit.pages.map((p) => p.label).filter((l) => keep.some((a) => a.page === l));
  const k = Math.max(1, Math.min(OUTLINE_MAX_PARTS, Math.ceil(pages.length / OUTLINE_PART_PAGES)));
  if (k === 1) return [{ pages, anchors: keep, cap: MAX_DEMOS }];
  // Pages where a section starts: preferred cut points.
  const sectionStart = new Set(c.unit.sections.map((s) => s.page));
  const cuts: number[] = [];
  for (let j = 1; j < k; j++) {
    const target = Math.round((pages.length * j) / k);
    const near = [target, target + 1, target - 1].find((i) => i > (cuts.at(-1) ?? 0) && i < pages.length && sectionStart.has(pages[i]));
    cuts.push(near ?? Math.max(target, (cuts.at(-1) ?? 0) + 1));
  }
  const bounds = [0, ...cuts, pages.length];
  const parts: OutlinePart[] = [];
  for (let j = 0; j < k; j++) {
    const ps = pages.slice(bounds[j], bounds[j + 1]);
    if (!ps.length) continue;
    const set = new Set(ps);
    parts.push({ pages: ps, anchors: keep.filter((a) => set.has(a.page)), cap: 0 });
  }
  // Share MAX_DEMOS by pages (largest remainder), at least 2 per part.
  const total = parts.reduce((n, p) => n + p.pages.length, 0);
  const raw = parts.map((p) => (MAX_DEMOS * p.pages.length) / total);
  parts.forEach((p, i) => (p.cap = Math.max(2, Math.floor(raw[i]))));
  let left = MAX_DEMOS - parts.reduce((n, p) => n + p.cap, 0);
  for (const i of raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    parts[i].cap++;
    left--;
  }
  return parts;
}

/**
 * Stream the outline; every demo is normalised locally and handed to `onDemo` as soon as
 * it is complete (no repair calls: an unusable outline item is dropped). Long units are
 * outlined in parallel parts (see outlineParts) sharing one id/anchor registry. Returns them all.
 */
export async function planOutline(book: BookConfig, unitId: string, opts: OutlineOpts = {}): Promise<{ demos: OutlineDemo[]; state: PlanState }> {
  const c = loadCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const noun = unitNoun(book);
  const keep = c.unit.anchors.filter((a) => !SKIP_SECTION.test(a.section));
  const parts = outlineParts(c, keep);
  const maxPx = book.source.kind === "text" ? 1100 : 1400;
  const sections = c.unit.sections.filter((s) => !SKIP_SECTION.test(s.id)).map((s) => `${s.id} ${s.title} (p.${s.page})`).join("\n");

  const state: PlanState = { ids: new Set(), components: new Set(), anchors: new Set() };
  const demos: OutlineDemo[] = [];
  const catalog = opts.templates === false || templatesOff() ? [] : await loadTemplates();
  const templateIds = new Set(catalog.map((x) => x.id));
  const system = outlineSystem(book, templateIds.size ? await catalogText() : "");
  const { model } = roleModel("outline");
  if (parts.length > 1) log(`outline ${t}: ${parts.length} parts (${parts.map((p) => `pp.${p.pages[0]}–${p.pages.at(-1)}, ≤${p.cap}`).join("; ")})`);

  const outlinePart = async (part: OutlinePart, i: number) => {
    let count = 0;
    const consider = (raw: unknown) => {
      const parsed = OutlineDemoZ.safeParse(raw);
      if (!parsed.success || count >= part.cap || demos.length >= MAX_DEMOS) return;
      const o = parsed.data as OutlineDemo;
      const errs = fixOutline(o, c, state, templateIds);
      if (errs.length) return log(`outline ${t}: dropped ${o.id}: ${errs.join("; ")}`);
      state.ids.add(o.id);
      state.components.add(o.component);
      for (const b of o.beats) state.anchors.add(b.anchor);
      demos.push(o);
      count++;
      log(`outline ${t}: + ${o.id} (${o.beats.length} beats${o.template ? `, template ${o.template}` : ""}${parts.length > 1 ? `, part ${i + 1}` : ""})`);
      opts.onDemo?.(o);
    };
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: "text", text: `${book.title} — unit "${unitId}": ${c.unit.title}. The pages follow, in order.` },
    ];
    const images = await Promise.all(part.pages.map(async (label) => ({ label, img: await pageImage(c, label, maxPx) })));
    for (const { label, img } of images) if (img) content.push({ type: "text", text: `Page ${label}:` }, pngBlock(img));
    const scope =
      parts.length > 1
        ? `This is part ${i + 1} of ${parts.length} of the ${noun} (pages ${part.pages[0]}–${part.pages.at(-1)}); the other parts are outlined separately. Outline at most ${part.cap} demos, anchored only to the paragraphs listed here.`
        : `Outline the demos for this ${noun}.`;
    content.push({
      type: "text",
      text: `Sections of the whole ${noun}:\n${sections}\n\nParagraph anchors in reading order (${textSourceNote(book).name}; the page images are authoritative):\n\n${part.anchors.map((a) => anchorLine(a, c.text, 600)).join("\n")}\n\n${scope}`,
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
    this.c = loadCtx(book, unitId);
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
  check(raw: unknown, o: OutlineDemo): { spec?: DemoSpec; errors: string[] } {
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
    for (const raw of rawExpect ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { anchor?: unknown; beat?: unknown; readout?: unknown; value?: unknown; tol?: unknown };
      const beat = typeof e.anchor === "string" ? spec.beats.findIndex((b) => b.anchor === e.anchor) : typeof e.beat === "number" && Number.isInteger(e.beat) && e.beat >= 0 && e.beat < spec.beats.length ? e.beat : -1;
      const value = typeof e.value === "number" ? e.value : typeof e.value === "string" ? Number(e.value.replace(/[,\s]/g, "")) : NaN;
      if (beat < 0 || typeof e.readout !== "string" || !readoutIds.has(e.readout) || !Number.isFinite(value)) continue;
      const tol = typeof e.tol === "number" && e.tol >= 0 && e.tol <= 1 ? e.tol : undefined;
      expect.push({ beat, readout: e.readout, value, ...(tol !== undefined ? { tol } : {}) });
    }
    if (expect.length) spec.expect = expect;
    else delete spec.expect;
    return { spec, errors };
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
