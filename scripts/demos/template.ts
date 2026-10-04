// Template demos: when a demo fits one of the app's parametric templates
// (src/demo/templates/catalog.ts), the builder writes only its spec + config —
// no component code, no typecheck. Checks and review notes come back as
// config-fix turns. If no valid config comes out, the demo falls back to the
// normal code path.

import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { call, type Effort, fixEffort, prewarm, roleModel, systemCacheControl, textOf } from "../lib/claude";
import type { BookConfig, DemoSpec } from "../../src/types";
import { emit } from "../lib/report";
import { anchorContext, type Ctx, extractJson, loadPlan, log, paths, pngBlock, tag, textSourceNote } from "./common";
import { bookImages, buildEffort, loadConvo, saveConvo, saveSpec, type Convo } from "./build";
import { DEMO_RULES } from "./rules";
import { PlanAssembler, type OutlineDemo } from "./plan";

/** Mirrors TemplateInfo in src/demo/templates/catalog.ts (loaded at runtime; absent → no templates). */
export interface TemplateInfo {
  id: string;
  title: string;
  when: string;
  configDoc: string;
  /** One valid example config. */
  example?: unknown;
  validate(config: unknown, spec: DemoSpec): string[];
}

let catalog: Promise<TemplateInfo[]> | null = null;

/** The template catalog, or [] when it can't be loaded (everything then takes the code path). */
export function templates(): Promise<TemplateInfo[]> {
  // A variable specifier: the catalog is optional at build time and must never break planning.
  const spec = "../../src/demo/templates/catalog";
  catalog ??= (import(spec) as Promise<{ TEMPLATES?: TemplateInfo[] }>)
    .then((m) => (Array.isArray(m.TEMPLATES) ? m.TEMPLATES.filter((t) => t && typeof t.id === "string" && typeof t.validate === "function") : []))
    .catch((e: unknown) => {
      log(`templates: catalog unavailable (${(e as Error).message}); every demo is generated as code`);
      return [];
    });
  return catalog;
}

/** Compact catalog for the outline prompt (id + when to use it). */
export async function outlineCatalog(): Promise<string> {
  const list = await templates();
  if (!list.length) return "";
  return list.map((t) => `- ${t.id} (${t.title}): ${t.when.replace(/\s+/g, " ").trim()}`).join("\n");
}

const TEMPLATE_MAX_TOKENS = 6000;

let systemText: Promise<Anthropic.Beta.BetaTextBlockParam[]> | null = null;

/** Stable (cached) system prompt for writing template specs: the contract + every template's config doc. */
async function systemPrompt(): Promise<Anthropic.Beta.BetaTextBlockParam[]> {
  systemText ??= (async () => {
    const list = await templates();
    const docs = list
      .map((t) => `### ${t.id} — ${t.title}\nUse when: ${t.when}\n\n${t.configDoc}${t.example !== undefined ? `\n\nExample config:\n\`\`\`json\n${JSON.stringify(t.example, null, 1)}\n\`\`\`` : ""}`)
      .join("\n\n");
    const text = `You configure interactive demos for a reader of technical texts (papers and textbooks, mostly maths and computer science). The reader sees the original pages and one demo beside the paragraph they are reading. A demo is rendered by a ready-made, parametric TEMPLATE: you write no code, only the demo's spec and the template's config.

## Contract: src/types.ts
\`\`\`ts
${fs.readFileSync(path.resolve("src/types.ts"), "utf8")}
\`\`\`

## Templates
${docs}

## What you write
One \`\`\`json block containing a DemoSpec plus "template", "config" and "expect":
{
  "id", "title", "component", "brief": "1–2 sentences: what the demo shows",
  "presets": [{ "id", "label", "params": { <every control id>: value, plus any fixed params the config uses } }],
  "controls": [ ≤ 4 ControlSpec ], "readouts": [ ≤ 4 { "id", "label" } ],
  "beats": [{ "anchor": "<anchor id from the outline>", "preset": "<preset id>", "caption": "1–2 plain sentences in your own words, specific to that paragraph", "params"?: { overrides } }],
  "template": "<template id>",
  "config": { …exactly as that template's doc describes; refer to params by their ids… },
  "expect": [{ "anchor": "<beat anchor>", "readout": "<readout id>", "value": <number>, "tol"?: <relative tolerance, 0 = exact> }]
}

Robustness (written for coded demos — for a config it means: every readout and expression stays finite at every control's min and max and in every preset, labels stay inside the stage and don't overlap, nothing depends on randomness without a seed):
${DEMO_RULES}

Rules
- Keep the outline's ids, component name, beat anchors and readout ids.
- Every param id an expression or field in the config uses must be a control or a preset param.
- "expect": add an entry wherever the text pins down a readout's value at a beat (a quoted number, a worked example, an equation evaluated at the beat's params). Only values that follow unambiguously from the text and the beat's params; omit the list otherwise. Readouts are rendered with \`fmt\` (3 decimals) unless the config formats them.
- Captions: no exclamation marks, never mention AI, never copy sentences from the text.
- Reply with only the \`\`\`json block.`;
    // 1-hour TTL: runs within an hour share this prefix (see systemCacheControl).
    return [{ type: "text" as const, text, cache_control: systemCacheControl() }];
  })();
  return systemText;
}

const warm = new Map<string, Promise<void>>();

/**
 * Write the template prompt to the cache once per effort (cache entries are per model + effort),
 * as soon as the outline marks the first template demo; template calls wait for it so parallel
 * first calls read the cache instead of each writing it.
 */
export function warmTemplates(book: BookConfig, effort: Effort = templateEffort()): Promise<void> {
  const { model } = roleModel("template");
  const key = `${model}:${effort}`;
  let p = warm.get(key);
  if (!p) {
    p = systemPrompt().then((system) => prewarm({ model, effort, label: `template-warm:${book.slug}`, system }));
    warm.set(key, p);
  }
  return p;
}

/** Effort for writing a template spec + config (the template group's, else the builder's). */
function templateEffort(): Effort {
  return roleModel("template").effort ?? buildEffort();
}

function jsonOf(text: string): unknown {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  try {
    return m ? JSON.parse(m[1]) : extractJson(text);
  } catch {
    return undefined;
  }
}

async function turn(book: BookConfig, effort: Effort, label: string, messages: Anthropic.Beta.BetaMessageParam[]) {
  try {
    return await call({ model: roleModel("template").model, effort, label, system: await systemPrompt(), messages, maxTokens: TEMPLATE_MAX_TOKENS });
  } catch (e) {
    if (/hit max_tokens/.test((e as Error).message)) return null;
    throw e;
  }
}

/** Validate a reply against the spec rules and the template; returns the spec or the problems. */
async function checkReply(raw: unknown, o: OutlineDemo, templateId: string, plan: PlanAssembler): Promise<{ spec?: DemoSpec; errors: string[] }> {
  if (!raw || typeof raw !== "object") return { errors: ["the reply had no JSON spec"] };
  const r = raw as { config?: unknown; template?: unknown };
  const checked = plan.check(raw, o);
  const errors = [...checked.errors];
  const tpl = (await templates()).find((t) => t.id === templateId);
  if (!tpl) return { errors: [`unknown template "${templateId}"`] };
  if (r.template !== undefined && r.template !== templateId) errors.push(`"template" must stay "${templateId}"`);
  if (r.config === undefined) errors.push(`"config" is missing`);
  if (!checked.spec) return { errors };
  const spec = checked.spec;
  spec.template = templateId;
  spec.config = r.config;
  if (r.config !== undefined) {
    try {
      errors.push(...tpl.validate(r.config, spec));
    } catch (e) {
      errors.push(`the config could not be validated: ${(e as Error).message}`);
    }
  }
  return errors.length ? { errors } : { spec, errors: [] };
}

function firstMessage(c: Ctx, o: OutlineDemo, others: OutlineDemo[], images: Anthropic.Beta.BetaContentBlockParam[]): Anthropic.Beta.BetaMessageParam {
  const src = textSourceNote(c.book);
  const beats = o.beats.map((b, i) => `Beat ${i} at ${b.anchor} — ${b.focus}\n${anchorContext(c, b.anchor, 1, 1)}`).join("\n\n");
  const rest = others.filter((x) => x.id !== o.id).map((x) => `- ${x.title}: ${x.idea}`).join("\n");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Write the spec and config for this outline item from "${c.book.title}", using the template "${o.template}":\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\n\nOther demos (don't duplicate them):\n${rest || "(none)"}\n\nThe beats and the paragraphs they are anchored to (">>>" marks the anchor; ${src.name}. ${src.caveat} The crops below are authoritative):\n\n${beats}`,
      },
      ...images,
    ],
  };
}

export interface TemplateGenerated {
  spec?: DemoSpec;
  ok: boolean;
  /** No valid config came out: build this demo as code instead. */
  fallback?: boolean;
  why?: string;
}

/** Outline item → spec + template config (one Sonnet conversation, up to two repair turns). */
export async function generateTemplateDemo(c: Ctx, o: OutlineDemo, plan: PlanAssembler, others: OutlineDemo[]): Promise<TemplateGenerated> {
  const book = c.book;
  const t = tag(book.slug, c.unit.unit);
  const templateId = o.template!;
  emit({ type: "demo", unit: c.unit.unit, id: o.id, phase: "building", detail: `configuring the ${templateId} template` });
  const images = await bookImages(c, { brief: `${o.idea} ${o.beats.map((b) => b.focus).join(" ")}`, beats: o.beats.map((b) => ({ anchor: b.anchor, preset: "", caption: "" })) });
  const messages: Anthropic.Beta.BetaMessageParam[] = [firstMessage(c, o, others, images)];
  const effort = templateEffort();
  await warmTemplates(book, effort);
  let result: { spec?: DemoSpec; errors: string[] } = { errors: [] };
  // Two repair turns: falling back to code is far slower and costlier than another short config turn.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await turn(book, effort, `template:${t}:${o.id}`, messages);
    if (!r) return { ok: false, fallback: true, why: "the template config reply was cut off" };
    messages.push({ role: "assistant", content: r.message.content });
    result = await checkReply(jsonOf(textOf(r.message)), o, templateId, plan);
    if (!result.errors.length) break;
    log(`template ${t} ${o.id}: ${result.errors.length} problem(s): ${result.errors.slice(0, 2).join("; ")}`);
    if (attempt < 2)
      messages.push({ role: "user", content: `The spec/config needs corrections:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nReply with the complete corrected JSON in one \`\`\`json block (same ids).` });
  }
  if (result.errors.length || !result.spec) {
    log(`template ${t} ${o.id}: no valid config; generating it as code instead`);
    return { ok: false, fallback: true, why: result.errors[0] };
  }
  const spec = result.spec;
  plan.accept(spec);
  // Remove a stale component file from an earlier code build of this demo (the template renders it now).
  const file = paths.component(book.slug, c.unit.unit, spec.component);
  if (fs.existsSync(file)) fs.rmSync(file);
  saveConvo({ book: book.slug, unit: c.unit.unit, spec, messages, effort, kind: "template" });
  log(`template ${t} ${spec.id}: ok (${templateId})`);
  return { spec, ok: true };
}

// --- Revisions (verify notes, `yagami fix`) ------------------------------------------------

/** An outline-shaped view of an existing spec, so PlanAssembler.check pins its identity. */
function asOutline(spec: DemoSpec): OutlineDemo {
  return {
    id: spec.id,
    title: spec.title,
    component: spec.component,
    idea: spec.brief,
    template: spec.template,
    readouts: spec.readouts.map((r) => ({ id: r.id, label: r.label, measures: "" })),
    beats: spec.beats.map((b) => ({ anchor: b.anchor, focus: "" })),
  };
}

/**
 * One config-fix turn on a template demo: the notes (+ the rendering) go to its conversation,
 * the corrected spec/config is validated and saved via `save` (plan.json by default).
 * Returns the new spec, or null when no valid correction came back.
 */
export async function reviseTemplate(
  c: Ctx,
  spec: DemoSpec,
  notes: string,
  sheet: string | null,
  opts: { save?: (spec: DemoSpec) => void; round?: number } = {},
): Promise<DemoSpec | null> {
  const slug = c.book.slug;
  const unit = c.unit.unit;
  const t = tag(slug, unit);
  emit({ type: "demo", unit, id: spec.id, phase: "revising", round: opts.round, detail: "adjusting the template config" });
  // Config fixes run at fix effort (low). Effort is part of the cached prefix: a saved conversation
  // at another effort is not continued (that would re-bill it uncached) but restarted from the
  // current spec, reading the system prompt from the cache.
  const effort = fixEffort();
  void warmTemplates(c.book, effort);
  const saved = loadConvo(slug, unit, spec.id);
  const convo: Convo = saved && (saved.effort ?? "medium") === effort ? saved : { book: slug, unit, spec, messages: [], effort, kind: "template" };
  if (!convo.messages.length) {
    convo.messages.push({ role: "user", content: `This demo of "${c.book.title}" uses the template "${spec.template}". Its current spec and config:\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`` });
    convo.messages.push({ role: "assistant", content: "Understood." });
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `Problems with the rendered demo:\n\n${notes}\n\nThe current spec and config (they may differ from your last reply):\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`` },
  ];
  if (sheet && fs.existsSync(sheet)) content.push({ type: "text", text: "All beats as rendered:" }, pngBlock(fs.readFileSync(sheet)));
  content.push({ type: "text", text: "Fix the problems by changing the spec and config only (same template, ids and anchors). Reply with the complete corrected JSON in one ```json block." });
  convo.messages.push({ role: "user", content });

  // Reservations: the other demos of the current plan.
  const others = fs.existsSync(paths.plan(slug, unit)) ? loadPlan(slug, unit).demos.filter((d) => d.id !== spec.id) : [];
  const assembler = new PlanAssembler(c.book, unit, { demos: [...others.map(asOutline), asOutline(spec)] }, path.join(paths.verifyDir(slug, unit), ".scratch-plan.json"));
  let out: DemoSpec | null = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const r = await turn(c.book, effort, `revise:${t}:${spec.id}`, convo.messages);
    if (!r) break;
    convo.messages.push({ role: "assistant", content: r.message.content });
    const res = await checkReply(jsonOf(textOf(r.message)), asOutline(spec), spec.template!, assembler);
    if (!res.errors.length && res.spec) out = res.spec;
    else if (attempt === 0) convo.messages.push({ role: "user", content: `Still not valid:\n${res.errors.map((e) => `- ${e}`).join("\n")}\n\nReply with the complete corrected JSON in one \`\`\`json block.` });
  }
  convo.spec = out ?? spec;
  saveConvo(convo);
  if (!out) {
    log(`revise ${t} ${spec.id}: no valid config came back`);
    return null;
  }
  (opts.save ?? ((s: DemoSpec) => saveSpec(slug, unit, s)))(out);
  log(`revise ${t} ${spec.id}: config updated`);
  return out;
}

/** Cache key for a demo's artefact: the component file, or for templates the template + config. */
export function templateArtifact(spec: DemoSpec): string | null {
  return spec.template ? JSON.stringify({ template: spec.template, config: spec.config ?? null }) : null;
}

/** Whether a template demo can skip the model review: every reader-checkable value is pinned by `expect`. */
export function skipsReview(spec: DemoSpec): boolean {
  return !!spec.template && !!spec.expect?.length;
}
