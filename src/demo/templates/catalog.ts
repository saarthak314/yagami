// The template catalog: what the planner can choose instead of generating code.
// Pure TypeScript (no DOM/React at module top level) — imported by the app and the Node pipeline.

import type { DemoSpec, Params } from "../../types";
import { CONSTANTS, FUNCTIONS, evalNum, tryCompile, type Compiled, type Env } from "./expr";
import {
  DOCS,
  STATIC_VARS,
  validateAlgorithmSteps,
  validateCalculusPlot,
  validateCellGrid,
  validateDataStructure,
  validateFunctionPlot,
  validateGeometry,
  validateParametricPlot,
  validateSequence,
  validateMatrixOps,
  validateOdeSim,
  validateSimHistogram,
  validateTableBars,
  validateVectorDiagram,
  validateHeapAllocator,
  validateAttentionHeads,
  validateLayerStack,
  validateMessageSequence,
  validateHashChain,
  validateStateMachine,
  validateMarkovChain,
} from "./configs";

export interface TemplateInfo {
  /** e.g. "function-plot" (DemoSpec.template). */
  id: string;
  title: string;
  /** When the planner should pick it (and when not). */
  when: string;
  /** Compact description of the config for the model (fields, types, expression syntax). */
  configDoc: string;
  /** One valid example config (for prompts and tests). */
  example: unknown;
  /** Problems with a config for a given spec (unknown param ids, bad expressions, wrong shapes); [] when valid. */
  validate(config: unknown, spec: DemoSpec): string[];
}

const entry = (id: keyof typeof DOCS, title: string, validate: TemplateInfo["validate"]): TemplateInfo => ({
  id,
  title,
  when: DOCS[id].when,
  configDoc: DOCS[id].configDoc,
  example: DOCS[id].example,
  // Template-specific checks first; once the config is well-formed, evaluate what can be evaluated
  // without rendering (readouts that only use params, defs and constants) at every beat.
  validate: (config, spec) => {
    const problems = validate(config, spec);
    return problems.length ? problems : staticReadoutProblems(config, spec, id);
  },
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Readouts whose formulas use only params, defs and constants can be evaluated now, at each beat's
 * params: a non-finite value, or a value that contradicts the spec's `expect`, is a config mistake that
 * would otherwise only show up after rendering (and cost a fix round).
 */
export function staticReadoutProblems(config: unknown, spec: DemoSpec, templateId = spec?.template ?? ""): string[] {
  if (!isObj(config) || !isObj(config.readouts) || !spec?.beats?.length) return [];
  const readouts = Object.entries(config.readouts)
    .map(([id, def]) => {
      const src = typeof def === "string" || typeof def === "number" ? def : isObj(def) ? def.expr : undefined;
      const c = typeof src === "number" ? src : tryCompile(src);
      return typeof c === "string" || c === undefined ? null : { id, src: String(src), c };
    })
    .filter((r): r is { id: string; src: string; c: Compiled | number } => r !== null);
  const defs = isObj(config.defs) ? Object.entries(config.defs) : [];
  const pure = (c: Compiled | number, known: Set<string>) =>
    typeof c === "number" || ([...c.names].every((n) => known.has(n) || n in CONSTANTS) && [...c.calls].every((f) => f in FUNCTIONS || known.has(f)));
  const presetParams = new Map((spec.presets ?? []).map((p) => [p.id, p.params ?? {}]));
  const out = new Map<string, number[]>();
  const add = (msg: string, beat: number) => out.set(msg, [...(out.get(msg) ?? []), beat]);
  spec.beats.forEach((b, i) => {
    const params: Params = { ...(presetParams.get(b.preset) ?? spec.presets?.[0]?.params ?? {}), ...(b.params ?? {}) };
    const env: Env = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "boolean" ? (v ? 1 : 0) : v]));
    const known = new Set(Object.keys(params));
    // Defs may build on each other: evaluate the static ones until nothing new resolves.
    let progress = true;
    const pending = new Map(defs);
    while (progress) {
      progress = false;
      for (const [name, src] of pending) {
        const c = typeof src === "number" ? src : tryCompile(src);
        if (typeof c === "string") {
          pending.delete(name);
          continue;
        }
        if (!pure(c, known)) continue;
        env[name] = typeof c === "number" ? c : evalNum(c, env);
        known.add(name);
        pending.delete(name);
        progress = true;
      }
    }
    // The template's own deterministic values (sizes, counts) at these params.
    const derive = STATIC_VARS[templateId];
    if (derive) {
      try {
        for (const [k, v] of Object.entries(derive(config as never, env))) {
          env[k] = v;
          known.add(k);
        }
      } catch {
        // not derivable: those readouts are checked after rendering
      }
    }
    for (const r of readouts) {
      if (!pure(r.c, known)) continue;
      if (typeof r.c !== "number") {
        // Text readouts (a chosen value, a state name, a hash) are fine as they are.
        let raw: unknown;
        try {
          raw = r.c(env);
        } catch {
          raw = NaN;
        }
        if (typeof raw === "string" && raw !== "" && Number.isNaN(Number(raw))) continue;
      }
      const v = typeof r.c === "number" ? r.c : evalNum(r.c, env);
      if (!Number.isFinite(v)) {
        add(`readout "${r.id}" ("${r.src}") is ${v} — check the formula and the params`, i);
        continue;
      }
      for (const e of spec.expect ?? []) {
        const beat = typeof e.beat === "number" ? e.beat : spec.beats.findIndex((x) => x.anchor === (e as { anchor?: string }).anchor);
        if (beat !== i || e.readout !== r.id || !Number.isFinite(e.value)) continue;
        const tol = e.tol ?? 0.02;
        const okv = tol === 0 ? Math.abs(v - e.value) < 1e-9 * Math.max(1, Math.abs(e.value)) : Math.abs(v - e.value) <= tol * Math.max(Math.abs(e.value), 1e-12);
        if (!okv) add(`expect says readout "${r.id}" is ${e.value}, but its formula "${r.src}" gives ${Number(v.toPrecision(6))} with that beat's params — fix the expectation, the formula or the beat's params`, i);
      }
    }
  });
  return [...out.entries()].map(([msg, beats]) => `${beats.length > 1 ? "beats" : "beat"} ${beats.join(",")}: ${msg}`);
}

export const TEMPLATES: TemplateInfo[] = [
  entry("function-plot", "Function plot", validateFunctionPlot),
  entry("ode-sim", "Simulation over time", validateOdeSim),
  entry("vector-diagram", "Vector diagram", validateVectorDiagram),
  entry("matrix-ops", "Matrix operations", validateMatrixOps),
  entry("sim-histogram", "Random trials", validateSimHistogram),
  entry("table-bars", "Table and bars", validateTableBars),
  entry("algorithm-steps", "Algorithm step-through", validateAlgorithmSteps),
  entry("calculus-plot", "Derivative and integral", validateCalculusPlot),
  entry("parametric-plot", "Parametric and polar curves", validateParametricPlot),
  entry("geometry", "Geometric construction", validateGeometry),
  entry("sequence", "Sequence and series", validateSequence),
  entry("cell-grid", "Cells, bits and words", validateCellGrid),
  entry("data-structure", "Data structure operations", validateDataStructure),
  entry("heap-allocator", "Heap allocator", validateHeapAllocator),
  entry("attention-heads", "Attention heads", validateAttentionHeads),
  entry("layer-stack", "Transformer layer stack", validateLayerStack),
  entry("message-sequence", "Message sequence between nodes", validateMessageSequence),
  entry("hash-chain", "Hash chain and Merkle tree", validateHashChain),
  entry("state-machine", "Automaton or Turing machine", validateStateMachine),
  entry("markov-chain", "Markov chain and random walk", validateMarkovChain),
];

export function templateInfo(id: string | undefined): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Problems with a template demo spec ([] when it can be rendered): unknown template or an invalid config. */
export function validateTemplateSpec(spec: DemoSpec): string[] {
  const t = templateInfo(spec.template);
  if (!t) return [`unknown template "${spec.template}" (have: ${TEMPLATES.map((x) => x.id).join(", ")})`];
  return t.validate(spec.config, spec).map((p) => `${t.id} config: ${p}`);
}

/** The catalog as the planner's prompt sees it. */
export function catalogPrompt(): string {
  return TEMPLATES.map((t) => `- ${t.id} (${t.title}): ${t.when}\n  config: ${t.configDoc}\n  example: ${JSON.stringify(t.example)}`).join("\n");
}
