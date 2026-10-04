// The template catalog: what the planner can choose instead of generating code.
// Pure TypeScript (no DOM/React at module top level) — imported by the app and the Node pipeline.

import type { DemoSpec } from "../../types";
import {
  DOCS,
  validateAlgorithmSteps,
  validateFunctionPlot,
  validateMatrixOps,
  validateOdeSim,
  validateSimHistogram,
  validateTableBars,
  validateVectorDiagram,
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
  validate,
});

export const TEMPLATES: TemplateInfo[] = [
  entry("function-plot", "Function plot", validateFunctionPlot),
  entry("ode-sim", "Simulation over time", validateOdeSim),
  entry("vector-diagram", "Vector diagram", validateVectorDiagram),
  entry("matrix-ops", "Matrix operations", validateMatrixOps),
  entry("sim-histogram", "Random trials", validateSimHistogram),
  entry("table-bars", "Table and bars", validateTableBars),
  entry("algorithm-steps", "Algorithm step-through", validateAlgorithmSteps),
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
