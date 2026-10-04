// Template components by id (lazy: a book only loads the templates it uses).

import { lazy, type ComponentType } from "react";
import type { DemoProps } from "../../types";

type TemplateComponent = ComponentType<DemoProps & { config: unknown }>;
type Loader = () => Promise<{ default: TemplateComponent }>;

const LOADERS: Record<string, Loader> = {
  "function-plot": () => import("./FunctionPlot") as unknown as Promise<{ default: TemplateComponent }>,
  "ode-sim": () => import("./OdeSim") as unknown as Promise<{ default: TemplateComponent }>,
  "vector-diagram": () => import("./VectorDiagram") as unknown as Promise<{ default: TemplateComponent }>,
  "matrix-ops": () => import("./MatrixOps") as unknown as Promise<{ default: TemplateComponent }>,
  "sim-histogram": () => import("./SimHistogram") as unknown as Promise<{ default: TemplateComponent }>,
  "table-bars": () => import("./TableBars") as unknown as Promise<{ default: TemplateComponent }>,
  "algorithm-steps": () => import("./AlgorithmSteps") as unknown as Promise<{ default: TemplateComponent }>,
  "calculus-plot": () => import("./CalculusPlot") as unknown as Promise<{ default: TemplateComponent }>,
  "parametric-plot": () => import("./ParametricPlot") as unknown as Promise<{ default: TemplateComponent }>,
  geometry: () => import("./Geometry") as unknown as Promise<{ default: TemplateComponent }>,
  sequence: () => import("./Sequence") as unknown as Promise<{ default: TemplateComponent }>,
  "cell-grid": () => import("./CellGrid") as unknown as Promise<{ default: TemplateComponent }>,
  "data-structure": () => import("./DataStructure") as unknown as Promise<{ default: TemplateComponent }>,
};

const cache = new Map<string, TemplateComponent>();

/** The lazy component for a template id, or null when the id is unknown. */
export function templateComponent(id: string): TemplateComponent | null {
  const load = LOADERS[id];
  if (!load) return null;
  let c = cache.get(id);
  if (!c) {
    c = lazy(load);
    cache.set(id, c);
  }
  return c;
}
