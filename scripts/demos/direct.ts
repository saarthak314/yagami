// Direct planning for short units (YAGAMI_DIRECT=on): no separate outline stage. The unit is
// split into 2–4 groups (sections, or balanced paragraph runs) and each group gets ONE call that
// chooses its demos and, in the same streamed reply, writes each one in full: a template demo's
// spec + config, or a custom demo's spec + component code. Each demo is handed on the moment its
// blocks are complete; from there it takes the usual path (spec checks, typecheck, checks,
// stress audit, review, low-effort fixes) with its reply as the conversation's first answer.

import type Anthropic from "@anthropic-ai/sdk";
import { call, type Effort, prewarm, roleModel, systemCacheControl, textOf } from "../lib/claude";
import type { BookConfig, DemoSpec } from "../../src/types";
import { emit } from "../lib/report";
import { anchorLine, type Ctx, log, tag } from "./common";
import { builderSystem, buildEffort } from "./build";
import { templateSystem, templates } from "./template";
import { domainOf } from "./domains";
import { centralNote, directParts, duplicateOf, fixOutline, type OutlineDemo, outlineCtx, outlineImages, type OutlinePart, type PlanState, SELECTION_RULES, templatesOff, unitNoun, warnCentral } from "./plan";
import { isOcr, plannableAnchors, sanityGate, skipSectionReason, sourceNote, standInPhrase } from "./quality";

/** Output cap per group reply (several demos, each spec + code). */
const DIRECT_MAX_TOKENS = 32000;

/** The direct-mode instructions (stable per domain → cached with the builder and template prompts). */
function directBlock(book: BookConfig, withTemplates: boolean): Anthropic.Beta.BetaTextBlockParam {
  const d = domainOf(book.domain);
  const noun = unitNoun(book);
  const text = `## Direct mode: choose the demos and write them in one reply
You are given one part of a ${noun}: its paragraph anchors (id, page, kind, text${isOcr(book) ? " from OCR — noisy: misread letters and digits, equations unreliable; the page images are authoritative" : " from the PDF's text layer — maths is flattened to plain characters"}) and images of its ${isOcr(book) ? "pages" : "figures and tables"}. Other parts of the same ${noun} are handled in parallel by other calls.

Choose the demos for THIS part — about one per distinct idea worth seeing, never more than the number you are given — and write each one completely before starting the next, in reading order. Good demos let the reader see and manipulate exactly what the text describes, with readouts that check an equation or a quoted number. Prefer one demo with several beats over several thin demos.

${SELECTION_RULES}

${d.planner}

Complexity budget: each demo is ONE idea that fits a compact component (≈200 lines): one scene, at most ~4 controls and 4 readouts, presets that vary parameters of the same scene.

For each demo:
${
    withTemplates
      ? `- If it fits one of the templates above well: ONE \`\`\`json block with the full DemoSpec plus "template", "config" and "expect", exactly as the template section describes. Prefer a template when it truly fits; never force a poor fit — if a template would only be a stand-in, the closest match or an approximation of what the text describes, write a custom demo instead.
- Otherwise: ONE \`\`\`json block with the full DemoSpec (with "expect", without "template"), immediately followed by ONE \`\`\`tsx block with the complete component, exactly as the builder rules describe (the file is src/demos/${book.slug}/<unit>/<component>.tsx).`
      : `- ONE \`\`\`json block with the full DemoSpec (with "expect"), immediately followed by ONE \`\`\`tsx block with the complete component, exactly as the builder rules describe.`
  }
- "id": kebab-case, unique. "component": PascalCase, unique. "title": sentence case, ≤ 48 chars. "brief": one or two sentences in your own words.
- "beats": 2–6, in reading order, anchored ONLY to this part's anchor ids (never a heading); an anchor holds at most one beat. Captions in your own words, specific to that paragraph.
- Numbers: template data, "expect" values and numbers in captions are copied exactly from the text or the table/figure they come from (or follow from them; an expect value computed by a formula gets "why": "<formula and inputs>").

Reply with only these blocks — no other text between or around them.`;
  return { type: "text", text, cache_control: systemCacheControl() };
}

/** The full system prompt: the builder's (unchanged bytes), the templates', then the direct-mode block. */
async function directSystem(book: BookConfig, withTemplates: boolean): Promise<Anthropic.Beta.BetaTextBlockParam[]> {
  return [...builderSystem(book), ...(withTemplates ? await templateSystem() : []), directBlock(book, withTemplates)];
}

const warm = new Map<string, Promise<void>>();

/** Write the direct prompt to the cache once per run (groups then read it instead of each writing it). */
export function warmDirect(book: BookConfig, effort: Effort = buildEffort()): Promise<void> {
  const { model } = roleModel("build");
  const withTemplates = !templatesOff();
  const key = `${model}:${book.domain}:${effort}:${withTemplates}`;
  let p = warm.get(key);
  if (!p) {
    p = (withTemplates ? templates() : Promise.resolve([]))
      .then(async (list) => prewarm({ model, effort, label: `direct-warm:${book.slug}`, system: await directSystem(book, withTemplates && list.length > 0) }))
      .catch((e: Error) => log(`direct-warm ${book.slug}: ${e.message}`));
    warm.set(key, p);
  }
  return p;
}

/**
 * Fenced blocks from a streamed reply, in order, as soon as each one is closed.
 * A json block followed by a tsx block is one custom demo; a json block with a
 * "template" is a template demo on its own.
 */
class BlockStream {
  private buf = "";
  private pos = 0;
  constructor(private readonly onBlock: (lang: string, body: string, raw: string) => void) {}

  push(delta: string) {
    this.buf += delta;
    for (;;) {
      const open = this.buf.indexOf("```", this.pos);
      if (open < 0) return;
      const nl = this.buf.indexOf("\n", open);
      if (nl < 0) return;
      const close = this.buf.indexOf("\n```", nl);
      if (close < 0) return;
      const end = close + 4;
      const lang = this.buf.slice(open + 3, nl).trim().toLowerCase();
      this.pos = end;
      this.onBlock(lang, this.buf.slice(nl + 1, close), this.buf.slice(open, end));
    }
  }
}

export interface DirectOpts {
  /** Called the moment a demo is complete: its outline view and its reply (the prefill for the per-demo step). */
  onDemo: (o: OutlineDemo, prefill: string) => void;
  effort?: Effort;
  ctx?: Ctx;
}

/** Outline view of a written spec (identity, readouts, beats), for the shared registry and progress views. */
function outlineOf(spec: Partial<DemoSpec>, templateIds: Set<string>): OutlineDemo {
  const tpl = typeof spec.template === "string" && spec.template !== "custom" && templateIds.has(spec.template) ? spec.template : undefined;
  return {
    id: String(spec.id ?? ""),
    title: String(spec.title ?? spec.id ?? ""),
    component: String(spec.component ?? ""),
    idea: String(spec.brief ?? ""),
    readouts: (Array.isArray(spec.readouts) ? spec.readouts : []).filter((r) => r && typeof r.id === "string").map((r) => ({ id: r.id, label: String(r.label ?? r.id), measures: "" })),
    beats: (Array.isArray(spec.beats) ? spec.beats : []).filter((b) => b && typeof b.anchor === "string").map((b) => ({ anchor: b.anchor, focus: String(b.caption ?? "").slice(0, 100) })),
    ...(tpl ? { template: tpl } : {}),
  };
}

/**
 * Plan a short unit directly: groups in parallel, each writing its demos in full. Same return
 * shape as planOutline (demos in reading order + the id/component/anchor registry).
 */
export async function planDirect(book: BookConfig, unitId: string, opts: DirectOpts): Promise<{ demos: OutlineDemo[]; state: PlanState }> {
  const c = opts.ctx ?? outlineCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const noun = unitNoun(book);
  const keep = plannableAnchors(c);
  sanityGate(c, keep, `direct ${t}`);
  const parts = directParts(c, keep);
  const totalCap = parts.reduce((n, p) => n + p.cap, 0);
  const sectionTitle = new Map(c.unit.sections.map((s) => [s.id, s.title]));
  const describe = (p: OutlinePart) => {
    const titled = p.sections.map((id) => sectionTitle.get(id)).filter(Boolean);
    if (titled.length) return p.sections.map((id) => `${id} ${sectionTitle.get(id) ?? ""}`.trim()).join("; ");
    // No section titles: the part's first words stand in for its topic.
    const first = p.anchors.find((a) => a.kind === "para");
    return `paragraphs ${p.anchors[0].id}…${p.anchors.at(-1)!.id} ("${(first ? c.text.text[first.id] ?? "" : "").replace(/\s+/g, " ").slice(0, 90)}…")`;
  };
  const sections = c.unit.sections.filter((s) => !skipSectionReason(s)).map((s) => `${s.id} ${s.title} (p.${s.page})`).join("\n");

  const catalog = templatesOff() ? [] : await templates();
  const templateIds = new Set(catalog.map((x) => x.id));
  const system = await directSystem(book, templateIds.size > 0);
  const { model } = roleModel("build");
  const effort = opts.effort ?? buildEffort();
  await warmDirect(book, effort);

  const state: PlanState = { ids: new Set(), components: new Set(), anchors: new Set() };
  const demos: OutlineDemo[] = [];
  log(`direct ${t}: ${parts.length} group(s) (${parts.map((p) => `${p.anchors[0].id}…${p.anchors.at(-1)!.id}, ≤${p.cap}`).join("; ")})`);

  const runGroup = async (part: OutlinePart, i: number) => {
    let count = 0;
    const inPart = new Set(part.anchors.map((a) => a.id));
    const handle = (spec: Partial<DemoSpec>, code?: string) => {
      if (count >= part.cap || demos.length >= totalCap) return log(`direct ${t}: dropped ${spec.id}: over the demo cap`);
      // Beats only on this group's anchors (others belong to the other groups).
      if (Array.isArray(spec.beats)) spec.beats = spec.beats.filter((b) => b && inPart.has(b.anchor));
      const o = outlineOf(spec, templateIds);
      // A template the spec itself calls a stand-in for what the text describes: code it instead
      // (fresh, without this reply as a prefill — it holds a config, not code).
      const standIn = o.template ? standInPhrase(spec.brief) : null;
      if (standIn) {
        log(`direct ${t}: ${o.id}: template ${o.template} would be a stand-in ("${standIn}"); coding it instead`);
        delete o.template;
        o.idea = `${o.idea} (Draw exactly what the text describes — no stand-in.)`;
        code = undefined;
      }
      const before = o.beats.map((b) => b.anchor);
      const errs = fixOutline(o, c, state, templateIds, inPart);
      if (errs.length) return log(`direct ${t}: dropped ${o.id || "(no id)"}: ${errs.join("; ")}`);
      const dup = duplicateOf(o, demos);
      if (dup) return log(`direct ${t}: dropped ${o.id}: same idea as ${dup.id}`);
      // Keep the spec in step with the registry: pinned identity, and beats on the anchors fixOutline kept
      // (moved ones are mapped by position when the count is unchanged).
      const kept = new Set(o.beats.map((b) => b.anchor));
      const beats = Array.isArray(spec.beats) ? spec.beats : [];
      spec.beats = before.length === o.beats.length ? beats.map((b, j) => ({ ...b, anchor: o.beats[j].anchor })) : beats.filter((b) => kept.has(b.anchor));
      if ((spec.beats?.length ?? 0) < 2) return log(`direct ${t}: dropped ${o.id}: fewer than 2 usable beats`);
      o.beats = spec.beats!.map((b) => ({ anchor: b.anchor, focus: String(b.caption ?? "").slice(0, 100) }));
      spec.id = o.id;
      spec.component = o.component;
      spec.title = o.title;
      if (!o.template) delete spec.template;
      state.ids.add(o.id);
      state.components.add(o.component);
      for (const b of o.beats) state.anchors.add(b.anchor);
      demos.push(o);
      count++;
      log(`direct ${t}: + ${o.id} (${o.beats.length} beats, ${o.template ? `template ${o.template}` : code ? "custom" : "custom, no code yet"}, group ${i + 1})`);
      const prefill = standIn ? "" : "```json\n" + JSON.stringify(spec, null, 1) + "\n```" + (code ? `\n\n${code}` : "");
      opts.onDemo(o, prefill);
    };

    let pending: Partial<DemoSpec> | null = null;
    const flush = () => {
      if (pending) handle(pending);
      pending = null;
    };
    const blocks = new BlockStream((lang, body, raw) => {
      if (lang === "json") {
        flush();
        let spec: Partial<DemoSpec>;
        try {
          spec = JSON.parse(body) as Partial<DemoSpec>;
        } catch (e) {
          return log(`direct ${t}: bad spec JSON (${(e as Error).message})`);
        }
        if (typeof spec.template === "string" && spec.template !== "custom") handle(spec);
        else pending = spec;
      } else if (/^(tsx|typescript|ts|jsx)$/.test(lang)) {
        if (pending) {
          const spec = pending;
          pending = null;
          handle(spec, raw);
        }
      }
    });

    const others = parts.filter((_, j) => j !== i).map(describe);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: `${book.title} — unit "${unitId}": ${c.unit.title}.` }];
    content.push(...(await outlineImages(book, unitId, part.pages, part.anchors)));
    content.push({
      type: "text",
      text: `Sections of the whole ${noun}:\n${sections || "(none detected)"}\n\nThis is part ${i + 1} of ${parts.length}${parts.length > 1 ? ` — the other parts (${others.join(" | ")}) get their demos from other calls, in parallel: don't make demos about their ideas` : ""}.\n\nParagraph anchors of this part in reading order (${sourceNote(book).name}):\n\n${part.anchors.map((a) => anchorLine(a, c.text, 600)).join("\n")}\n\nWrite at most ${part.cap} demo${part.cap === 1 ? "" : "s"} for this part (fewer is fine). ${centralNote(c, noun, parts.length > 1)}`,
    });
    const { message } = await call({
      model,
      effort,
      label: `direct:${t}:part${i + 1}`,
      system,
      messages: [{ role: "user", content }],
      maxTokens: DIRECT_MAX_TOKENS,
      onText: (d) => blocks.push(d),
    });
    flush();
    if (!count) log(`direct ${t}: group ${i + 1} produced no usable demo (${textOf(message).length} chars of reply)`);
  };

  const failed: string[] = [];
  await Promise.all(
    parts.map((p, i) =>
      runGroup(p, i).catch((e: Error) => {
        failed.push(`group ${i + 1}: ${e.message}`);
        emit({ type: "log", level: "warn", message: `direct ${t}: group ${i + 1} failed: ${e.message}` });
      }),
    ),
  );
  if (!demos.length) throw new Error(`direct ${t}: no usable demos${failed.length ? ` (${failed.join("; ")})` : ""}`);
  const order = new Map(c.unit.anchors.map((a, i) => [a.id, i]));
  demos.sort((a, b) => order.get(a.beats[0].anchor)! - order.get(b.beats[0].anchor)!);
  warnCentral(c, demos, `direct ${t}`);
  log(`direct ${t}: ${demos.length} demos`);
  return { demos, state };
}
