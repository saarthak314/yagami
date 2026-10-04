// Build step: one Sonnet conversation per demo writes
// src/demos/<slug>/<unit>/<Component>.tsx against the demo kit, then a
// typecheck/static-check loop fixes it up. Conversations are saved to
// work/<slug>/demos/<unit>/<id>.json so verify and revise can continue them.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { callJson, MODELS, pool } from "../lib/claude";
import type { Anchor, BookConfig, Domain, DemoSpec } from "../../src/types";
import { loadBook } from "../books";
import { anchorContext, anchorCrop, type Ctx, loadCtx, loadPlan, log, paths, pngBlock, tag, textSourceNote, writeJson } from "./common";
import { emit } from "../lib/report";
import { domainOf } from "./domains";

const run = promisify(execFile);

const CodeSchema = z.object({
  code: z.string().describe("The complete contents of the .tsx file."),
});

export interface Convo {
  book: string;
  unit: string;
  spec: DemoSpec;
  messages: Anthropic.Beta.BetaMessageParam[];
}

// --- System prompt (stable per domain → cached) -------------------------------

const systemCache = new Map<Domain, Anthropic.Beta.BetaTextBlockParam[]>();

/** Allowed import specifiers for a generated demo (src/demos/<slug>/<unit>/X.tsx). */
export const ALLOWED_IMPORTS = ["react", "../../../demo/kit", "../../../types"];

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
## Rules
- The file is src/demos/<book>/<unit>/<Component>.tsx. Default-export a function component named <Component> that takes \`DemoProps\`.
- Import only from "react", "../../../demo/kit" and "../../../types" (type-only imports from types: \`import type { DemoProps } from "../../../types"\`). No other modules, no assets, no fetch, no DOM APIs beyond what Stage gives you.
- Render exactly one \`<Stage width={width} height={height} playing={playing} resetKey={resetKey} onFrame={...} />\` (optionally with pointer handlers). Do not render HTML controls, titles, captions or readout text — the shell does that. Small in-canvas labels (symbols, point names, axis labels, token words, short annotations) are good.
- Keep simulation state in \`useSim(() => init, [resetKey, preset, ...params that require a restart])\`; advance it by \`dt\` inside onFrame, then draw. Params that do not need a restart (e.g. speed, toggles for overlays) should take effect live.
- When \`playing\` is false (dt = 0), keep drawing the current state so the stage is never blank. The initial frame should already show the scene clearly.
- Call \`setReadouts\` from onFrame every frame with a value for every readout id in the spec (numbers or strings; use \`fmt\` for numbers). It is throttled by the shell.
- Read params with safe defaults and type narrowing, e.g. \`const n = Number(params.steps ?? 10)\`, \`const show = Boolean(params.trails)\`, \`const mode = String(params.path ?? "a")\`.
- Layout: compute positions from width and height (the stage is roughly 480–800 px wide and 280–600 px tall). Keep ≥ 24 px margins. Nothing may be clipped at the edges and no two labels may overlap. Choose ranges so everything stays on screen for every preset and slider value (clamp or wrap if needed).
- Style: minimal, on the dark stage (the canvas is transparent over #0a0a0a; don't paint a background). Use theme.fg for main objects, theme.muted for secondary lines, theme.faint or theme.grid for guides, and theme.accent (sparingly) for the one quantity the demo is about; theme.accent2 only for a contrasting second quantity. Symbols with \`draw.text(..., { kind: "symbol" })\`, annotations with kind "label", numbers with kind "mono". No gradients, glows, emoji or decoration. Any source code shown on the stage goes through \`draw.code\`, never plain draw.text. The reader has light and dark site themes and \`theme\` follows them: use only theme.* colours, \`sequential\`/\`diverging\` ramps and \`contrastText(fill)\` for text on filled cells; never write hex or rgb() colour literals, and read theme values at draw time (not in module-level constants).
${d.builder}
- Correctness: equations, units, signs and directions must match the spec and the text. Readouts must be computed from the same state that is drawn.
- Deterministic: no Math.random (use the kit's seeded \`rng\`), no Date.
- TypeScript strict mode with noUnusedLocals and noUnusedParameters: no unused variables, parameters or imports; no \`any\`.
- Respond with JSON \`{ "code": "<full file contents>" }\` only.`;

  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
  systemCache.set(book.domain, blocks);
  return blocks;
}

// --- Inputs ----------------------------------------------------------------

/**
 * Page crops for the demo: every beat's anchor region plus any figure/table
 * anchor whose text names a figure the brief mentions ("Fig. 13-3",
 * "Figure 2", "Table 1"). Dark on light.
 */
async function bookImages(c: Ctx, spec: DemoSpec): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
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
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const w of wanted.slice(0, 8)) {
    const buf = await anchorCrop(c, w.anchor);
    if (!buf) continue;
    out.push({ type: "text", text: `${w.why} (page ${w.anchor.page}):` }, pngBlock(buf));
  }
  return out;
}

function firstMessage(c: Ctx, spec: DemoSpec, images: Anthropic.Beta.BetaContentBlockParam[]) {
  const beats = spec.beats
    .map((b, i) => `Beat ${i} (preset "${b.preset}"${b.params ? `, params ${JSON.stringify(b.params)}` : ""}) — caption: ${b.caption}\n${anchorContext(c, b.anchor)}`)
    .join("\n\n");
  const src = textSourceNote(c.book);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `Write src/demos/${c.book.slug}/${c.unit.unit}/${spec.component}.tsx for this demo spec (from "${c.book.title}"):\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nThe beats and the paragraphs they are anchored to (">>>" marks the anchor; ${src.name}. ${src.caveat} The page crops below are authoritative):\n\n${beats}`,
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

function saveConvo(c: Convo) {
  writeJson(paths.convo(c.book, c.unit, c.spec.id), c);
}

export function loadConvo(slug: string, unit: string, id: string): Convo | null {
  const f = paths.convo(slug, unit, id);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Convo) : null;
}

/**
 * Send the conversation as it stands, write the returned code, then fix up
 * type/static errors for up to `rounds` extra turns. Returns true if clean.
 */
export async function runConvo(convo: Convo, rounds = 4, phase: "building" | "revising" = "building", outerRound?: number): Promise<boolean> {
  const { spec } = convo;
  const book = loadBook(convo.book);
  const t = tag(convo.book, convo.unit);
  const file = paths.component(convo.book, convo.unit, spec.component);
  const ev = (p: "building" | "revising" | "typecheck" | "fixing", detail?: string) =>
    emit({ type: "demo", unit: convo.unit, id: spec.id, phase: p, round: outerRound, detail });
  for (let round = 0; round <= rounds; round++) {
    ev(round === 0 ? phase : "fixing", round === 0 ? undefined : `typecheck round ${round}`);
    const { message, data } = await callJson(CodeSchema, {
      model: MODELS.sonnet,
      effort: "medium",
      label: `build:${t}:${spec.id}`,
      system: systemPrompt(book),
      messages: convo.messages,
    });
    convo.messages.push({ role: "assistant", content: message.content });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data.code.endsWith("\n") ? data.code : data.code + "\n");
    saveConvo(convo);

    ev("typecheck");
    const problems = [...staticProblems(data.code, spec), ...(await typecheck(convo.book, convo.unit, file))];
    if (problems.length === 0) {
      log(`build ${t} ${spec.id}: ok (round ${round})`);
      return true;
    }
    log(`build ${t} ${spec.id}: ${problems.length} problems (round ${round})`);
    if (round === rounds) break;
    convo.messages.push({
      role: "user",
      content: `The file has these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nFix them and reply with the complete corrected file as JSON { "code": ... }.`,
    });
  }
  saveConvo(convo);
  return false;
}

export async function buildDemo(c: Ctx, spec: DemoSpec): Promise<boolean> {
  const convo: Convo = { book: c.book.slug, unit: c.unit.unit, spec, messages: [firstMessage(c, spec, await bookImages(c, spec))] };
  return runConvo(convo);
}

export async function buildUnit(book: BookConfig, unitId: string, opts: { only?: string[]; concurrency?: number } = {}) {
  const c = loadCtx(book, unitId);
  const t = tag(book.slug, unitId);
  const plan = loadPlan(book.slug, unitId);
  const demos = plan.demos.filter((d) => !opts.only?.length || opts.only.includes(d.id));
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
      }\n\nThis is the file as it currently stands on disk (it may differ from your last reply; its import paths are the correct ones):\n\`\`\`tsx\n${current}\n\`\`\`\n\nLatest screenshots (560×760, ~2.5 s after load) follow.`,
    },
  ];
  const dir = paths.verifyDir(book.slug, unitId);
  for (let i = 0; i < spec.beats.length && i < 6; i++) {
    const shot = path.join(dir, `${id}-${i}-b.png`);
    if (fs.existsSync(shot)) content.push({ type: "text", text: `Beat ${i} (${spec.beats[i].preset}):` }, pngBlock(fs.readFileSync(shot)));
  }
  content.push({ type: "text", text: 'Address every note, keep everything that already works, and reply with the complete corrected file as JSON { "code": ... }.' });
  convo.messages.push({ role: "user", content });
  log(`revise ${t} ${id}`);
  return runConvo(convo, 3, "revising");
}
