// Build step: one Sonnet conversation per demo writes
// src/demos/<slug>/<unit>/<Component>.tsx against the demo kit, then a
// typecheck/static-check loop fixes it up. Conversations are saved to
// work/<slug>/demos/<unit>/<id>.json so verify and revise can continue them.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { AbortedError, call, type Effort, fixEffort, pool, prewarm, roleModel, systemCacheControl, textOf } from "../lib/claude";
import type { Anchor, BookConfig, Domain, DemoSpec, Expectation, Params } from "../../src/types";
import { loadBook } from "../books";
import { anchorContext, anchorCrop, type Ctx, loadCtx, loadPlan, log, paths, pngBlock, specSink, tag, writeJson } from "./common";
import { emit } from "../lib/report";
import { domainOf } from "./domains";
import { DEMO_RULES } from "./rules";
import type { OutlineDemo, PlanAssembler } from "./plan";
import { tidyCaption } from "./plan";
import { groundingRequest, isOcr, referencedRegions, type Region, regionCrop, regionsText, sourceNote } from "./quality";

const run = promisify(execFile);

export interface Convo {
  book: string;
  unit: string;
  spec: DemoSpec;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Effort of every builder turn in this conversation (part of the cached prefix; default medium). */
  effort?: Effort;
  /** "template": the demo is a template config (scripts/demos/template.ts), not a component file. */
  kind?: "code" | "template";
}

/** Builder effort (see roleModel: Sonnet 5.5, medium unless YAGAMI_BUILD_EFFORT / YAGAMI_EFFORT say otherwise). */
export function buildEffort(): Effort {
  return roleModel("build").effort;
}

/**
 * The code from a builder reply: the ```tsx block (current format) or, for conversations
 * from before it, a JSON { "code": ... } object.
 */
export function codeOf(text: string): string | null {
  const start = text.search(/```(?:tsx|typescript|ts)\s*\n/);
  if (start >= 0) {
    const body = text.slice(text.indexOf("\n", start) + 1);
    const end = body.lastIndexOf("\n```");
    return (end >= 0 ? body.slice(0, end) : body).trimEnd() + "\n";
  }
  try {
    const v = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { code?: unknown };
    return typeof v.code === "string" ? v.code : null;
  } catch {
    return null;
  }
}

/** Output cap for every builder turn (thinking included): a demo that needs more is too big. */
export const BUILD_MAX_TOKENS = 8000;

const TOO_LONG = "Your reply hit the length limit and was cut off. This demo is too big: write a simpler, more compact version of it (one scene, fewer modes and labels, shared helpers, ≤ ~200 lines), keeping the same ids and readout ids.";

/** One builder turn with the output cap; `null` when the reply was cut off at the cap. */
async function builderTurn(book: BookConfig, effort: Effort, label: string, messages: Anthropic.Beta.BetaMessageParam[], signal?: AbortSignal) {
  try {
    return await call({ model: roleModel("build").model, effort, label, system: systemPrompt(book), messages, maxTokens: BUILD_MAX_TOKENS, signal });
  } catch (e) {
    if (/hit max_tokens/.test((e as Error).message)) return null;
    throw e;
  }
}

/**
 * Apply SEARCH/REPLACE edit blocks to `current`. Returns the new text, `null` when the reply
 * has no edit blocks, or an error naming the first block that doesn't match exactly once.
 */
export function applyEdits(current: string, text: string): { code: string } | { error: string } | null {
  const blocks = [...text.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)];
  if (!blocks.length) return null;
  let code = current;
  for (const [i, m] of blocks.entries()) {
    const [search, replace] = [m[1], m[2]];
    const at = code.indexOf(search);
    if (!search.trim() || at < 0) return { error: `edit block ${i + 1}: its SEARCH text is not in the current file` };
    if (code.indexOf(search, at + 1) >= 0) return { error: `edit block ${i + 1}: its SEARCH text matches more than once` };
    code = code.slice(0, at) + replace + code.slice(at + search.length);
  }
  return { code };
}

const EDIT_HINT = "Reply with edit blocks (SEARCH/REPLACE) for just the lines that change, or the complete file in a ```tsx block if most of it changes.";

const warmed = new Map<string, Promise<void>>();

/** Write the builder's ~30k-token system prompt to the cache once, before parallel first calls. */
export function warmBuilder(book: BookConfig, effort: Effort): Promise<void> {
  // The cache entry belongs to one model + effort + prompt: warm exactly what the builder will send.
  const { model } = roleModel("build");
  const key = `${model}:${book.domain}:${effort}`;
  let p = warmed.get(key);
  if (!p) {
    p = prewarm({ model, effort, label: `build-warm:${book.slug}`, system: systemPrompt(book) });
    warmed.set(key, p);
  }
  return p;
}

// --- System prompt (stable per domain → cached) -------------------------------

const systemCache = new Map<Domain, Anthropic.Beta.BetaTextBlockParam[]>();

/** Allowed import specifiers for a generated demo (src/demos/<slug>/<unit>/X.tsx). */
export const ALLOWED_IMPORTS = ["react", "../../../demo/kit", "../../../types"];

/** The builder's cached system prompt (direct planning puts it first in its own prompt, unchanged). */
export function builderSystem(book: BookConfig): Anthropic.Beta.BetaTextBlockParam[] {
  return systemPrompt(book);
}

function systemPrompt(book: BookConfig): Anthropic.Beta.BetaTextBlockParam[] {
  const cached = systemCache.get(book.domain);
  if (cached) return cached;
  const d = domainOf(book.domain);
  const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");
  const examples = d.references
    .filter((r) => fs.existsSync(`${r.dir}/${r.component}.tsx`))
    .map((r) => {
      const spec = fs.existsSync(`${r.dir}/spec.json`) ? read(`${r.dir}/spec.json`) : "(spec not available)";
      return `This spec:\n\`\`\`json\n${spec}\n\`\`\`\nis implemented by this component (it lives in ${r.dir}/, so its import paths differ from yours):\n\`\`\`tsx\n${read(`${r.dir}/${r.component}.tsx`)}\n\`\`\``;
    });

  const text = `You are a senior engineer writing one ${d.demoNoun} as a React + TypeScript component. It accompanies a text in ${d.subject}: the reader sees the original pages on the right and your demo on the left. A shell around your component already renders the demo title, the current beat's caption, Play/Pause/Restart, the preset picker, all controls and the readout values. You draw only the stage.

## Contract: src/types.ts
\`\`\`ts
${read("src/types.ts")}
\`\`\`

## Demo kit: src/demo/kit.tsx (the only drawing API you may use)
\`\`\`tsx
${read("src/demo/kit.tsx")}
\`\`\`
${examples.length ? `\n## Worked example${examples.length > 1 ? "s" : ""}\n${examples.join("\n\n")}\n` : ""}
## Robustness
${DEMO_RULES}

## Rules
- The file is src/demos/<book>/<unit>/<Component>.tsx. Default-export a function component named <Component> that takes \`DemoProps\`.
- Import only from "react", "../../../demo/kit" and "../../../types" (type-only imports from types: \`import type { DemoProps } from "../../../types"\`). No other modules, no assets, no fetch, no DOM APIs beyond what Stage gives you.
- Render exactly one \`<Stage width={width} height={height} playing={playing} resetKey={resetKey} onFrame={...} />\` (optionally with pointer handlers). Do not render HTML controls, titles, captions or readout text — the shell does that. Small in-canvas labels (symbols, point names, axis labels, token words, short annotations) are good.
- Keep simulation state in \`useSim(() => init, [resetKey, preset, ...params that require a restart])\`; advance it by \`dt\` inside onFrame, then draw. Params that do not need a restart (e.g. speed, toggles for overlays) should take effect live.
- When \`playing\` is false (dt = 0), keep drawing the current state so the stage is never blank. The initial frame should already show the scene clearly.
- Call \`setReadouts\` from onFrame every frame with a value for every readout id in the spec (numbers or strings; use \`fmt\` for numbers). It is throttled by the shell.
- Read params with safe defaults and type narrowing, e.g. \`const n = Number(params.steps ?? 10)\`, \`const show = Boolean(params.trails)\`, \`const mode = String(params.path ?? "a")\`.
- Layout: compute positions from width and height (the stage is roughly 480–800 px wide and 280–600 px tall). Keep ≥ 24 px margins. Nothing may be clipped at the edges and no two labels may overlap. Choose ranges so everything stays on screen for every preset and slider value (clamp or wrap if needed).
- The verifier renders every beat and measures every \`draw.text\` box automatically: text must lie fully inside the stage and no two text boxes may overlap. Put legends and axis titles in their own row or column outside the plot area, keep tick labels sparse enough not to touch, and shorten labels rather than letting them collide. Readouts must show real values within ~1 s of loading (never NaN, undefined, Infinity or an empty string).
- Expected values: if the spec has \`expect\`, then at beat \`beat\` (that beat's preset with its params applied) the readout \`readout\` must show \`value\` (relative tolerance \`tol\`, default 2 %) once the stage has run ~1 s; the verifier parses the first number in the readout text. Compute such readouts from the params directly (closed form), not only at the end of a long animation.
- Style: minimal, on the dark stage (the canvas is transparent over #0a0a0a; don't paint a background). Use theme.fg for main objects, theme.muted for secondary lines, theme.faint or theme.grid for guides, and theme.accent (sparingly) for the one quantity the demo is about; theme.accent2 only for a contrasting second quantity. Symbols with \`draw.text(..., { kind: "symbol" })\`, annotations with kind "label", numbers with kind "mono". No gradients, glows, emoji or decoration. Any source code shown on the stage goes through \`draw.code\`, never plain draw.text. The reader has light and dark site themes and \`theme\` follows them: use only theme.* colours, \`sequential\`/\`diverging\` ramps and \`contrastText(fill)\` for text on filled cells; never write hex or rgb() colour literals, and read theme values at draw time (not in module-level constants).
${d.builder}
- Correctness: equations, units, signs and directions must match the spec and the text. Readouts must be computed from the same state that is drawn.
- Compact: one idea, aim for ≤ ~200 lines. Put shared drawing in small helper functions instead of repeating blocks per preset or mode; no dead code, no long comments.
- Deterministic: no Math.random (use the kit's seeded \`rng\`), no Date.
- TypeScript strict mode with noUnusedLocals and noUnusedParameters: no unused variables, parameters or imports; no \`any\`.
- Unless a request says otherwise, reply with only one \`\`\`tsx fenced block containing the complete file.
- When asked to fix or change a file you already wrote, reply with edit blocks instead of the whole file (several are fine), each SEARCH copied exactly from the current file and matching it once:
\`\`\`edit
<<<<<<< SEARCH
(exact lines from the current file)
=======
(their replacement)
>>>>>>> REPLACE
\`\`\`
Only when most of the file changes, reply with the complete file in a \`\`\`tsx block instead.

## When you are given an outline item instead of a spec
Then you write the full DemoSpec yourself and implement it in the same reply:
- id, component, title: exactly as in the outline. readouts: the outline's readout ids (labels may use $LaTeX$). Give a readout "range": [min, max] when its value has physical or mathematical bounds (errors, distances and counts ≥ 0, probabilities in [0, 1]); null for an open side, e.g. [0, null].
- brief: one or two sentences in your own words saying what the demo shows (kept as context for later fixes; the code is the real spec).
- controls: at most 6 (sliders with sensible min/max/step/unit, toggles, selects); no play/pause/restart or preset picker (the shell has them).
- presets: at least one; each gives a value for every control id (extra fixed params are fine).
- beats: exactly the outline's anchors, in the same order; each sets a preset plus optional param overrides matching the numbers in that paragraph ("text values"); caption: one or two plain sentences (≤ 260 chars) in your own words telling the reader what to look at; $LaTeX$ for symbols with sub/superscripts; no hype, no exclamation marks, no mention of AI. Never copy sentences from the text.
- expect: readout values the text pins down unambiguously at a beat (a quoted number, or a formula from the text evaluated at that beat's numbers), as { "anchor", "readout", "value", "tol"?, "why"? }. A quoted number is copied exactly as printed (from the paragraph or the referenced table/figure — read the whole table); a computed one gets "why": "<formula and inputs>". Omit anything the text doesn't determine. An empty list is fine.
- Numbers you present as the text's (data arrays, captions, expect) must be printed in the text or the referenced table/figure, or follow from them; never invent or misremember them.
Reply with exactly two fenced blocks and nothing else: first \`\`\`json with the DemoSpec (including "expect"), then \`\`\`tsx with the complete file.`;

  // 1-hour TTL: runs within an hour share this ~30k-token prefix (see systemCacheControl).
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text, cache_control: systemCacheControl() }];
  systemCache.set(book.domain, blocks);
  return blocks;
}

// --- Inputs ----------------------------------------------------------------

/**
 * Page crops for the demo: the whole referenced figures/tables (`regions`, high resolution), every
 * beat's anchor region, plus any figure/table anchor whose text names a figure the brief mentions
 * ("Fig. 13-3", "Figure 2", "Table 1"). Dark on light.
 */
export async function bookImages(c: Ctx, spec: Pick<DemoSpec, "brief" | "beats">, regions: Region[] = []): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  // Whole referenced figures/tables first, at high resolution (their text lines go into the message).
  for (const r of regions) {
    const buf = (await regionCrop(c, r.anchor)) ?? (await anchorCrop(c, r.anchor));
    if (buf) out.push({ type: "text", text: `${r.label}, the whole region (page ${r.anchor.page}):` }, pngBlock(buf));
  }
  // Figure numbers the brief names: "Fig. 13-3", "Figure 2", "Table 1".
  const figs = new Set([...spec.brief.matchAll(/\b(Fig(?:ure|s?\.)?|Table)\s*(\d+(?:[-–.]\d+)?)/g)].map((m) => `${m[1].startsWith("T") ? "Table" : "Fig"} ${m[2].replace("–", "-")}`));
  const wanted: { anchor: Anchor; why: string }[] = [];
  for (const a of c.unit.anchors) {
    if (a.kind !== "figure" && a.kind !== "table") continue;
    const t = c.text.text[a.id] ?? "";
    const n = [...figs].find((f) => {
      const [kind, num] = f.split(" ");
      const head = kind === "Table" ? "Table" : "Fig(?:ure|\\.)?";
      return new RegExp(`${head}\\s*${num.replace(/[-.]/, "[-–—.]\\s*")}\\b`).test(t);
    });
    if (n) wanted.push({ anchor: a, why: `The text's ${n.replace("Fig", "figure")}` });
  }
  for (const b of spec.beats) {
    const a = c.unit.anchors.find((x) => x.id === b.anchor);
    if (a && !wanted.some((w) => w.anchor.id === a.id)) wanted.push({ anchor: a, why: `Anchored region for ${a.id}` });
  }
  const shown = new Set(regions.map((r) => r.anchor.id));
  for (const w of wanted.filter((x) => !shown.has(x.anchor.id)).slice(0, Math.max(2, 8 - regions.length))) {
    const buf = await anchorCrop(c, w.anchor);
    if (!buf) continue;
    out.push({ type: "text", text: `${w.why} (page ${w.anchor.page}):` }, pngBlock(buf));
  }
  return out;
}

/** Figures/tables a demo refers to (named in its idea, beats, captions, brief or beat paragraphs), whole. */
export function demoRegions(c: Ctx, texts: string[], anchors: string[]): Region[] {
  try {
    return referencedRegions(c, texts, anchors);
  } catch (e) {
    log(`build ${tag(c.book.slug, c.unit.unit)}: referenced regions unavailable (${(e as Error).message})`);
    return [];
  }
}

/** Prompt text for whole referenced regions ("" when none). */
export function regionsBlock(regions: Region[]): string {
  return regions.length ? `\n\nReferenced tables/figures — read values from these whole regions, not from memory:\n\n${regionsText(regions)}` : "";
}

function firstMessage(c: Ctx, spec: DemoSpec, images: Anthropic.Beta.BetaContentBlockParam[], regions: Region[] = []) {
  const beats = spec.beats
    .map((b, i) => `Beat ${i} (preset "${b.preset}"${b.params ? `, params ${JSON.stringify(b.params)}` : ""}) — caption: ${b.caption}\n${anchorContext(c, b.anchor)}`)
    .join("\n\n");
  const src = sourceNote(c.book);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `Write src/demos/${c.book.slug}/${c.unit.unit}/${spec.component}.tsx for this demo spec (from "${c.book.title}"):\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nThe beats and the paragraphs they are anchored to (">>>" marks the anchor; ${src.name}. ${src.caveat} The page crops below are authoritative):\n\n${beats}${regionsBlock(regions)}`,
    },
    ...images,
  ];
  if (images.length) content.push({ type: "text", text: "Where the spec re-draws a figure from the text, match its geometry and labelling, but in the dark theme." });
  return { role: "user" as const, content };
}

// --- Checks ------------------------------------------------------------------

export function staticProblems(code: string, spec: DemoSpec): string[] {
  const errs: string[] = [];
  for (const m of code.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
    if (!ALLOWED_IMPORTS.includes(m[1])) errs.push(`forbidden import "${m[1]}" — only ${ALLOWED_IMPORTS.map((s) => `"${s}"`).join(", ")} are allowed`);
  }
  if (/import\s*\(/.test(code)) errs.push("dynamic import() is not allowed");
  if (!/export\s+default\s+function\s+\w+/.test(code)) errs.push(`must have \`export default function ${spec.component}(props: DemoProps)\``);
  if (!/<Stage\b/.test(code)) errs.push("must render the kit <Stage>");
  if (!/setReadouts\s*\(/.test(code)) errs.push("must call setReadouts");
  for (const r of spec.readouts) {
    if (!new RegExp(`["'\`]?\\b${r.id.replace(/[-]/g, "\\-")}\\b["'\`]?\\s*:`).test(code)) errs.push(`setReadouts must include readout id "${r.id}"`);
  }
  if (/Math\.random\s*\(/.test(code)) errs.push("Math.random is not allowed (must be deterministic)");
  if (/document\.|<(input|button|select|div|span|p)\b/.test(code)) errs.push("no DOM elements or document access — draw only on the Stage");
  return errs;
}

export async function typecheck(slug: string, unit: string, file: string): Promise<string[]> {
  const root = path.resolve(".");
  const cfg = path.join(paths.tscDir(slug), `${unit}-${path.basename(file, ".tsx")}.json`);
  writeJson(cfg, {
    extends: path.join(root, "tsconfig.app.json"),
    compilerOptions: { noEmit: true, tsBuildInfoFile: null, incremental: false },
    files: [file],
    include: [],
  });
  try {
    await run(path.join(root, "node_modules/.bin/tsc"), ["-p", cfg, "--noEmit", "--pretty", "false"], { cwd: root, maxBuffer: 1 << 24 });
    return [];
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`.trim();
    return out ? out.split("\n").filter((l) => l.trim()).slice(0, 40) : [`tsc failed: ${(e as Error).message}`];
  }
}

// --- Conversation loop ----------------------------------------------------------

const FENCE = "```";

/**
 * Fix turns run at fix effort (low). Effort is part of the cached prefix, so switching it inside a
 * conversation would re-bill the whole conversation uncached; instead a conversation that isn't
 * at fix effort is replaced, in place, by a fresh one that carries what a fix needs — the spec,
 * the file as it stands and the request — and reads the system prompt from the cache.
 * Conversations already at fix effort (e.g. a low-effort race candidate) just continue.
 */
export function toFixTurn(convo: Convo, request: string | Anthropic.Beta.BetaContentBlockParam[]): void {
  const effort = fixEffort();
  const asBlocks = (r: string | Anthropic.Beta.BetaContentBlockParam[]): Anthropic.Beta.BetaContentBlockParam[] => (typeof r === "string" ? [{ type: "text", text: r }] : r);
  if ((convo.effort ?? "medium") === effort) {
    convo.messages.push({ role: "user", content: request });
    return;
  }
  const file = paths.component(convo.book, convo.unit, convo.spec.component);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  convo.messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `You wrote src/demos/${convo.book}/${convo.unit.replace(/~.*$/, "")}/${convo.spec.component}.tsx for this demo spec:\n\n${FENCE}json\n${JSON.stringify(convo.spec, null, 2)}\n${FENCE}\n\nThe file as it currently stands (its import paths are the correct ones):\n${FENCE}tsx\n${current}\n${FENCE}`,
        },
        ...asBlocks(request),
      ],
    },
  ];
  convo.effort = effort;
}

export function saveConvo(c: Convo) {
  writeJson(paths.convo(c.book, c.unit, c.spec.id), c);
}

export function loadConvo(slug: string, unit: string, id: string): Convo | null {
  const f = paths.convo(slug, unit, id);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Convo) : null;
}

/**
 * A fix reply may correct the spec instead of (or as well as) the code: a fenced ```json block with
 * `"expect": [...]` (the full corrected list, entries `{ beat | anchor, readout, value, tol? }`) when
 * the text supports the readout rather than the expected value, and/or `"beats": [...]` (one entry per
 * beat, in order: `{ caption?, preset?, params? }`) when a caption claims what the stage doesn't show
 * or a beat should start from another preset/params, and/or `"drop": ["<control id>"]` for controls
 * the demo doesn't need. Applied to the convo spec and plan.json.
 * Returns true when a valid patch was applied.
 */
export function applySpecPatch(convo: Convo, text: string): boolean {
  const m = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((x) => x[1]).find((b) => /"(expect|beats|drop)"\s*:/.test(b));
  if (!m) return false;
  let patch: { expect?: unknown; beats?: unknown; drop?: unknown };
  try {
    patch = JSON.parse(m) as { expect?: unknown; beats?: unknown; drop?: unknown };
  } catch {
    return false;
  }
  const spec = convo.spec;
  const what: string[] = [];
  if (Array.isArray(patch.expect)) {
    const readouts = new Set(spec.readouts.map((r) => r.id));
    const out: Expectation[] = [];
    for (const e of patch.expect as { beat?: unknown; anchor?: unknown; readout?: unknown; value?: unknown; tol?: unknown }[]) {
      if (!e || typeof e !== "object") continue;
      const beat = typeof e.anchor === "string" ? spec.beats.findIndex((b) => b.anchor === e.anchor) : typeof e.beat === "number" && Number.isInteger(e.beat) && e.beat >= 0 && e.beat < spec.beats.length ? e.beat : -1;
      const value = typeof e.value === "number" ? e.value : typeof e.value === "string" ? Number(e.value.replace(/[,\s]/g, "")) : NaN;
      if (beat < 0 || typeof e.readout !== "string" || !readouts.has(e.readout) || !Number.isFinite(value)) continue;
      const tol = typeof e.tol === "number" && e.tol >= 0 && e.tol <= 1 ? e.tol : undefined;
      out.push({ beat, readout: e.readout, value, ...(tol !== undefined ? { tol } : {}) });
    }
    if (out.length) spec.expect = out;
    else delete spec.expect;
    what.push(`expectations (${out.length})`);
  }
  if (Array.isArray(patch.beats) && patch.beats.length === spec.beats.length) {
    const presets = new Set(spec.presets.map((p) => p.id));
    const keys = new Set([...spec.controls.map((c) => c.id), ...spec.presets.flatMap((p) => Object.keys(p.params))]);
    let n = 0;
    spec.beats = spec.beats.map((b, i) => {
      const e = (patch.beats as unknown[])[i] as { caption?: unknown; preset?: unknown; params?: unknown } | null;
      if (!e || typeof e !== "object") return b;
      const next = { ...b };
      if (typeof e.caption === "string" && e.caption.trim() && e.caption.trim() !== b.caption) next.caption = tidyCaption(e.caption.trim()).slice(0, 300);
      if (typeof e.preset === "string" && presets.has(e.preset)) next.preset = e.preset;
      if (e.params && typeof e.params === "object" && !Array.isArray(e.params)) {
        const ps = Object.entries(e.params as Record<string, unknown>).filter(([k, v]) => keys.has(k) && (typeof v === "number" || typeof v === "boolean" || typeof v === "string"));
        if (ps.length) next.params = Object.fromEntries(ps) as Params;
        else delete next.params;
      }
      if (JSON.stringify(next) !== JSON.stringify(b)) n++;
      return next;
    });
    what.push(`beats (${n} changed)`);
  }
  if (Array.isArray(patch.drop)) {
    // Controls the demo doesn't need (the checks found they change nothing): removed with their values.
    const drop = new Set((patch.drop as unknown[]).filter((x): x is string => typeof x === "string" && spec.controls.some((c) => c.id === x)));
    if (drop.size) {
      const keep = (ps: Params) => Object.fromEntries(Object.entries(ps).filter(([k]) => !drop.has(k)));
      spec.controls = spec.controls.filter((c) => !drop.has(c.id));
      spec.presets = spec.presets.map((pr) => ({ ...pr, params: keep(pr.params) }));
      spec.beats = spec.beats.map((b) => (b.params ? { ...b, params: keep(b.params) } : b));
      what.push(`dropped ${[...drop].join(", ")}`);
    }
  }
  if (!what.length) return false;
  saveSpec(convo.book, convo.unit, spec);
  log(`build ${tag(convo.book, convo.unit)} ${spec.id}: spec corrected: ${what.join(", ")}`);
  return true;
}

/** Replace one demo's spec in plan.json. */
export function saveSpec(slug: string, unit: string, spec: DemoSpec) {
  const sink = specSink(slug, unit);
  if (sink) return sink(spec);
  const file = paths.plan(slug, unit);
  if (!fs.existsSync(file)) return;
  const plan = loadPlan(slug, unit);
  plan.demos = plan.demos.map((d) => (d.id === spec.id ? spec : d));
  writeJson(file, plan);
}

/**
 * Send the conversation as it stands, write the returned code, then fix up
 * type/static errors for up to `rounds` extra turns. Returns true if clean.
 */
export interface ConvoOpts {
  /** Abort the conversation's model calls (a race lost). */
  signal?: AbortSignal;
  /** Don't emit progress events (race candidates; the race reports for them). */
  quiet?: boolean;
}

export async function runConvo(
  convo: Convo,
  rounds = 4,
  phase: "building" | "revising" | "fixing" = "building",
  outerRound?: number,
  opts: ConvoOpts = {},
): Promise<boolean> {
  const { spec } = convo;
  const book = loadBook(convo.book);
  const t = tag(convo.book, convo.unit);
  const file = paths.component(convo.book, convo.unit, spec.component);
  const ev = (p: "building" | "revising" | "typecheck" | "fixing", detail?: string) =>
    opts.quiet || emit({ type: "demo", unit: convo.unit, id: spec.id, phase: p, round: outerRound, detail });
  // A change to an existing file (fix or revise): let the model send only the edits.
  const editing = phase !== "building" || convo.messages.some((m) => m.role === "assistant");
  if (editing) hintEdits(convo);
  let simplified = false;
  for (let round = 0; round <= rounds; round++) {
    ev(round === 0 ? phase : "fixing", round === 0 ? undefined : `typecheck round ${round}`);
    // Plain text replies (```tsx block or edit blocks): no structured-output format, so every
    // turn shares the cached prefix with the first one.
    const reply = await builderTurn(book, convo.effort ?? "medium", `build:${t}:${spec.id}`, convo.messages, opts.signal);
    if (!reply) {
      log(`build ${t} ${spec.id}: reply hit the ${BUILD_MAX_TOKENS}-token cap (round ${round})`);
      if (simplified || round === rounds) break;
      simplified = true;
      convo.messages.push({ role: "user", content: `${TOO_LONG} Reply with the complete file as one \`\`\`tsx block.` });
      continue;
    }
    const { message, text } = reply;
    convo.messages.push({ role: "assistant", content: message.content });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const patched = editing && applySpecPatch(convo, text);
    const edited = current ? applyEdits(current, text) : null;
    const code = edited && "code" in edited ? edited.code : codeOf(text);
    if (code === null && patched && current) {
      // Only the spec was wrong (expectations, captions or beat setups): the file stays as it is.
      saveConvo(convo);
      return true;
    }
    if (code === null) {
      const why = edited && "error" in edited ? edited.error : "the reply had no code";
      log(`build ${t} ${spec.id}: ${why} (round ${round})`);
      saveConvo(convo);
      if (round === rounds) break;
      convo.messages.push({ role: "user", content: `${why}. Reply with the complete file as one \`\`\`tsx fenced block.` });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code.endsWith("\n") ? code : code + "\n");
    saveConvo(convo);

    ev("typecheck");
    const problems = [...staticProblems(code, spec), ...(await typecheck(convo.book, convo.unit, file))];
    if (problems.length === 0) {
      log(`build ${t} ${spec.id}: ok (round ${round})`);
      return true;
    }
    log(`build ${t} ${spec.id}: ${problems.length} problems (round ${round})`);
    if (round === rounds) break;
    toFixTurn(convo, `The file has these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nFix them. ${EDIT_HINT}`);
  }
  saveConvo(convo);
  return false;
}

/** Ask for edits on the pending (last, user) message, whoever wrote it, unless it already says how to reply. */
function hintEdits(convo: Convo) {
  const last = convo.messages[convo.messages.length - 1];
  if (!last || last.role !== "user") return;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  if (blocks.some((b) => b.type === "text" && /SEARCH\/REPLACE/.test(b.text))) return;
  // Requests written for whole-file replies (JSON or ```tsx) get the edit option added.
  blocks.push({ type: "text", text: EDIT_HINT });
  last.content = blocks;
}

export interface BuildOpts extends ConvoOpts {
  /** Builder effort for the first reply (default buildEffort()). */
  effort?: Effort;
}

export async function buildDemo(c: Ctx, spec: DemoSpec, opts: BuildOpts = {}): Promise<boolean> {
  const effort = opts.effort ?? buildEffort();
  await warmBuilder(c.book, effort);
  const regions = demoRegions(c, [spec.brief, ...spec.beats.map((b) => b.caption)], spec.beats.map((b) => b.anchor));
  const convo: Convo = { book: c.book.slug, unit: c.unit.unit, spec, effort, messages: [firstMessage(c, spec, await bookImages(c, spec, regions), regions)] };
  return runConvo(convo, 4, "building", undefined, opts);
}

// --- Outline item → spec + code in one conversation ---------------------------------------

/** The two fenced blocks of a combined reply. */
function splitReply(text: string): { spec?: unknown; code?: string } {
  const out: { spec?: unknown; code?: string } = {};
  const j = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (j) {
    try {
      out.spec = JSON.parse(j[1]);
    } catch {
      /* reported by the caller */
    }
  }
  if (/```(?:tsx|typescript|ts)\s*\n/.test(text)) out.code = codeOf(text) ?? undefined;
  return out;
}

function outlineMessage(c: Ctx, o: OutlineDemo, others: OutlineDemo[], images: Anthropic.Beta.BetaContentBlockParam[], regions: Region[] = []): Anthropic.Beta.BetaMessageParam {
  const src = sourceNote(c.book);
  const beats = o.beats.map((b, i) => `Beat ${i} at ${b.anchor} — ${b.focus}\n${anchorContext(c, b.anchor, 1, 1)}`).join("\n\n");
  const rest = others.filter((x) => x.id !== o.id).map((x) => `- ${x.title}: ${x.idea}`).join("\n");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Write the spec and src/demos/${c.book.slug}/${c.unit.unit}/${o.component}.tsx for this outline item from "${c.book.title}":\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\n\nOther demos for this ${c.book.units.length === 1 && c.book.source.kind === "text" ? "paper" : "chapter"} (don't duplicate them):\n${rest || "(none)"}\n\nThe beats and the paragraphs they are anchored to (">>>" marks the anchor; ${src.name}. ${src.caveat} The page crops below are authoritative):\n\n${beats}${regionsBlock(regions)}`,
      },
      ...images,
      ...(images.length ? [{ type: "text" as const, text: "Where the demo re-draws a figure from the text, match its geometry and labelling, but in the reader's theme." }] : []),
    ],
  };
}

export { AbortedError };

export interface Generated {
  /** The accepted spec (written into plan.json), when one came out. */
  spec?: DemoSpec;
  /** The code exists and passes the static checks and the typecheck. */
  ok: boolean;
  why?: string;
}

/**
 * One Sonnet conversation turns an outline item into the full DemoSpec and its component.
 * The spec goes through the planner's local fixes (one focused repair turn if needed) and
 * into plan.json; the code then goes through the usual static-check + typecheck loop.
 */
export interface GenerateOpts extends BuildOpts {
  /** false: validate the spec but don't put it into plan.json (a race candidate; the winner is accepted later). */
  accept?: boolean;
  /**
   * The first reply, already written (direct planning writes spec + code for several demos in one
   * call): used instead of asking the model, as if it were the conversation's first answer.
   */
  prefill?: string;
}

export async function generateDemo(c: Ctx, o: OutlineDemo, plan: PlanAssembler, others: OutlineDemo[], gopts: GenerateOpts = {}): Promise<Generated> {
  const book = c.book;
  const t = tag(book.slug, c.unit.unit);
  const ev = (phase: "building" | "typecheck" | "fixing", detail?: string) => gopts.quiet || emit({ type: "demo", unit: c.unit.unit, id: o.id, phase, detail });
  ev("building");
  const regions = demoRegions(c, [o.idea, ...o.beats.map((b) => b.focus)], o.beats.map((b) => b.anchor));
  const images = await bookImages(c, { brief: `${o.idea} ${o.beats.map((b) => b.focus).join(" ")}`, beats: o.beats.map((b) => ({ anchor: b.anchor, preset: "", caption: "" })) }, regions);
  const messages: Anthropic.Beta.BetaMessageParam[] = [outlineMessage(c, o, others, images, regions)];
  const effort = gopts.effort ?? buildEffort();
  let simplified = false;
  let turnEffort = effort;
  const ask = async (label: string): Promise<{ spec?: unknown; code?: string }> => {
    // Warm only when a real turn is needed (a prefilled first reply may need none).
    await warmBuilder(book, turnEffort);
    const r = await builderTurn(book, turnEffort, `${label}:${t}:${o.id}`, messages, gopts.signal);
    if (!r) {
      // Too big: ask once for a smaller version instead of continuing a giant reply. Measured: a capped
      // medium-effort reply is usually all thinking, and the retry thinks the budget away again — so the
      // simpler version is asked for at the (low) fix effort, whose builder prompt is already warm.
      if (simplified) return {};
      simplified = true;
      turnEffort = fixEffort();
      log(`build ${t} ${o.id}: reply hit the ${BUILD_MAX_TOKENS}-token cap; asking for a simpler version`);
      messages.push({ role: "user", content: `${TOO_LONG} Reply again with both blocks (\`\`\`json spec, then \`\`\`tsx file).` });
      return ask(label);
    }
    messages.push({ role: "assistant", content: r.message.content });
    return splitReply(textOf(r.message));
  };

  let reply: { spec?: unknown; code?: string };
  if (gopts.prefill) {
    messages.push({ role: "assistant", content: gopts.prefill });
    reply = splitReply(gopts.prefill);
  } else reply = await ask("build");
  if (reply.spec === undefined || !reply.code) {
    messages.push({ role: "user", content: "Reply with exactly two fenced blocks: ```json with the DemoSpec, then ```tsx with the complete file." });
    reply = await ask("build");
    if (reply.spec === undefined || !reply.code) return { ok: false, why: "the reply had no spec or no code" };
  }
  const code = reply.code;
  let checked = plan.check(reply.spec, o);
  // Ungrounded numbers get one correction request (with any spec errors); they never reject a spec.
  const ungrounded = checked.spec ? plan.ground(checked.spec, o, checked.derived) : [];
  if (checked.errors.length || ungrounded.length) {
    log(`build ${t} ${o.id}: spec needs ${checked.errors.length + ungrounded.length} correction(s)${ungrounded.length ? ` (${ungrounded.length} ungrounded number(s))` : ""}`);
    const asks = [
      ...(checked.errors.length ? [`The spec needs corrections before it can be used:\n${checked.errors.map((e) => `- ${e}`).join("\n")}`] : []),
      ...(ungrounded.length ? [groundingRequest(ungrounded, isOcr(book))] : []),
    ];
    messages.push({
      role: "user",
      content: `${asks.join("\n\n")}\n\nReply with only the corrected spec as one \`\`\`json block (same shape, with "expect"). Keep ids, control ids and readout ids unless a correction requires changing them.${ungrounded.length ? " If a corrected number is also in the code, say so in one line after the block; the file is fixed separately." : ""}`,
    });
    const original = checked;
    const fixed = await ask("build");
    checked = fixed.spec === undefined ? { errors: ["the corrected spec was missing"] } : plan.check(fixed.spec, o);
    // A grounding-only correction that broke the spec: keep the original (valid) spec.
    if ((checked.errors.length || !checked.spec) && !original.errors.length && original.spec) {
      log(`build ${t} ${o.id}: grounding correction unusable (${checked.errors[0] ?? "invalid"}); keeping the first spec`);
      checked = original;
    }
    if (checked.errors.length || !checked.spec) {
      log(`build ${t} ${o.id}: spec rejected: ${checked.errors.join("; ")}`);
      return { ok: false, why: `spec rejected: ${checked.errors[0] ?? "invalid"}` };
    }
    const still = ungrounded.length ? plan.ground(checked.spec, o, checked.derived) : [];
    if (still.length) log(`build ${t} ${o.id}: ${still.length} number(s) still ungrounded after one correction (kept): ${still[0]}`);
  }
  const spec = checked.spec!;
  if (gopts.accept !== false) plan.accept(spec);

  const file = paths.component(book.slug, c.unit.unit, spec.component);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
  const convo: Convo = { book: book.slug, unit: c.unit.unit, spec, messages, effort };
  saveConvo(convo);
  ev("typecheck");
  const problems = [...staticProblems(code, spec), ...(await typecheck(book.slug, c.unit.unit, file))];
  if (!problems.length) {
    log(`build ${t} ${spec.id}: ok (spec + code in one reply)`);
    return { spec, ok: true };
  }
  log(`build ${t} ${spec.id}: ${problems.length} problems after the first reply`);
  toFixTurn(convo, `The file has these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nFix them. ${EDIT_HINT}`);
  const ok = await runConvo(convo, 3, "fixing", undefined, gopts);
  return { spec, ok, why: ok ? undefined : "build failed (typecheck)" };
}

export async function buildUnit(book: BookConfig, unitId: string, opts: { only?: string[]; concurrency?: number } = {}) {
  const c = loadCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const plan = loadPlan(book.slug, unitId);
  // Template demos have no component to build (their config is the artefact).
  const demos = plan.demos.filter((d) => !d.template && (!opts.only?.length || opts.only.includes(d.id)));
  log(`build ${t}: ${demos.length} demos`);
  const results = await pool(demos, opts.concurrency ?? 4, async (spec) => {
    try {
      return { id: spec.id, ok: await buildDemo(c, spec) };
    } catch (e) {
      log(`build ${t} ${spec.id}: error ${(e as Error).message}`);
      return { id: spec.id, ok: false };
    }
  });
  for (const r of results) log(`  ${r.ok ? "ok  " : "FAIL"} ${r.id}`);
  return results;
}

/**
 * Coordinator feedback: append a note (plus the latest verify screenshots and
 * the file as it currently stands on disk) to the demo's build conversation,
 * then rebuild through the usual typecheck loop.
 */
export async function reviseDemo(book: BookConfig, unitId: string, id: string, note: string): Promise<boolean> {
  const t = tag(book.slug, unitId);
  const plan = loadPlan(book.slug, unitId);
  const spec = plan.demos.find((d) => d.id === id);
  if (!spec) throw new Error(`${t}: no demo "${id}" in plan`);
  if (spec.template) throw new Error(`${t}: "${id}" is a template demo — revise its config (template.ts reviseTemplate)`);
  const convo = loadConvo(book.slug, unitId, id);
  if (!convo) throw new Error(`${t}: no build conversation for "${id}" — run build first`);
  const file = paths.component(book.slug, unitId, spec.component);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const specChanged = JSON.stringify(convo.spec) !== JSON.stringify(spec);
  convo.spec = spec;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `Review notes from the project lead (they looked at the rendered demo themselves):\n\n${note}${
        specChanged ? `\n\nThe spec has been updated; this is the current version:\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`` : ""
      }\n\nThis is the file as it currently stands on disk (it may differ from your last reply; its import paths are the correct ones):\n\`\`\`tsx\n${current}\n\`\`\`\n\nThe latest rendering follows.`,
    },
  ];
  const dir = paths.verifyDir(book.slug, unitId);
  // The newest rendering: the checked verifier's contact sheet, or the older per-beat screenshots.
  const sheet = path.join(dir, `${id}-sheet.png`);
  const mtime = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : -1);
  const perBeat = spec.beats.slice(0, 6).map((_, i) => path.join(dir, `${id}-${i}-b.png`));
  if (mtime(sheet) >= Math.max(-1, ...perBeat.map(mtime)) && mtime(sheet) > 0) content.push({ type: "text", text: "All beats as last rendered:" }, pngBlock(fs.readFileSync(sheet)));
  else
    perBeat.forEach((shot, i) => {
      if (fs.existsSync(shot)) content.push({ type: "text", text: `Beat ${i} (${spec.beats[i].preset}):` }, pngBlock(fs.readFileSync(shot)));
    });
  content.push({ type: "text", text: "Address every note, keep everything that already works, and reply with the complete corrected file as one ```tsx block." });
  toFixTurn(convo, content);
  log(`revise ${t} ${id}`);
  return runConvo(convo, 3, "revising");
}
