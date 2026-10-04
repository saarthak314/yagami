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
    configDoc: `{ defs?, state: { var: initial } , deriv: { var: "d(var)/dt expr" } (RK4), dt? (0.005), speed? (sim s per real s, 1), tMax? (restart after), stop?: "expr" (hold 1.5 s then restart when true, e.g. "y < 0"), scene?: { x: [min,max], y: [min,max], equal?, ground?: y, bodies?: [{ x: expr, y: expr, label?, r? px, trail?, color? }], links?: [{ x1,y1,x2,y2, kind?: line|spring, dashed? }], arrows?: [{ x,y,dx,dy, label?, color? }] }, plot?: { y: [{ expr, label?, color?, dashed? }], min?, max?, span? s }, readouts }. Variables: state vars, t. With both scene and plot they are drawn side by side. ${EXPR_NOTE}`,
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
    configDoc: `{ defs?, range: half-width in units, vectors: [{ name, x: expr, y: expr, from?: earlierName (tail at its head) | [x, y], label?, color?, dashed? }] (1–6; later vectors may use earlier ones), angle?: [a, b] (arc between), projection?: { of, onto }, grid?, readouts }. Each vector name is a value [x, y] and gives name_x, name_y, name_len, name_ang (degrees). Extra functions: dot(a,b), cross(a,b), norm(a), angle(a,b) (degrees). Variables: t. ${EXPR_NOTE}`,
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
    configDoc: `{ seed?, labels?: { rows?: string[], cols?: string[] } (token names), inputs: { Name: { rows, cols, init?: random|identity|zeros|ones|causal|"expr in i,j", std?, values?: number[][] } }, steps: [{ name, op: matmul|transpose|scale|softmax|mask|add|relu|layernorm|map, a, b? (matmul/add), by? (scale), expr? (map: v,i,j; mask: keep-condition in i,j, default causal j<=i), label? }], show: [names to draw, in order], highlightRow?: Num, values?: show numbers in cells, readouts }. Matrices are values; functions: get(M,i,j), rowsum(M,i), rowmax(M,i), rowmin(M,i), argmax(M,i), entropy(M,i), var(M), rows(M), cols(M). ${EXPR_NOTE}`,
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
    configDoc: `{ seed?, trial: "expr per trial" (random: rand() uniform 0–1, randn() normal, randint(a,b) inclusive, coin(p) 0/1; repeat(n, expr) sums n draws), trials: total, perSecond? (animation rate), bins?: "integer" | { min, max, count? } (integer when values are whole), expected?: "expr in x" (probability per integer x, or density for continuous bins) drawn as a line, xLabel?, readouts }. Variables: n (trials so far), mean, sd, last; frac(lo, hi) = share of results in [lo, hi] — these change while trials accumulate, so never use them in expect (expect only param-derived readouts like k*p). ${EXPR_NOTE}`,
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
    configDoc: `{ defs?, rows: [{ label, vars?: { name: Num } }] (1–10), columns: [{ id, label, expr (row vars, params, row = index), digits?, unit? }] (1–5), bar?: { column: id, log? }, highlight?: row index Num, readouts }. Functions: cell(row, 'colId'), col('colId') (array). ${EXPR_NOTE}`,
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
    configDoc: `{ algorithm: ${ALGORITHMS.join("|")}, array?: number[] (2–16) | { n, seed?, max?, sorted? }, target? (searches, two-pointers sum), graph?: { nodes: string[] (≤12), edges: [[a,b]], start, directed? } (bfs/dfs), speed? (steps per second, default 1), code? (show pseudocode, default true), defs?, readouts }. Readout variables: step, steps, comparisons, swaps, done (0/1), found (index or -1), n, lo, hi, mid, i, j, visited, frontier. ${EXPR_NOTE}`,
    example: {
      algorithm: "binary-search",
      array: { n: 15, seed: 3, sorted: true },
      target: "target",
      speed: "speed",
      readouts: { comparisons: "comparisons", bound: "ceil(log2(n + 1))", found: "found" },
    },
  },
} as const;
