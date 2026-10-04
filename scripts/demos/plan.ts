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
import { call, MODELS, textOf, type Effort } from "../lib/claude";
import type { BookConfig, ControlSpec, DemoPlan, DemoSpec, Params, ParamValue } from "../../src/types";
import { anchorLine, type Ctx, extractJson, loadCtx, log, pageImage, paths, pngBlock, tag, textSourceNote, writeJson } from "./common";
import { domainOf } from "./domains";

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

/** Bump to invalidate cached plans when the prompt or rules change. */
const PLAN_VERSION = "2";

// --- Verbatim-copy detection -----------------------------------------------------

function shingles(text: string, n: number): Set<string> {
  const w = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

// --- Local fixes + checks (one demo at a time) ---------------------------------

/** State shared across the demos of one plan (uniqueness constraints). */
interface PlanState {
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
function fixDemo(d: DemoSpec, c: Ctx, state: PlanState, copied: (s: string) => boolean): string[] {
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
  if (d.title.length > 48) errs.push(`title is ${d.title.length} chars; at most 48`);
  if (d.brief.length < 200) errs.push("brief is too short (at least 150 words of implementable spec)");
  if (copied(d.brief)) errs.push("brief copies sentences from the text; write it in your own words");

  // Controls, readouts, presets.
  const seenControl = new Set<string>();
  d.controls = d.controls.filter((x) => (seenControl.has(x.id) ? false : (seenControl.add(x.id), true)));
  if (d.controls.length > 6) errs.push(`${d.controls.length} controls; at most 6`);
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
    b.caption = b.caption.replace(/!/g, ".").trim();
    if (/\bAI\b/.test(b.caption)) errs.push(`beat at ${b.anchor}: caption must not mention AI`);
    if (b.caption.length > 260) errs.push(`beat at ${b.anchor}: caption is ${b.caption.length} chars; at most 260`);
    if (b.caption.length < 10) errs.push(`beat at ${b.anchor}: caption too short`);
    if (copied(b.caption)) errs.push(`beat at ${b.anchor}: caption copies a sentence from the text; write it in your own words`);
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

Your job: propose 3–7 demos for the ${noun} that genuinely aid understanding. Across all fields, good demos:
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
  return h(PLAN_VERSION, systemFor(book), JSON.stringify(c.unit), JSON.stringify(c.text));
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

  const bookRuns = shingles(Object.values(c.text.text).join(" \n "), 9);
  const copied = (s: string) => [...shingles(s, 9)].some((r) => bookRuns.has(r));
  const state: PlanState = { ids: new Set(), components: new Set(), anchors: new Set() };
  const accepted: DemoSpec[] = [];
  const pending: { spec: DemoSpec; errors: string[] }[] = [];
  const order = new Map(c.unit.anchors.map((a, i) => [a.id, i]));

  const write = () => {
    const demos = [...accepted].sort((a, b) => order.get(a.beats[0].anchor)! - order.get(b.beats[0].anchor)!);
    writeJson(out, { book: book.slug, unit: unitId, demos });
  };
  const consider = (raw: unknown) => {
    const parsed = DemoSpecLoose.safeParse(raw);
    if (!parsed.success) {
      log(`plan ${t}: unparseable demo (${parsed.error.issues[0]?.message ?? "?"})`);
      return;
    }
    const spec = parsed.data as DemoSpec;
    if (accepted.length >= 7) return;
    const errors = fixDemo(spec, c, state, copied);
    if (errors.length) {
      pending.push({ spec, errors });
      return;
    }
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
    model: MODELS.opus,
    effort: opts.effort ?? "medium",
    label: `plan:${t}`,
    system: systemFor(book),
    messages,
    onText: (d) => scanner.push(d),
  });
  messages.push({ role: "assistant", content: message.content });

  // Safety net: if streaming parsing missed demos (unusual formatting), parse the whole reply.
  if (!accepted.length && !pending.length) {
    const whole = extractJson(textOf(message)) as { demos?: unknown[] };
    for (const d of whole.demos ?? []) consider(d);
  }

  // Repair only the demos that still have problems (≤ 2 short follow-ups).
  for (let round = 1; round <= 2 && pending.length && accepted.length < 7; round++) {
    const batch = pending.splice(0);
    log(`plan ${t}: repairing ${batch.length} demo(s) (round ${round})`);
    messages.push({
      role: "user",
      content: `Some demos need corrections before they can be used:\n\n${batch
        .map((p) => `Demo "${p.spec.id}":\n${p.errors.map((e) => `- ${e}`).join("\n")}`)
        .join("\n\n")}\n\nAnchors already used by accepted demos (do not reuse): ${[...state.anchors].join(", ") || "none"}.\nReply with JSON {"demos": [ ... ]} containing only the corrected versions of these demos.`,
    });
    const scanner2 = new DemoScanner((json) => {
      try {
        consider(JSON.parse(json));
      } catch {
        /* reported below if nothing usable came back */
      }
    });
    const r = await call({ model: MODELS.opus, effort: "low", label: `plan-repair:${t}`, system: systemFor(book), messages, onText: (d) => scanner2.push(d) });
    messages.push({ role: "assistant", content: r.message.content });
  }
  for (const p of pending) log(`plan ${t}: dropped ${p.spec.id}: ${p.errors.join("; ")}`);
  if (!accepted.length) throw new Error(`plan ${t}: no usable demos`);
  write();
  log(`plan ${t}: ${accepted.length} demos, ${accepted.reduce((s, d) => s + d.beats.length, 0)} beats → ${out}`);
  return { book: book.slug, unit: unitId, demos: accepted };
}
