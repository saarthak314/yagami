// Template configs: types, validation and the compact docs the planner reads.
// Pure TypeScript (no DOM/React) so the Node pipeline can import it through catalog.ts.

import type { DemoSpec } from "../../types";
import { BUILTIN_FUNCTIONS, checkExpr } from "./expr";

/** A number, or an expression string over params and the template's variables. */
export type Num = number | string;
export type Color = "accent" | "accent2" | "fg" | "muted" | "faint";
/** Readout: an expression, or { expr, digits?, unit? }. */
export type ReadoutDef = string | { expr: string; digits?: number; unit?: string };

interface Common {
  /** Named values computed from params (in order); usable in every expression. */
  defs?: Record<string, string>;
  /** One entry per spec readout id. */
  readouts: Record<string, ReadoutDef>;
}

export interface FunctionPlotConfig extends Common {
  x: { min: Num; max: Num; label?: string; log?: boolean };
  y?: { min?: Num; max?: Num; label?: string; log?: boolean };
  curves: { y: string; label?: string; color?: Color; dashed?: boolean; fill?: boolean }[];
  marker?: { x: Num; label?: string };
  sweep?: { seconds?: number };
  points?: { x: Num; y: Num; label?: string }[];
}

export interface OdeSimConfig extends Common {
  state: Record<string, Num>;
  deriv: Record<string, string>;
  dt?: number;
  speed?: number;
  tMax?: Num;
  stop?: string;
  scene?: {
    x: [Num, Num];
    y: [Num, Num];
    equal?: boolean;
    ground?: Num;
    bodies?: { x: string; y: string; label?: string; r?: number; trail?: boolean; color?: Color }[];
    links?: { x1: Num; y1: Num; x2: Num; y2: Num; kind?: "line" | "spring"; dashed?: boolean }[];
    arrows?: { x: Num; y: Num; dx: Num; dy: Num; label?: string; color?: Color }[];
  };
  plot?: { y: { expr: string; label?: string; color?: Color; dashed?: boolean }[]; min?: Num; max?: Num; span?: number };
}

export interface VectorDiagramConfig extends Common {
  range: Num;
  vectors: { name: string; x: string; y: string; from?: string | [Num, Num]; label?: string; color?: Color; dashed?: boolean }[];
  angle?: [string, string];
  projection?: { of: string; onto: string };
  grid?: boolean;
}

export type MatrixOp = "matmul" | "transpose" | "scale" | "softmax" | "mask" | "add" | "relu" | "layernorm" | "map";
export interface MatrixOpsConfig extends Common {
  seed?: number;
  labels?: { rows?: string[]; cols?: string[] };
  inputs: Record<string, { rows: Num; cols: Num; init?: string; std?: Num; values?: number[][] }>;
  steps: { name: string; op: MatrixOp; a: string; b?: string; by?: Num; expr?: string; label?: string }[];
  show: string[];
  highlightRow?: Num;
  values?: boolean;
}

export interface SimHistogramConfig extends Common {
  seed?: number;
  trial: string;
  trials: Num;
  perSecond?: number;
  bins?: { min: Num; max: Num; count?: number } | "integer";
  expected?: string;
  xLabel?: string;
}

export interface TableBarsConfig extends Common {
  rows: { label: string; vars?: Record<string, Num> }[];
  columns: { id: string; label: string; expr: string; digits?: number; unit?: string }[];
  bar?: { column: string; log?: boolean };
  highlight?: Num;
}

export const ALGORITHMS = ["binary-search", "linear-search", "insertion-sort", "bubble-sort", "selection-sort", "merge-sort", "bfs", "dfs", "two-pointers"] as const;
export type Algorithm = (typeof ALGORITHMS)[number];
export interface AlgorithmStepsConfig extends Common {
  algorithm: Algorithm;
  array?: number[] | { n: Num; seed?: number; max?: number; sorted?: boolean };
  target?: Num;
  graph?: { nodes: string[]; edges: [string, string][]; start: string; directed?: boolean };
  speed?: Num;
  code?: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const COLORS = ["accent", "accent2", "fg", "muted", "faint"];

/** Every parameter id a spec can supply: controls, preset params and beat params. */
export function paramIds(spec: DemoSpec): string[] {
  const ids = new Set<string>();
  for (const c of spec.controls ?? []) ids.add(c.id);
  for (const p of spec.presets ?? []) for (const k of Object.keys(p.params ?? {})) ids.add(k);
  for (const b of spec.beats ?? []) for (const k of Object.keys(b.params ?? {})) ids.add(k);
  return [...ids];
}

class Checker {
  problems: string[] = [];
  constructor(public vars: Set<string>, public fns: string[] = []) {}
  add(p: string) {
    this.problems.push(p);
  }
  expr(v: unknown, where: string, extraVars: string[] = []) {
    if (v === undefined) return this.add(`${where}: missing`);
    if (typeof v === "number") return;
    this.problems.push(...checkExpr(v, [...this.vars, ...extraVars], [...this.fns, ...BUILTIN_FUNCTIONS], where));
  }
  optExpr(v: unknown, where: string, extraVars: string[] = []) {
    if (v !== undefined) this.expr(v, where, extraVars);
  }
  color(v: unknown, where: string) {
    if (v !== undefined && !COLORS.includes(v as string)) this.add(`${where}: color must be one of ${COLORS.join(", ")}`);
  }
  defs(v: unknown) {
    if (v === undefined) return;
    if (!isObj(v)) return this.add("defs: must be an object of name → expression");
    for (const [k, e] of Object.entries(v)) {
      if (!/^[A-Za-z_]\w*$/.test(k)) this.add(`defs: "${k}" is not a valid name`);
      this.expr(e, `defs.${k}`);
      this.vars.add(k);
    }
  }
  readouts(v: unknown, spec: DemoSpec, extraVars: string[] = []) {
    if (!isObj(v)) return this.add("readouts: must be an object of readout id → expression");
    for (const r of spec.readouts ?? []) if (!(r.id in v)) this.add(`readouts: no expression for readout "${r.id}"`);
    for (const [id, d] of Object.entries(v)) {
      if (!(spec.readouts ?? []).some((r) => r.id === id)) this.add(`readouts: "${id}" is not a readout id of the spec`);
      const e = isObj(d) ? d.expr : d;
      this.expr(e, `readouts.${id}`, extraVars);
    }
  }
}

function base(spec: DemoSpec, extra: string[] = [], fns: string[] = []) {
  return new Checker(new Set([...paramIds(spec), ...extra]), fns);
}

// ---------------------------------------------------------------------------
// Validators (config, spec) → problems
// ---------------------------------------------------------------------------

export function validateFunctionPlot(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t", "u"]);
  k.defs(c.defs);
  if (!isObj(c.x)) k.add("x: { min, max, label? } is required");
  else {
    k.expr(c.x.min, "x.min");
    k.expr(c.x.max, "x.max");
  }
  if (c.y !== undefined) {
    if (!isObj(c.y)) k.add("y: must be an object");
    else {
      k.optExpr(c.y.min, "y.min");
      k.optExpr(c.y.max, "y.max");
    }
  }
  const curves = Array.isArray(c.curves) ? c.curves : [];
  if (!curves.length || curves.length > 4) k.add("curves: 1–4 curves are required");
  curves.forEach((cv, i) => {
    if (!isObj(cv)) return k.add(`curves[${i}]: must be an object`);
    k.expr(cv.y, `curves[${i}].y`, ["x"]);
    k.color(cv.color, `curves[${i}]`);
  });
  const ys = curves.map((_, i) => `y${i + 1}`);
  if (c.marker !== undefined) {
    if (!isObj(c.marker)) k.add("marker: must be { x, label? }");
    else k.expr(c.marker.x, "marker.x");
  }
  if (Array.isArray(c.points))
    c.points.forEach((p, i) => {
      if (!isObj(p)) return k.add(`points[${i}]: must be { x, y, label? }`);
      k.expr(p.x, `points[${i}].x`);
      k.expr(p.y, `points[${i}].y`);
    });
  k.readouts(c.readouts, spec, ["mx", ...ys]);
  return k.problems;
}

export function validateOdeSim(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"]);
  k.defs(c.defs);
  if (!isObj(c.state) || !Object.keys(c.state).length) return [...k.problems, "state: { name: initial value } with at least one variable is required"];
  const vars = Object.keys(c.state);
  for (const v of vars) if (!/^[A-Za-z_]\w*$/.test(v)) k.add(`state: "${v}" is not a valid name`);
  for (const [v, e] of Object.entries(c.state)) k.expr(e, `state.${v}`);
  if (!isObj(c.deriv)) k.add("deriv: { name: expression } for every state variable is required");
  else {
    for (const v of vars) if (!(v in c.deriv)) k.add(`deriv: no derivative for "${v}"`);
    for (const [v, e] of Object.entries(c.deriv)) {
      if (!vars.includes(v)) k.add(`deriv: "${v}" is not a state variable`);
      k.expr(e, `deriv.${v}`, vars);
    }
  }
  if (c.dt !== undefined && !(typeof c.dt === "number" && c.dt > 0 && c.dt <= 1)) k.add("dt: must be a number in (0, 1]");
  k.optExpr(c.tMax, "tMax");
  k.optExpr(c.stop, "stop", vars);
  if (c.scene !== undefined) {
    const s = c.scene;
    if (!isObj(s)) k.add("scene: must be an object");
    else {
      for (const ax of ["x", "y"] as const) {
        const r = s[ax];
        if (!Array.isArray(r) || r.length !== 2) k.add(`scene.${ax}: must be [min, max]`);
        else r.forEach((v, i) => k.expr(v, `scene.${ax}[${i}]`, vars));
      }
      k.optExpr(s.ground, "scene.ground", vars);
      (Array.isArray(s.bodies) ? s.bodies : []).forEach((b, i) => {
        if (!isObj(b)) return k.add(`scene.bodies[${i}]: must be an object`);
        k.expr(b.x, `scene.bodies[${i}].x`, vars);
        k.expr(b.y, `scene.bodies[${i}].y`, vars);
        k.color(b.color, `scene.bodies[${i}]`);
      });
      (Array.isArray(s.links) ? s.links : []).forEach((l, i) => {
        if (!isObj(l)) return k.add(`scene.links[${i}]: must be an object`);
        for (const f of ["x1", "y1", "x2", "y2"]) k.expr(l[f], `scene.links[${i}].${f}`, vars);
      });
      (Array.isArray(s.arrows) ? s.arrows : []).forEach((a, i) => {
        if (!isObj(a)) return k.add(`scene.arrows[${i}]: must be an object`);
        for (const f of ["x", "y", "dx", "dy"]) k.expr(a[f], `scene.arrows[${i}].${f}`, vars);
        k.color(a.color, `scene.arrows[${i}]`);
      });
    }
  }
  if (c.plot !== undefined) {
    const p = c.plot;
    if (!isObj(p) || !Array.isArray(p.y) || !p.y.length) k.add("plot: { y: [{ expr, label? }] } needs at least one series");
    else {
      p.y.forEach((s, i) => {
        if (!isObj(s)) return k.add(`plot.y[${i}]: must be an object`);
        k.expr(s.expr, `plot.y[${i}].expr`, vars);
        k.color(s.color, `plot.y[${i}]`);
      });
      k.optExpr(p.min, "plot.min");
      k.optExpr(p.max, "plot.max");
    }
  }
  k.readouts(c.readouts, spec, vars);
  return k.problems;
}

export function validateVectorDiagram(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], ["dot", "cross", "norm", "angle"]);
  k.defs(c.defs);
  k.expr(c.range, "range");
  const vecs = Array.isArray(c.vectors) ? c.vectors : [];
  if (!vecs.length || vecs.length > 6) k.add("vectors: 1–6 vectors are required");
  const names: string[] = [];
  vecs.forEach((v, i) => {
    if (!isObj(v)) return k.add(`vectors[${i}]: must be an object`);
    const nm = String(v.name ?? "");
    if (!/^[A-Za-z_]\w*$/.test(nm)) k.add(`vectors[${i}].name: must be a simple name`);
    // Earlier vectors (and their parts) are visible to later ones.
    const visible = names.flatMap((n) => [n, `${n}_x`, `${n}_y`, `${n}_len`, `${n}_ang`]);
    k.expr(v.x, `vectors[${i}].x`, visible);
    k.expr(v.y, `vectors[${i}].y`, visible);
    if (typeof v.from === "string" && !names.includes(v.from)) k.add(`vectors[${i}].from: "${v.from}" must name an earlier vector`);
    if (Array.isArray(v.from)) v.from.forEach((f, j) => k.expr(f, `vectors[${i}].from[${j}]`, visible));
    k.color(v.color, `vectors[${i}]`);
    names.push(nm);
  });
  const all = names.flatMap((n) => [n, `${n}_x`, `${n}_y`, `${n}_len`, `${n}_ang`]);
  if (c.angle !== undefined && !(Array.isArray(c.angle) && c.angle.length === 2 && c.angle.every((a) => names.includes(a as string)))) k.add("angle: must be [vectorName, vectorName]");
  if (c.projection !== undefined && !(isObj(c.projection) && names.includes(c.projection.of as string) && names.includes(c.projection.onto as string)))
    k.add("projection: must be { of: vectorName, onto: vectorName }");
  k.readouts(c.readouts, spec, all);
  return k.problems;
}

const MATRIX_OPS: MatrixOp[] = ["matmul", "transpose", "scale", "softmax", "mask", "add", "relu", "layernorm", "map"];
const MATRIX_FNS = ["get", "rowsum", "rowmax", "rowmin", "argmax", "entropy", "var", "rows", "cols"];
export function validateMatrixOps(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], MATRIX_FNS);
  k.defs(c.defs);
  const names: string[] = [];
  if (!isObj(c.inputs) || !Object.keys(c.inputs).length) k.add("inputs: { name: { rows, cols, init? } } with at least one matrix is required");
  else
    for (const [n, m] of Object.entries(c.inputs)) {
      names.push(n);
      if (!isObj(m)) {
        k.add(`inputs.${n}: must be an object`);
        continue;
      }
      if (m.values !== undefined) {
        if (!Array.isArray(m.values) || !m.values.every((r) => Array.isArray(r) && r.every((x) => typeof x === "number"))) k.add(`inputs.${n}.values: must be a number[][]`);
      } else {
        k.expr(m.rows, `inputs.${n}.rows`);
        k.expr(m.cols, `inputs.${n}.cols`);
      }
      const init = m.init ?? "random";
      if (typeof init !== "string") k.add(`inputs.${n}.init: must be a string`);
      else if (!["random", "identity", "zeros", "ones", "causal"].includes(init)) k.expr(init, `inputs.${n}.init`, ["i", "j"]);
      k.optExpr(m.std, `inputs.${n}.std`);
    }
  const steps = Array.isArray(c.steps) ? c.steps : [];
  steps.forEach((s, i) => {
    if (!isObj(s)) return k.add(`steps[${i}]: must be an object`);
    if (!MATRIX_OPS.includes(s.op as MatrixOp)) k.add(`steps[${i}].op: must be one of ${MATRIX_OPS.join(", ")}`);
    if (!names.includes(s.a as string)) k.add(`steps[${i}].a: "${String(s.a)}" is not an earlier matrix`);
    if ((s.op === "matmul" || s.op === "add") && !names.includes(s.b as string)) k.add(`steps[${i}].b: "${String(s.b)}" is not an earlier matrix`);
    if (s.op === "scale") k.expr(s.by, `steps[${i}].by`);
    if (s.op === "map") k.expr(s.expr, `steps[${i}].expr`, ["v", "i", "j"]);
    if (s.op === "mask" && s.expr !== undefined) k.expr(s.expr, `steps[${i}].expr`, ["i", "j"]);
    if (typeof s.name !== "string" || !/^[A-Za-z_]\w*$/.test(s.name)) k.add(`steps[${i}].name: must be a simple name`);
    else names.push(s.name);
  });
  if (!Array.isArray(c.show) || !c.show.length) k.add("show: list the matrices to draw");
  else for (const s of c.show) if (!names.includes(s as string)) k.add(`show: "${String(s)}" is not a matrix`);
  k.optExpr(c.highlightRow, "highlightRow");
  k.readouts(c.readouts, spec, names);
  return k.problems;
}

const RANDOM_FNS = ["rand", "randn", "randint", "coin"];
export function validateSimHistogram(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], [...RANDOM_FNS, "frac"]);
  k.defs(c.defs);
  k.expr(c.trial, "trial");
  k.expr(c.trials, "trials");
  if (c.bins !== undefined && c.bins !== "integer") {
    if (!isObj(c.bins)) k.add('bins: must be "integer" or { min, max, count? }');
    else {
      k.expr(c.bins.min, "bins.min");
      k.expr(c.bins.max, "bins.max");
    }
  }
  k.optExpr(c.expected, "expected", ["x"]);
  k.readouts(c.readouts, spec, ["n", "mean", "sd", "last"]);
  return k.problems;
}

export function validateTableBars(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], ["cell", "col"]);
  k.defs(c.defs);
  const rows = Array.isArray(c.rows) ? c.rows : [];
  if (!rows.length || rows.length > 10) k.add("rows: 1–10 rows are required");
  const rowVars = new Set<string>();
  rows.forEach((r, i) => {
    if (!isObj(r) || typeof r.label !== "string") return k.add(`rows[${i}]: must be { label, vars? }`);
    if (r.vars !== undefined) {
      if (!isObj(r.vars)) k.add(`rows[${i}].vars: must be an object`);
      else
        for (const [n, e] of Object.entries(r.vars)) {
          k.expr(e, `rows[${i}].vars.${n}`);
          rowVars.add(n);
        }
    }
  });
  const cols = Array.isArray(c.columns) ? c.columns : [];
  if (!cols.length || cols.length > 5) k.add("columns: 1–5 columns are required");
  cols.forEach((col, i) => {
    if (!isObj(col) || typeof col.id !== "string") return k.add(`columns[${i}]: must be { id, label, expr }`);
    k.expr(col.expr, `columns[${i}].expr`, [...rowVars, "row"]);
  });
  const bar = c.bar;
  if (bar !== undefined && !(isObj(bar) && cols.some((col) => isObj(col) && col.id === bar.column))) k.add("bar.column: must name a column id");
  k.optExpr(c.highlight, "highlight");
  k.readouts(c.readouts, spec);
  return k.problems;
}

export function validateAlgorithmSteps(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"]);
  k.defs(c.defs);
  const alg = c.algorithm as Algorithm;
  if (!ALGORITHMS.includes(alg)) k.add(`algorithm: must be one of ${ALGORITHMS.join(", ")}`);
  const graphAlg = alg === "bfs" || alg === "dfs";
  if (graphAlg) {
    const g = c.graph;
    if (!isObj(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) k.add("graph: { nodes, edges, start } is required for bfs/dfs");
    else {
      if (g.nodes.length < 2 || g.nodes.length > 12) k.add("graph.nodes: 2–12 nodes");
      for (const e of g.edges) if (!Array.isArray(e) || e.length !== 2 || !e.every((x) => (g.nodes as unknown[]).includes(x))) k.add(`graph.edges: ${JSON.stringify(e)} must join two listed nodes`);
      if (!(g.nodes as unknown[]).includes(g.start)) k.add("graph.start: must be a listed node");
    }
  } else {
    const a = c.array;
    if (a === undefined) k.add("array: a number[] or { n, seed?, max?, sorted? } is required");
    else if (Array.isArray(a)) {
      if (a.length < 2 || a.length > 16 || !a.every((x) => typeof x === "number")) k.add("array: 2–16 numbers");
    } else if (isObj(a)) k.expr(a.n, "array.n");
    else k.add("array: must be a number[] or { n, … }");
    if (alg === "binary-search" || alg === "linear-search" || alg === "two-pointers") k.expr(c.target, "target");
  }
  k.optExpr(c.speed, "speed");
  const vars = ["step", "steps", "comparisons", "swaps", "done", "found", "n", "lo", "hi", "mid", "i", "j", "visited", "frontier"];
  k.readouts(c.readouts, spec, vars);
  return k.problems;
}

// ---------------------------------------------------------------------------
// Phase 4 templates
// ---------------------------------------------------------------------------

export interface CalculusPlotConfig extends Common {
  f: string;
  x: { min: Num; max: Num; label?: string };
  y?: { min?: Num; max?: Num; label?: string };
  label?: string;
  at?: Num;
  tangent?: boolean;
  secant?: { h: Num };
  riemann?: { from: Num; to: Num; n: Num; rule?: "left" | "right" | "mid" | "trap" };
  area?: { from: Num; to: Num };
  panels?: ("derivative" | "integral")[];
  sweep?: { seconds?: number };
}

export interface ParametricCurve {
  x?: string;
  y?: string;
  r?: string;
  s: [Num, Num];
  label?: string;
  color?: Color;
  dashed?: boolean;
}
export interface ParametricPlotConfig extends Common {
  view: { x: [Num, Num]; y: [Num, Num]; equal?: boolean; xLabel?: string; yLabel?: string };
  curves: ParametricCurve[];
  field?: { u: string; v: string; n?: number; normalize?: boolean; color?: Color };
  point?: { curve?: number; s: Num; label?: string; velocity?: boolean; trail?: Num; sector?: { cx: Num; cy: Num; span: Num } };
  points?: { x: Num; y: Num; label?: string }[];
  sweep?: { seconds?: number };
}

export type GeometryShape =
  | { kind: "segment" | "ray" | "line"; from: string; to: string; label?: string; color?: Color; dashed?: boolean; arrow?: boolean }
  | { kind: "circle"; center: string; r: Num; label?: string; color?: Color; dashed?: boolean }
  | { kind: "polygon"; points: string[]; label?: string; color?: Color; fill?: boolean; dashed?: boolean }
  | { kind: "angle"; at: string; from: string; to: string; label?: string; color?: Color }
  | { kind: "arc"; center: string; r: Num; from: Num; to: Num; label?: string; color?: Color; dashed?: boolean };
export interface GeometryConfig extends Common {
  view?: { x: [Num, Num]; y: [Num, Num] };
  points: { name: string; x: Num; y: Num; label?: string; hidden?: boolean; color?: Color }[];
  shapes?: GeometryShape[];
  grid?: boolean;
  sweep?: { seconds?: number };
}

export interface SequenceConfig extends Common {
  state?: Record<string, Num>;
  next?: Record<string, string>;
  term?: string;
  n: Num;
  show?: "terms" | "sum" | "both";
  limit?: Num;
  table?: { columns: string[]; rows?: number };
  speed?: Num;
  label?: string;
  xLabel?: string;
}

export interface CellRow {
  label?: string;
  n: Num;
  value: string;
  style?: string;
  index?: string;
  groups?: { from: Num; to: Num; label: string; color?: Color }[];
}
export interface CellGridConfig extends Common {
  rows: CellRow[];
  pointers?: { row?: number; at: Num; label: string; color?: Color }[];
  steps?: Num;
  speed?: Num;
  message?: string;
}

export const STRUCTURES = ["stack", "queue", "linked-list", "bst", "min-heap", "hash-table"] as const;
export type Structure = (typeof STRUCTURES)[number];
export const STRUCTURE_OPS = ["push", "pop", "enqueue", "dequeue", "insert", "delete", "search"] as const;
export type StructureOp = (typeof STRUCTURE_OPS)[number];
export interface DataStructureConfig extends Common {
  kind: Structure;
  ops: { op: StructureOp; value?: Num }[];
  buckets?: Num;
  hash?: string;
  speed?: Num;
  code?: boolean;
}

/** Functions the cell-grid template adds (bit operations work on integers up to 2^53). */
export const CELL_FNS = ["bit", "band", "bor", "bxor", "bnot", "shl", "shr", "hex", "bin", "str", "pad"];
/** Functions the geometry template adds (points are values [x, y]). */
export const GEOMETRY_FNS = ["dist", "ang", "area", "mid", "dir"];

const RULES = ["left", "right", "mid", "trap"];

export function validateCalculusPlot(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t", "u"]);
  k.defs(c.defs);
  k.expr(c.f, "f", ["x"]);
  if (!isObj(c.x)) k.add("x: { min, max, label? } is required");
  else {
    k.expr(c.x.min, "x.min");
    k.expr(c.x.max, "x.max");
  }
  if (c.y !== undefined) {
    if (!isObj(c.y)) k.add("y: must be an object");
    else {
      k.optExpr(c.y.min, "y.min");
      k.optExpr(c.y.max, "y.max");
    }
  }
  k.optExpr(c.at, "at");
  if ((c.tangent || c.secant !== undefined) && c.at === undefined) k.add("at: required for tangent/secant");
  if (c.secant !== undefined) {
    if (!isObj(c.secant)) k.add("secant: must be { h }");
    else k.expr(c.secant.h, "secant.h");
  }
  if (c.riemann !== undefined) {
    if (!isObj(c.riemann)) k.add("riemann: must be { from, to, n, rule? }");
    else {
      for (const f of ["from", "to", "n"]) k.expr(c.riemann[f], `riemann.${f}`);
      if (c.riemann.rule !== undefined && !RULES.includes(c.riemann.rule as string)) k.add(`riemann.rule: must be one of ${RULES.join(", ")}`);
    }
  }
  if (c.area !== undefined) {
    if (!isObj(c.area)) k.add("area: must be { from, to }");
    else {
      k.expr(c.area.from, "area.from");
      k.expr(c.area.to, "area.to");
    }
  }
  if (c.panels !== undefined && !(Array.isArray(c.panels) && c.panels.every((p) => p === "derivative" || p === "integral"))) k.add('panels: a list of "derivative" and/or "integral"');
  k.readouts(c.readouts, spec, ["a", "fa", "slope", "secant", "h", "riemann", "exact", "error", "area", "n"]);
  return k.problems;
}

function vec2(k: Checker, v: unknown, where: string, extra: string[] = []) {
  if (!Array.isArray(v) || v.length !== 2) return k.add(`${where}: must be [a, b]`);
  v.forEach((x, i) => k.expr(x, `${where}[${i}]`, extra));
}

export function validateParametricPlot(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t", "u"]);
  k.defs(c.defs);
  if (!isObj(c.view)) k.add("view: { x: [min, max], y: [min, max], equal? } is required");
  else {
    vec2(k, c.view.x, "view.x");
    vec2(k, c.view.y, "view.y");
  }
  const curves = Array.isArray(c.curves) ? c.curves : [];
  if (!curves.length || curves.length > 4) k.add("curves: 1–4 curves are required");
  curves.forEach((cv, i) => {
    if (!isObj(cv)) return k.add(`curves[${i}]: must be an object`);
    if (cv.r !== undefined) k.expr(cv.r, `curves[${i}].r`, ["s"]);
    else {
      k.expr(cv.x, `curves[${i}].x`, ["s"]);
      k.expr(cv.y, `curves[${i}].y`, ["s"]);
    }
    vec2(k, cv.s, `curves[${i}].s`);
    k.color(cv.color, `curves[${i}]`);
  });
  if (c.field !== undefined) {
    if (!isObj(c.field)) k.add("field: must be { u, v, n?, normalize? }");
    else {
      k.expr(c.field.u, "field.u", ["x", "y"]);
      k.expr(c.field.v, "field.v", ["x", "y"]);
      k.color(c.field.color, "field");
    }
  }
  if (c.point !== undefined) {
    const p = c.point;
    if (!isObj(p)) k.add("point: must be { s, curve?, label?, velocity?, sector? }");
    else {
      k.expr(p.s, "point.s");
      if (p.curve !== undefined && !(typeof p.curve === "number" && p.curve >= 0 && p.curve < curves.length)) k.add("point.curve: must be a curve index");
      k.optExpr(p.trail, "point.trail");
      if (p.sector !== undefined) {
        if (!isObj(p.sector)) k.add("point.sector: must be { cx, cy, span }");
        else for (const f of ["cx", "cy", "span"]) k.expr(p.sector[f], `point.sector.${f}`);
      }
    }
  }
  if (Array.isArray(c.points))
    c.points.forEach((p, i) => {
      if (!isObj(p)) return k.add(`points[${i}]: must be { x, y, label? }`);
      k.expr(p.x, `points[${i}].x`);
      k.expr(p.y, `points[${i}].y`);
    });
  k.readouts(c.readouts, spec, ["s", "px", "py", "vx", "vy", "speed", "r", "theta", "sector", "length"]);
  return k.problems;
}

const SHAPES = ["segment", "ray", "line", "circle", "polygon", "angle", "arc"];
export function validateGeometry(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t", "u"], GEOMETRY_FNS);
  k.defs(c.defs);
  if (c.view !== undefined) {
    if (!isObj(c.view)) k.add("view: must be { x: [min, max], y: [min, max] }");
    else {
      vec2(k, c.view.x, "view.x");
      vec2(k, c.view.y, "view.y");
    }
  }
  const pts = Array.isArray(c.points) ? c.points : [];
  if (!pts.length || pts.length > 16) k.add("points: 1–16 named points are required");
  const names: string[] = [];
  pts.forEach((p, i) => {
    if (!isObj(p)) return k.add(`points[${i}]: must be { name, x, y }`);
    const nm = String(p.name ?? "");
    if (!/^[A-Za-z_]\w*$/.test(nm)) k.add(`points[${i}].name: must be a simple name`);
    const visible = names.flatMap((n) => [n, `${n}_x`, `${n}_y`]);
    k.expr(p.x, `points[${i}].x`, visible);
    k.expr(p.y, `points[${i}].y`, visible);
    k.color(p.color, `points[${i}]`);
    names.push(nm);
  });
  const all = names.flatMap((n) => [n, `${n}_x`, `${n}_y`]);
  const isPt = (v: unknown) => typeof v === "string" && names.includes(v);
  (Array.isArray(c.shapes) ? c.shapes : []).forEach((sh, i) => {
    const w = `shapes[${i}]`;
    if (!isObj(sh) || !SHAPES.includes(sh.kind as string)) return k.add(`${w}.kind: must be one of ${SHAPES.join(", ")}`);
    k.color(sh.color, w);
    if (sh.kind === "segment" || sh.kind === "ray" || sh.kind === "line") {
      if (!isPt(sh.from) || !isPt(sh.to)) k.add(`${w}: from/to must name points`);
    } else if (sh.kind === "circle") {
      if (!isPt(sh.center)) k.add(`${w}.center: must name a point`);
      k.expr(sh.r, `${w}.r`, all);
    } else if (sh.kind === "polygon") {
      if (!Array.isArray(sh.points) || sh.points.length < 2 || !sh.points.every(isPt)) k.add(`${w}.points: 2+ point names`);
    } else if (sh.kind === "angle") {
      if (!isPt(sh.at) || !isPt(sh.from) || !isPt(sh.to)) k.add(`${w}: at/from/to must name points`);
    } else if (sh.kind === "arc") {
      if (!isPt(sh.center)) k.add(`${w}.center: must name a point`);
      for (const f of ["r", "from", "to"]) k.expr(sh[f], `${w}.${f}`, all);
    }
  });
  k.readouts(c.readouts, spec, all);
  return k.problems;
}

export function validateSequence(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"]);
  k.defs(c.defs);
  const vars: string[] = [];
  if (c.state !== undefined) {
    if (!isObj(c.state)) k.add("state: must be { name: initial value }");
    else
      for (const [v, e] of Object.entries(c.state)) {
        if (!/^[A-Za-z_]\w*$/.test(v)) k.add(`state: "${v}" is not a valid name`);
        k.expr(e, `state.${v}`);
        vars.push(v);
      }
  }
  if (c.next !== undefined) {
    if (!isObj(c.next)) k.add("next: must be { name: update expression }");
    else
      for (const [v, e] of Object.entries(c.next)) {
        if (!vars.includes(v)) k.add(`next: "${v}" is not a state variable`);
        k.expr(e, `next.${v}`, [...vars, "n"]);
      }
  }
  if (!vars.length && c.term === undefined) k.add("term (explicit, in n) or state + next (a recurrence) is required");
  k.optExpr(c.term, "term", [...vars, "n"]);
  k.expr(c.n, "n");
  if (c.show !== undefined && !["terms", "sum", "both"].includes(c.show as string)) k.add("show: terms | sum | both");
  k.optExpr(c.limit, "limit");
  if (c.table !== undefined) {
    if (!isObj(c.table) || !Array.isArray(c.table.columns)) k.add("table: must be { columns: [...], rows? }");
    else for (const col of c.table.columns) if (![...vars, "n", "term", "S"].includes(col as string)) k.add(`table.columns: "${String(col)}" must be n, term, S or a state variable`);
  }
  k.optExpr(c.speed, "speed");
  k.readouts(c.readouts, spec, [...vars, "n", "N", "term", "S", "S_N", "term_N", "limit"]);
  return k.problems;
}

export function validateCellGrid(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t", "k", "steps"], CELL_FNS);
  k.defs(c.defs);
  const rows = Array.isArray(c.rows) ? c.rows : [];
  if (!rows.length || rows.length > 4) k.add("rows: 1–4 rows are required");
  rows.forEach((r, i) => {
    const w = `rows[${i}]`;
    if (!isObj(r)) return k.add(`${w}: must be an object`);
    k.expr(r.n, `${w}.n`);
    k.expr(r.value, `${w}.value`, ["i"]);
    k.optExpr(r.style, `${w}.style`, ["i"]);
    k.optExpr(r.index, `${w}.index`, ["i"]);
    (Array.isArray(r.groups) ? r.groups : []).forEach((g, j) => {
      if (!isObj(g) || typeof g.label !== "string") return k.add(`${w}.groups[${j}]: must be { from, to, label }`);
      k.expr(g.from, `${w}.groups[${j}].from`);
      k.expr(g.to, `${w}.groups[${j}].to`);
      k.color(g.color, `${w}.groups[${j}]`);
    });
  });
  (Array.isArray(c.pointers) ? c.pointers : []).forEach((p, i) => {
    if (!isObj(p) || typeof p.label !== "string") return k.add(`pointers[${i}]: must be { at, label, row? }`);
    k.expr(p.at, `pointers[${i}].at`);
    k.color(p.color, `pointers[${i}]`);
  });
  k.optExpr(c.steps, "steps");
  k.optExpr(c.speed, "speed");
  if (c.message !== undefined) {
    if (typeof c.message !== "string") k.add("message: must be a string with {expr} parts");
    else for (const m of c.message.matchAll(/\{([^}]+)\}/g)) k.expr(m[1], "message");
  }
  k.readouts(c.readouts, spec);
  return k.problems;
}

export function validateDataStructure(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"]);
  k.defs(c.defs);
  if (!STRUCTURES.includes(c.kind as Structure)) k.add(`kind: must be one of ${STRUCTURES.join(", ")}`);
  const ops = Array.isArray(c.ops) ? c.ops : [];
  if (!ops.length || ops.length > 24) k.add("ops: 1–24 operations are required");
  const allowed: Record<string, string[]> = {
    stack: ["push", "pop", "search"],
    queue: ["enqueue", "dequeue", "search"],
    "linked-list": ["insert", "delete", "search"],
    bst: ["insert", "delete", "search"],
    "min-heap": ["insert", "pop"],
    "hash-table": ["insert", "delete", "search"],
  };
  ops.forEach((o, i) => {
    if (!isObj(o)) return k.add(`ops[${i}]: must be { op, value? }`);
    const ok = allowed[c.kind as string] ?? STRUCTURE_OPS;
    if (!ok.includes(o.op as string)) k.add(`ops[${i}].op: ${String(c.kind)} supports ${ok.join(", ")}`);
    if (o.op !== "pop" && o.op !== "dequeue") k.expr(o.value, `ops[${i}].value`);
  });
  k.optExpr(c.buckets, "buckets");
  k.optExpr(c.hash, "hash", ["key", "m"]);
  k.optExpr(c.speed, "speed");
  k.readouts(c.readouts, spec, ["step", "steps", "size", "comparisons", "height", "collisions", "maxChain", "found", "top", "done"]);
  return k.problems;
}

// ---------------------------------------------------------------------------
// Docs (what the planner reads; keep them short and exact)
// ---------------------------------------------------------------------------

const EXPR_NOTE = `Expressions are strings over param ids (controls/presets/beat params), defs and the template's variables: + - * / % ^, comparisons, && || !, c ? a : b, if(c,a,b), and sin cos tan exp ln log10 sqrt abs min max floor round clamp hypot atan2 pow, constants pi e. Select params compare as strings: mode == 'fall'. defs: { name: expr } computed in order. readouts: { readoutId: expr | { expr, digits?, unit? } } — one per spec readout.`;

export const DOCS = {
  "function-plot": {
    when: "y = f(x) relations: curves vs a variable, a schedule or law over a range, how a parameter reshapes a curve, comparing up to 4 curves, a moving marker reading values off curves.",
    configDoc: `{ defs?, x: { min, max, label?, log? }, y?: { min?, max?, label?, log? } (auto when omitted), curves: [{ y: "expr in x", label?, color?: accent|accent2|fg|muted, dashed?, fill? }] (1–4), marker?: { x: Num, label? } (vertical line + dots; readouts see mx and y1..y4 = curve values at mx), sweep?: { seconds? } (animates u from 0→1; use u in marker.x), points?: [{ x, y, label? }], readouts }. Variables: x (curves), t, u. ${EXPR_NOTE}`,
    example: {
      defs: { peak: "d^-0.5 * w^-0.5" },
      x: { min: 1, max: 20000, label: "step" },
      y: { min: 0, label: "lr" },
      curves: [{ y: "d^-0.5 * min(x^-0.5, x * w^-1.5)", label: "lr", color: "accent" }],
      marker: { x: "w" },
      readouts: { peak: { expr: "y1", digits: 5 }, at: "mx" },
    },
  },
  "ode-sim": {
    when: "motion or change over time from a differential equation: falling bodies, projectiles, springs, pendulums, orbits, growth/decay, energy bookkeeping (T, U, T+U), Euler-vs-exact stepping.",
    configDoc: `{ defs?, state: { var: initial } , deriv: { var: "d(var)/dt expr" } (RK4), dt? (0.005), speed? (sim s per real s, 1), tMax? (restart after), stop?: "expr" (hold 1.5 s then restart when true, e.g. "y < 0"), scene?: { x: [min,max], y: [min,max], equal?, ground?: y, bodies?: [{ x: expr, y: expr, label?, r? px, trail?, color? }], links?: [{ x1,y1,x2,y2, kind?: line|spring, dashed? }], arrows?: [{ x,y,dx,dy, label?, color? }] }, plot?: { y: [{ expr, label?, color?, dashed? }], min?, max?, span? s }, readouts }. Variables: state vars, t. With both scene and plot they are drawn side by side. Expressions, defs, readouts: as in function-plot.`,
    example: {
      state: { y: "h", v: 0 },
      deriv: { y: "v", v: "-g" },
      stop: "y < 0",
      scene: { x: [-1, 1], y: [0, "h * 1.1"], ground: 0, bodies: [{ x: 0, y: "max(y, 0)", label: "m", trail: true }] },
      plot: { y: [{ expr: "0.5*m*v^2", label: "T", color: "accent" }, { expr: "m*g*y", label: "U", color: "accent2" }, { expr: "0.5*m*v^2 + m*g*y", label: "T+U", color: "fg", dashed: true }] },
      readouts: { T: "0.5*m*v^2", U: "m*g*y", E: "0.5*m*v^2 + m*g*y" },
    },
  },
  "vector-diagram": {
    when: "2-D vectors: components, sums and differences, dot/cross products, projections, angles, rotations of a vector by a parameter.",
    configDoc: `{ defs?, range: half-width in units, vectors: [{ name, x: expr, y: expr, from?: earlierName (tail at its head) | [x, y], label?, color?, dashed? }] (1–6; later vectors may use earlier ones), angle?: [a, b] (arc between), projection?: { of, onto }, grid?, readouts }. Each vector name is a value [x, y] and gives name_x, name_y, name_len, name_ang (degrees). Extra functions: dot(a,b), cross(a,b), norm(a), angle(a,b) (degrees). Variables: t. Expressions, defs, readouts: as in function-plot.`,
    example: {
      range: 5,
      vectors: [
        { name: "a", x: "ax", y: "ay", label: "a", color: "accent" },
        { name: "b", x: "bx", y: "by", label: "b", color: "accent2" },
        { name: "s", x: "a_x + b_x", y: "a_y + b_y", label: "a+b", color: "fg", dashed: true },
      ],
      angle: ["a", "b"],
      readouts: { dot: "dot(a, b)", ang: { expr: "angle(a, b)", digits: 1, unit: "°" } },
    },
  },
  "matrix-ops": {
    when: "small matrix computations shown as heatmaps: attention (QKᵀ, scaling, masking, softmax, ·V), linear layers, transposes, normalisation — with seeded random inputs and token labels.",
    configDoc: `{ seed?, labels?: { rows?: string[], cols?: string[] } (token names), inputs: { Name: { rows, cols, init?: random|identity|zeros|ones|causal|"expr in i,j", std?, values?: number[][] } }, steps: [{ name, op: matmul|transpose|scale|softmax|mask|add|relu|layernorm|map, a, b? (matmul/add), by? (scale), expr? (map: v,i,j; mask: keep-condition in i,j, default causal j<=i), label? }], show: [names to draw, in order], highlightRow?: Num, values?: show numbers in cells, readouts }. Matrices are values; functions: get(M,i,j), rowsum(M,i), rowmax(M,i), rowmin(M,i), argmax(M,i), entropy(M,i), var(M), rows(M), cols(M). Expressions, defs, readouts: as in function-plot.`,
    example: {
      seed: 7,
      labels: { rows: ["the", "cat", "sat", "on"], cols: ["the", "cat", "sat", "on"] },
      inputs: { Q: { rows: 4, cols: "dk" }, K: { rows: 4, cols: "dk" }, V: { rows: 4, cols: 4 } },
      steps: [
        { name: "Kt", op: "transpose", a: "K" },
        { name: "S", op: "matmul", a: "Q", b: "Kt", label: "QKᵀ" },
        { name: "Ss", op: "scale", a: "S", by: "scaled ? 1/sqrt(dk) : 1", label: "÷√dk" },
        { name: "A", op: "softmax", a: "Ss", label: "softmax" },
        { name: "O", op: "matmul", a: "A", b: "V", label: "A·V" },
      ],
      show: ["Ss", "A", "O"],
      highlightRow: "row",
      readouts: { rowsum: { expr: "rowsum(A, row)", digits: 3 }, peak: { expr: "rowmax(A, row)", digits: 3 }, spread: { expr: "var(Ss)", digits: 2 } },
    },
  },
  "sim-histogram": {
    when: "chance and statistics: repeated random trials (coins, dice, sums, random walks, sampling) building a histogram that approaches an expected distribution; law of large numbers.",
    configDoc: `{ seed?, trial: "expr per trial" (random: rand() uniform 0–1, randn() normal, randint(a,b) inclusive, coin(p) 0/1; repeat(n, expr) sums n draws), trials: total, perSecond? (animation rate), bins?: "integer" | { min, max, count? } (integer when values are whole), expected?: "expr in x" (probability per integer x, or density for continuous bins) drawn as a line, xLabel?, readouts }. Variables: n (trials so far), mean, sd, last; frac(lo, hi) = share of results in [lo, hi] — these change while trials accumulate, so never use them in expect (expect only param-derived readouts like k*p). Expressions, defs, readouts: as in function-plot.`,
    example: {
      seed: 3,
      trial: "repeat(k, coin(p))",
      trials: 2000,
      bins: "integer",
      expected: "choose(k, x) * p^x * (1-p)^(k-x)",
      xLabel: "heads",
      readouts: { n: "n", mean: { expr: "mean", digits: 2 }, theory: { expr: "k*p", digits: 2 } },
    },
  },
  "table-bars": {
    when: "comparing a few cases by formulas: complexity per layer type, costs per strategy, values of a law for several inputs — a small table with computed columns and a bar chart of one column.",
    configDoc: `{ defs?, rows: [{ label, vars?: { name: Num } }] (1–10), columns: [{ id, label, expr (row vars, params, row = index), digits?, unit? }] (1–5), bar?: { column: id, log? }, highlight?: row index Num, readouts }. Functions: cell(row, 'colId'), col('colId') (array). Expressions, defs, readouts: as in function-plot.`,
    example: {
      rows: [
        { label: "self-attention", vars: { ops: "n^2*d", path: 1 } },
        { label: "recurrent", vars: { ops: "n*d^2", path: "n" } },
        { label: "convolutional", vars: { ops: "k*n*d^2", path: "log(n)/log(k)" } },
      ],
      columns: [
        { id: "ops", label: "operations", expr: "ops" },
        { id: "path", label: "max path", expr: "path", digits: 1 },
      ],
      bar: { column: "ops", log: true },
      readouts: { ratio: { expr: "cell(1,'ops') / cell(0,'ops')", digits: 2 } },
    },
  },
  "algorithm-steps": {
    when: `step-through of a classic algorithm on a small input: ${ALGORITHMS.join(", ")} — cells/pointers or a small graph, the code line being executed, and counters.`,
    configDoc: `{ algorithm: ${ALGORITHMS.join("|")}, array?: number[] (2–16) | { n, seed?, max?, sorted? }, target? (searches, two-pointers sum), graph?: { nodes: string[] (≤12), edges: [[a,b]], start, directed? } (bfs/dfs), speed? (steps per second, default 1), code? (show pseudocode, default true), defs?, readouts }. Readout variables: step, steps, comparisons, swaps, done (0/1), found (index or -1), n, lo, hi, mid, i, j, visited, frontier. Expressions, defs, readouts: as in function-plot.`,
    example: {
      algorithm: "binary-search",
      array: { n: 15, seed: 3, sorted: true },
      target: "target",
      speed: "speed",
      readouts: { comparisons: "comparisons", bound: "ceil(log2(n + 1))", found: "found" },
    },
  },
  "calculus-plot": {
    when: "derivatives and integrals of one curve: secant → tangent, slope at a point, Riemann sums approaching an area, area under a curve, stacked s → v → a graphs.",
    configDoc: `{ defs?, f: "expr in x", x: { min, max, label? }, y?: { min?, max?, label? }, label?, at?: Num (point a; may use u), tangent?, secant?: { h: Num }, riemann?: { from, to, n, rule?: left|right|mid|trap }, area?: { from, to } (shaded), panels?: ["derivative", "integral"] (stacked below, same x; integral from x.min), sweep?: { seconds? } (u 0→1), readouts }. Readout variables: a, fa = f(a), slope = f'(a), secant = (f(a+h)−f(a))/h, h, riemann (sum), exact (∫ over the riemann range), error = riemann − exact, area (∫ over area range), n. Expressions, defs, readouts: as in function-plot.`,
    example: {
      f: "16*x^2",
      x: { min: 0, max: 6, label: "t (s)" },
      y: { label: "s (ft)" },
      at: "t0",
      tangent: true,
      secant: { h: "h" },
      readouts: { v: { expr: "slope", digits: 2, unit: "ft/s" }, avg: { expr: "secant", digits: 2, unit: "ft/s" } },
    },
  },
  "parametric-plot": {
    when: "curves x(s), y(s) or polar r(θ): orbits, ellipses, paths, cycloids, phase portraits; a moving point with its velocity, a swept sector (equal areas), a vector field.",
    configDoc: `{ defs?, view: { x: [min,max], y: [min,max], equal? (same scale), xLabel?, yLabel? }, curves: [{ x: "expr in s", y: "expr in s" } | { r: "expr in s" (polar, s = angle) }, plus s: [from, to], label?, color?, dashed?] (1–4), field?: { u: "expr in x,y", v, n? (arrows per side, 12), normalize?, color? }, point?: { curve? (index, 0), s: Num (may use u), label?, velocity? (arrow), trail?: Num (s-span drawn bold), sector?: { cx, cy, span } (shades the region swept from s−span to s around (cx, cy)) }, points?: [{ x, y, label? }], sweep?: { seconds? } (u 0→1), readouts }. Readout variables: s, px, py, vx, vy, speed, r and theta (from the origin), sector (its area), length (arc length of the point's curve up to s). Expressions, defs, readouts: as in function-plot.`,
    example: {
      defs: { b: "a*sqrt(1-e^2)", c: "a*e" },
      view: { x: [-2.2, 1.2], y: [-1.2, 1.2], equal: true },
      curves: [{ x: "a*cos(s) - c", y: "b*sin(s)", s: [0, "2*pi"], label: "orbit" }],
      point: { s: "2*pi*u", label: "P", velocity: true, sector: { cx: 0, cy: 0, span: 0.6 } },
      points: [{ x: 0, y: 0, label: "sun" }],
      sweep: { seconds: 8 },
      readouts: { area: { expr: "sector", digits: 3 }, dist: { expr: "r", digits: 2 } },
    },
  },
  geometry: {
    when: "constructions from named points: triangles, circles, chords, angles, polygons and areas, levers, force or kick polygons — points, segments and circles that move with parameters.",
    configDoc: `{ defs?, view?: { x: [min,max], y: [min,max] } (auto-fit), points: [{ name, x: Num, y: Num, label?, hidden?, color? }] (later points may use earlier ones: A, A_x, A_y), shapes?: [{ kind: segment|ray|line, from, to, label?, color?, dashed?, arrow? } | { kind: circle, center, r } | { kind: polygon, points: [names], fill? } | { kind: angle, at, from, to, label? } | { kind: arc, center, r, from, to (degrees) }], grid?, sweep?: { seconds? } (u 0→1), readouts }. A point name is a value [x, y]; functions: dist(A, B), ang(A, O, B) (degrees at O), area(A, B, C, …), mid(A, B), dir(A, B) (degrees). Expressions, defs, readouts: as in function-plot.`,
    example: {
      points: [
        { name: "A", x: 0, y: 0, label: "A" },
        { name: "B", x: 4, y: 0, label: "B" },
        { name: "C", x: "4*cos(rad(th))", y: "4*sin(rad(th))", label: "C" },
      ],
      shapes: [
        { kind: "polygon", points: ["A", "B", "C"], fill: true },
        { kind: "angle", at: "A", from: "B", to: "C", label: "θ" },
        { kind: "circle", center: "A", r: 4, dashed: true },
      ],
      readouts: { bc: { expr: "dist(B, C)", digits: 2 }, area: { expr: "area(A, B, C)", digits: 2 } },
    },
  },
  sequence: {
    when: "sequences and series: terms aₙ (explicit or a recurrence), partial sums approaching a limit, iterates of a numerical method in a table (Euler steps, Newton's method, interest, Fibonacci).",
    configDoc: `{ defs?, state?: { var: initial (n = 0) }, next?: { var: "update expr" } (applied each step; sees the current state and n), term?: "expr in n and state" (default: the first state var), n: Num (terms, ≤ 200), show?: terms|sum|both (default both), limit?: Num (dashed line), table?: { columns: [n|term|S|state vars], rows? (≤ 12) }, speed?: Num (terms per second, 2), label?, xLabel?, readouts }. Terms are revealed one by one, then the run repeats. Readout variables: n (revealed index), N, term, S (partial sum to n), state vars at n — these change while terms are revealed, so in expect use only term_N, S_N (final values), limit or param-derived readouts. Expressions, defs, readouts: as in function-plot.`,
    example: {
      term: "d * r^n",
      n: 12,
      limit: "d / (1 - r)",
      table: { columns: ["n", "term", "S"], rows: 6 },
      readouts: { sum: { expr: "S", digits: 4 }, gap: { expr: "limit - S", digits: 4 } },
    },
  },
  "cell-grid": {
    when: "rows of cells by formula: bits and bit fields (masks, shifts, two's complement), memory words (header/payload/padding), buckets, a row filled step by step with pointers.",
    configDoc: `{ defs?, rows: [{ label?, n: Num (cells, ≤ 64), value: "expr in i (and k)" (number or string), style?: "expr in i → 0 normal | 1 active | 2 muted | 3 done", index?: "expr in i" (label under; default i), groups?: [{ from, to, label, color? }] (brackets above) }] (1–4), pointers?: [{ row?, at: Num, label, color? }], steps?: Num (animate k = 0…steps−1), speed?: Num (steps per second, 1), message?: "text with {expr} parts", readouts }. Functions: bit(x, i), band(a,b), bor, bxor, bnot(x, bits), shl(x, n), shr(x, n) (integers up to 2^53), hex(x), bin(x, width), str(x), pad(s, width). Variables: k, steps, t (with steps, values that depend on k change over time — keep them out of expect). Expressions, defs, readouts: as in function-plot.`,
    example: {
      defs: { word: "bor(size, alloc)" },
      rows: [{ label: "header (low 8 bits)", n: 8, value: "bit(word, 7 - i)", style: "7 - i < 3 ? 1 : 0", index: "7 - i", groups: [{ from: 0, to: 4, label: "size" }, { from: 5, to: 7, label: "flags" }] }],
      message: "header = {hex(word)}",
      readouts: { header: "hex(word)", size: "band(word, bnot(7, 16))" },
    },
  },
  "data-structure": {
    when: "a data structure under a list of operations: stack, queue, sorted linked list, binary search tree, min-heap (sift up/down), hash table with chaining (collisions, load factor).",
    configDoc: `{ defs?, kind: ${STRUCTURES.join("|")}, ops: [{ op: push|pop|enqueue|dequeue|insert|delete|search, value?: Num }] (1–24; stack push/pop/search, queue enqueue/dequeue/search, min-heap insert/pop, others insert/delete/search), buckets?: Num (hash-table, 7), hash?: "expr in key, m" (default key mod m), speed?: Num (steps per second, 1), code? (show the operation's pseudocode, default true), readouts }. Readout variables: step, steps, size, comparisons, height (bst/heap), collisions, maxChain (hash-table), found (1/0 for the last search), top (top/front/min value), done — they change as the steps play, so never use them in expect. Expressions, defs, readouts: as in function-plot.`,
    example: {
      kind: "bst",
      ops: [{ op: "insert", value: 50 }, { op: "insert", value: 30 }, { op: "insert", value: 70 }, { op: "insert", value: 20 }, { op: "insert", value: 40 }, { op: "search", value: 40 }],
      readouts: { height: "height", cmp: "comparisons" },
    },
  },
} as const;
