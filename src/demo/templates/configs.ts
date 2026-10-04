// Template configs: types, validation and the compact docs the planner reads.
// Pure TypeScript (no DOM/React) so the Node pipeline can import it through catalog.ts.

import type { DemoSpec } from "../../types";
import { BUILTIN_FUNCTIONS, checkExpr, evalNum, tryCompile, type Env, type Value } from "./expr";
import { PROTOCOLS, PROTOCOL_EVENTS, PROTOCOL_VARS, SEQ_COMMON_VARS, runProtocol, type MsgEvent, type Protocol, type SeqSetup } from "./protocol";
import { HASH_VARS, runHashChain, type HashSetup } from "./hashing";
import { MACHINE_VARS, opsProblem, runMachine, type MachineSetup, type Transition } from "./machine";
import { MARKOV_FNS, MARKOV_VARS, runMarkov, type MarkovRun } from "./markov";

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
  trial?: string;
  process?: { init: Record<string, Num>; step: Record<string, string>; until?: string; maxSteps?: Num; result: string };
  categories?: string[];
  trials: Num;
  perSecond?: number;
  bins?: { min: Num; max: Num; count?: number; log?: boolean } | "integer";
  expected?: string;
  xLabel?: string;
}

export interface TableBarsConfig extends Common {
  rows: { label: string; vars?: Record<string, Num> }[];
  columns: { id: string; label: string; expr: string; digits?: number; unit?: string }[];
  bar?: { column: string; log?: boolean };
  highlight?: Num;
}

export const ALGORITHMS = ["binary-search", "linear-search", "insertion-sort", "bubble-sort", "selection-sort", "merge-sort", "bfs", "dfs", "two-pointers", "fold"] as const;
export type Algorithm = (typeof ALGORITHMS)[number];
export interface AlgorithmStepsConfig extends Common {
  algorithm: Algorithm;
  array?: number[] | { n: Num; seed?: number; max?: number; sorted?: boolean };
  target?: Num;
  graph?: { nodes: string[]; edges: [string, string][]; start: string; directed?: boolean };
  speed?: Num;
  /** false hides the code panel; lines replace the built-in listing. */
  code?: boolean | string[];
  /** fold: acc = step(acc, x) over the input, left to right (e.g. a string hash). */
  fold?: { input: string | number[]; init: Num; step: string; name?: string; lines?: [number, number, number] };
}

/** Functions the fold step may use (32-bit wrap-around like Java/C ints). */
export const FOLD_FNS = ["int32", "uint32"];
const wrap32 = (v: Value) => ((Math.trunc(Number(v)) % 2 ** 32) + 2 ** 32) % 2 ** 32;
export const FOLD_ENV: Env = { int32: (v) => (wrap32(v) >= 2 ** 31 ? wrap32(v) - 2 ** 32 : wrap32(v)), uint32: (v) => wrap32(v) };

/** fold: the input as numbers (character codes for a string) and the accumulator after each element. */
export function foldRun(f: NonNullable<AlgorithmStepsConfig["fold"]>, env: Env): { xs: number[]; chars: string[]; accs: number[] } {
  const chars = typeof f.input === "string" ? [...f.input].slice(0, 16) : f.input.slice(0, 16).map(String);
  const xs = typeof f.input === "string" ? chars.map((ch) => ch.codePointAt(0) ?? 0) : f.input.slice(0, 16);
  const init = typeof f.init === "number" ? f.init : tryCompile(f.init);
  const step = tryCompile(f.step);
  const e: Env = { ...env, ...FOLD_ENV, n: xs.length };
  const accs = [typeof init === "string" ? NaN : evalNum(init, e)];
  xs.forEach((x, i) => accs.push(typeof step === "string" ? NaN : evalNum(step, { ...e, acc: accs[i], x, i, ch: chars[i] })));
  return { xs, chars, accs };
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
const RANDOM_FNS_ALL = [...RANDOM_FNS, "exprand", "pareto", "lognormal", "powerlaw"];
export function validateSimHistogram(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], [...RANDOM_FNS_ALL, "frac"]);
  k.defs(c.defs);
  if (isObj(c.process)) {
    const p = c.process;
    const names = isObj(p.init) ? Object.keys(p.init) : [];
    if (!isObj(p.init) || !names.length) k.add("process.init: { variable: start value }");
    else for (const [n, v] of Object.entries(p.init)) k.expr(v, `process.init.${n}`, [...names, "k"]);
    if (!isObj(p.step) || !Object.keys(p.step).length) k.add("process.step: { variable: expr for its next value }");
    else for (const [n, v] of Object.entries(p.step)) {
      if (!names.includes(n)) k.add(`process.step.${n}: not a variable of process.init`);
      k.expr(v, `process.step.${n}`, [...names, "k"]);
    }
    k.optExpr(p.until, "process.until", [...names, "k"]);
    k.optExpr(p.maxSteps, "process.maxSteps");
    k.expr(p.result, "process.result", [...names, "k"]);
    if (c.trial !== undefined) k.add("trial: give trial or process, not both");
  } else k.expr(c.trial, "trial");
  k.expr(c.trials, "trials");
  if (c.categories !== undefined && !(Array.isArray(c.categories) && c.categories.length >= 2 && c.categories.length <= 12 && c.categories.every((x) => typeof x === "string")))
    k.add("categories: 2–12 names (results are their indices 0, 1, …)");
  if (c.bins !== undefined && c.bins !== "integer") {
    if (!isObj(c.bins)) k.add('bins: must be "integer" or { min, max, count?, log? }');
    else {
      k.expr(c.bins.min, "bins.min");
      k.expr(c.bins.max, "bins.max");
      if (c.bins.log && !(typeof c.bins.min !== "number" || c.bins.min > 0)) k.add("bins.min: must be > 0 with log bins");
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
  const k = base(spec, ["t"], FOLD_FNS);
  k.defs(c.defs);
  const alg = c.algorithm as Algorithm;
  if (!ALGORITHMS.includes(alg)) k.add(`algorithm: must be one of ${ALGORITHMS.join(", ")}`);
  const graphAlg = alg === "bfs" || alg === "dfs";
  if (c.code !== undefined && typeof c.code !== "boolean" && !(Array.isArray(c.code) && c.code.length >= 1 && c.code.length <= 14 && c.code.every((l) => typeof l === "string")))
    k.add("code: true/false, or 1–14 code lines");
  if (alg === "fold") {
    const f = c.fold;
    if (!isObj(f)) k.add("fold: { input, init, step } is required");
    else {
      const inp = f.input;
      if (!((typeof inp === "string" && inp.length >= 1 && inp.length <= 16) || (Array.isArray(inp) && inp.length >= 1 && inp.length <= 16 && inp.every((x) => typeof x === "number")))) k.add("fold.input: a string or 1–16 numbers");
      k.expr(f.init, "fold.init");
      k.expr(f.step, "fold.step", ["acc", "x", "i", "n", "ch"]);
      const n = Array.isArray(c.code) ? c.code.length : 4;
      if (f.lines !== undefined && !(Array.isArray(f.lines) && f.lines.length === 3 && f.lines.every((l) => Number.isInteger(l) && (l as number) >= 0 && (l as number) < n))) k.add(`fold.lines: [init, update, return] line indices < ${n}`);
    }
  } else if (graphAlg) {
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
  const vars = ["step", "steps", "comparisons", "swaps", "done", "found", "n", "lo", "hi", "mid", "i", "j", "visited", "frontier", "acc", "x", "result"];
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

export const STRUCTURES = ["stack", "queue", "linked-list", "bst", "min-heap", "hash-table", "open-addressing"] as const;
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
    "open-addressing": ["insert", "delete", "search"],
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
  k.readouts(c.readouts, spec, ["step", "steps", "size", "comparisons", "height", "collisions", "maxChain", "found", "top", "done", "probes", "runLength", "dels", "load"]);
  return k.problems;
}

// ---------------------------------------------------------------------------
// heap-allocator, attention-heads, layer-stack
// ---------------------------------------------------------------------------

export const FIT_POLICIES = ["first", "next", "best"] as const;
export type FitPolicy = (typeof FIT_POLICIES)[number];
export type HeapRequest = { op: "malloc"; size: Num; id?: string } | { op: "free"; id: string };
export interface HeapTraceGen {
  /** Number of requests to generate. */
  requests: Num;
  seed?: number;
  /** Size of each malloc: expression (rand(), randint(a,b), pareto(a, xmin), …). */
  size: string;
  /** Probability that a request frees a random live block instead (default 0.4). */
  free?: Num;
}
export interface HeapAllocatorConfig extends Common {
  heap?: Num;
  max?: Num;
  align?: Num;
  header?: Num;
  footer?: Num;
  policy?: Num;
  compare?: FitPolicy[];
  list?: Num;
  insert?: Num;
  coalesce?: Num;
  split?: Num;
  trace: HeapRequest[] | HeapTraceGen;
  chart?: "examined" | "utilization" | "heap";
  speed?: Num;
  code?: boolean;
}

export interface AttentionHeadsConfig extends Common {
  seed?: number;
  tokens: string[];
  memory?: string[];
  dModel?: Num;
  heads?: Num;
  causal?: Num;
  scale?: Num;
  temperature?: Num;
  focus?: Num;
  view?: "heatmaps" | "arcs";
}

// --- Deterministic derived values (shared by the components and by validation) -------------------
// Values a template derives from its config without randomness or time; validation evaluates them at
// each beat's params so a spec's `expect` can be checked before anything renders.

/** An integer config field (expression or number), clamped like the component clamps it. */
function staticInt(f: Num | undefined, env: Env, d: number, lo: number, hi: number): number {
  const c = f === undefined ? undefined : typeof f === "number" ? f : tryCompile(f);
  const x = c === undefined || typeof c === "string" ? d : evalNum(c, env);
  return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : d)));
}

/** attention-heads: sizes and operation counts (the toy model keeps dModel ≤ 64, heads ≤ 8). */
export function attentionHeadsStatic(config: AttentionHeadsConfig, env: Env) {
  const tokens = (config.tokens ?? []).slice(0, 10);
  const keys = config.memory?.length ? config.memory.slice(0, 10) : tokens;
  const n = tokens.length;
  const m = keys.length;
  const dModel = staticInt(config.dModel, env, 8, 2, 64);
  const h = Math.min(staticInt(config.heads, env, 2, 1, 8), dModel);
  const dk = Math.max(1, Math.floor(dModel / h));
  return { n, m, h, dk, dModel, projOps: 2 * n * dModel * dModel + 2 * m * dModel * dModel, scoreOps: h * n * m * dk, params: 4 * dModel * dModel };
}

/** layer-stack: sizes and parameter counts (dModel ≤ 64, dff ≤ 256, layers ≤ 8, heads ≤ 8). */
export function layerStackStatic(config: LayerStackConfig, env: Env) {
  const n = (config.tokens ?? []).slice(0, 10).length;
  const d = staticInt(config.dModel, env, 16, 4, 64);
  const dff = staticInt(config.dff, env, 4 * d, 4, 256);
  const L = staticInt(config.layers, env, 1, 1, 8);
  const h = Math.min(staticInt(config.heads, env, 2, 1, 8), d);
  const dk = Math.max(1, Math.floor(d / h));
  const subs: Sublayer[] = config.sublayers?.length ? config.sublayers : ["attention", "ffn"];
  const perLayer = subs.reduce((a, sub) => a + (sub === "ffn" ? 2 * d * dff + dff + d : 4 * d * d), 0);
  return { n, d, dff, L, h, dk, subs, perLayer, vars: { n, dModel: d, dff, dk, layers: L, params: perLayer, paramsTotal: perLayer * L } };
}

/** Per template: derived values readouts may use, computable at validation time. */
export const STATIC_VARS: Record<string, (config: never, env: Env) => Env> = {
  "attention-heads": (config: AttentionHeadsConfig, env: Env) => {
    const v = attentionHeadsStatic(config, env);
    return { n: v.n, m: v.m, h: v.h, dk: v.dk, dModel: v.dModel, projOps: v.projOps, scoreOps: v.scoreOps, params: v.params };
  },
  "layer-stack": (config: LayerStackConfig, env: Env) => layerStackStatic(config, env).vars,
  "algorithm-steps": (config: AlgorithmStepsConfig, env: Env) => (config.algorithm === "fold" && config.fold ? { result: foldRun(config.fold, env).accs.at(-1)! } : {}),
  "message-sequence": (config: MessageSequenceConfig, env: Env) => {
    const steps = runProtocol(seqSetup(config, env));
    return finals({ ...steps[steps.length - 1].vars, steps: steps.length });
  },
  "hash-chain": (config: HashChainConfig, env: Env) => {
    const steps = runHashChain(hashSetup(config, env));
    return finals({ ...steps[steps.length - 1].vars, steps: steps.length });
  },
  "state-machine": (config: StateMachineConfig, env: Env) => {
    const steps = runMachine(machineSetup(config, env));
    return finals({ ...steps[steps.length - 1].vars, steps: steps.length });
  },
  "markov-chain": (config: MarkovChainConfig, env: Env) => {
    const f = markovFns(markovRun(config, env), 0);
    return { stat: f.stat, absorb: f.absorb, hit: f.hit, prob: f.prob, walkers: f.walkers, expDuration: f.expDuration, duration: f.duration };
  },
};

export type Sublayer = "attention" | "cross" | "ffn";
export interface LayerStackConfig extends Common {
  seed?: number;
  tokens: string[];
  dModel?: Num;
  dff?: Num;
  layers?: Num;
  sublayers?: Sublayer[];
  heads?: Num;
  residual?: Num;
  norm?: Num;
  embedScale?: Num;
  posenc?: Num;
  dropout?: Num;
  focus?: Num;
  speed?: Num;
}

export const SAMPLER_FNS = ["exprand", "pareto", "lognormal", "powerlaw"];
export const HEAP_VARS = ["step", "steps", "done", "request", "requests", "examined", "last", "heap", "live", "peak", "util", "internal", "freeBlocks", "largestFree", "failed", "total_examined", "final_heap", "final_util", "final_peak", "total_failed"];
const tokenList = (k: Checker, v: unknown, where: string, min = 2, max = 10) => {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every((x) => typeof x === "string")) k.add(`${where}: ${min}–${max} token strings are required`);
};

export function validateHeapAllocator(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ["t"], [...RANDOM_FNS_ALL]);
  k.defs(c.defs);
  for (const f of ["heap", "max", "align", "header", "footer", "policy", "list", "insert", "coalesce", "split", "speed"]) k.optExpr(c[f], f);
  if (c.compare !== undefined && !(Array.isArray(c.compare) && c.compare.length >= 1 && c.compare.length <= 3 && c.compare.every((p) => FIT_POLICIES.includes(p as FitPolicy))))
    k.add(`compare: a list of 1–3 policies from ${FIT_POLICIES.join(", ")}`);
  if (Array.isArray(c.trace)) {
    if (!c.trace.length || c.trace.length > 40) k.add("trace: 1–40 requests are required");
    const ids = new Set<string>();
    c.trace.forEach((r, i) => {
      if (!isObj(r)) return k.add(`trace[${i}]: must be { op: malloc, size, id? } or { op: free, id }`);
      if (r.op === "malloc") {
        k.expr(r.size, `trace[${i}].size`);
        ids.add(typeof r.id === "string" ? r.id : String.fromCharCode(97 + (ids.size % 26)));
      } else if (r.op === "free") {
        if (typeof r.id !== "string" || !ids.has(r.id)) k.add(`trace[${i}].id: free must name an earlier malloc id (have: ${[...ids].join(", ") || "none"})`);
      } else k.add(`trace[${i}].op: must be malloc or free`);
    });
  } else if (isObj(c.trace)) {
    k.expr(c.trace.requests, "trace.requests");
    k.expr(c.trace.size, "trace.size");
    k.optExpr(c.trace.free, "trace.free");
  } else k.add("trace: a list of requests or { requests, size, free?, seed? } is required");
  if (c.chart !== undefined && !["examined", "utilization", "heap"].includes(c.chart as string)) k.add("chart: examined | utilization | heap");
  const policies = Array.isArray(c.compare) ? (c.compare as string[]) : [];
  const vars = [...HEAP_VARS, ...policies.flatMap((p) => HEAP_VARS.map((v) => `${v}_${p}`))];
  k.readouts(c.readouts, spec, vars);
  return k.problems;
}

export const ATTENTION_FNS = ["weight", "entropy", "maxw", "argmaxw", "rowsum"];
export const ATTENTION_VARS = ["n", "m", "h", "dk", "dModel", "focus", "meanEntropy", "diversity", "rawVar", "scoreVar", "projOps", "scoreOps", "params", "t"];
export function validateAttentionHeads(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, ATTENTION_VARS, ATTENTION_FNS);
  k.defs(c.defs);
  tokenList(k, c.tokens, "tokens");
  if (c.memory !== undefined) tokenList(k, c.memory, "memory");
  for (const f of ["dModel", "heads", "causal", "scale", "temperature", "focus"]) k.optExpr(c[f], f);
  if (c.view !== undefined && !["heatmaps", "arcs"].includes(c.view as string)) k.add("view: heatmaps | arcs");
  k.readouts(c.readouts, spec);
  return k.problems;
}

export const LAYER_FNS = ["rmsAt"];
export const LAYER_VARS = ["stage", "stages", "layer", "layers", "rms", "rmsFocus", "mean", "std", "rms_in", "rms_out", "growth", "params", "paramsTotal", "dff", "dk", "dModel", "n", "t"];
const SUBLAYERS = ["attention", "cross", "ffn"];
export function validateLayerStack(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, LAYER_VARS, LAYER_FNS);
  k.defs(c.defs);
  tokenList(k, c.tokens, "tokens");
  for (const f of ["dModel", "dff", "layers", "heads", "residual", "norm", "embedScale", "posenc", "dropout", "focus", "speed"]) k.optExpr(c[f], f);
  if (c.sublayers !== undefined && !(Array.isArray(c.sublayers) && c.sublayers.length >= 1 && c.sublayers.length <= 3 && c.sublayers.every((x) => SUBLAYERS.includes(x as string))))
    k.add(`sublayers: 1–3 of ${SUBLAYERS.join(", ")}`);
  k.readouts(c.readouts, spec);
  return k.problems;
}

// ---------------------------------------------------------------------------
// message-sequence, hash-chain, state-machine, markov-chain
// ---------------------------------------------------------------------------

export interface MessageSequenceConfig extends Common {
  protocol: Protocol;
  nodes: string[];
  acceptors?: string[];
  logs?: Record<string, number[]>;
  terms?: Record<string, number>;
  links?: [string, string][];
  state?: Record<string, Record<string, string | number>>;
  events: MsgEvent[] | Record<string, MsgEvent[]>;
  scenario?: string;
  speed?: Num;
}

export interface HashChainConfig extends Common {
  mode: "chain" | "merkle";
  records: string[];
  hashLen?: number;
  difficulty?: Num;
  tamper?: { index: Num; value?: string };
  redo?: Num;
  proof?: Num;
  keep?: number[];
  prune?: Num;
  speed?: Num;
}

export interface StateMachineConfig extends Common {
  kind: "dfa" | "turing";
  start: string;
  accept?: string[];
  transitions: Transition[];
  input?: string;
  head?: number;
  maxSteps?: Num;
  speed?: Num;
}

export interface MarkovChainConfig extends Common {
  states?: string[];
  edges?: { from: string; to: string; p: Num }[];
  walk?: { n: Num; p: Num; start?: Num };
  start?: string | number;
  layout?: "circle" | "line";
  walkers?: Num;
  seed?: number;
  horizon?: Num;
  speed?: Num;
}

const staticNum = (f: Num | undefined, env: Env, d: number): number => {
  const c = f === undefined ? undefined : typeof f === "number" ? f : tryCompile(f);
  const x = c === undefined || typeof c === "string" ? d : evalNum(c, env);
  return Number.isFinite(x) ? x : d;
};
const staticStr = (f: string | undefined, env: Env): string | undefined => {
  if (f === undefined) return undefined;
  const c = tryCompile(f);
  if (typeof c === "string") return undefined;
  try {
    return String(c(env));
  } catch {
    return undefined;
  }
};

/** The scenario a message-sequence config plays at these params. */
export function seqSetup(c: MessageSequenceConfig, env: Env): SeqSetup {
  let events: MsgEvent[] = [];
  if (Array.isArray(c.events)) events = c.events;
  else if (isObj(c.events)) {
    const names = Object.keys(c.events);
    const pick = staticStr(c.scenario, env);
    events = c.events[pick && pick in c.events ? pick : names[0]] ?? [];
  }
  // Paxos roles don't change with the scenario: proposers are the nodes that propose in any of them.
  const all = Array.isArray(c.events) ? c.events : isObj(c.events) ? Object.values(c.events).flat() : [];
  const proposers = new Set(all.flatMap((e) => (e.do === "prepare" || e.do === "accept" ? [e.by].flat() : [])));
  const acceptors = c.acceptors?.length ? c.acceptors : c.protocol === "paxos" ? c.nodes.filter((n) => !proposers.has(n)) : undefined;
  return { protocol: c.protocol, nodes: c.nodes, acceptors, logs: c.logs, terms: c.terms, links: c.links, state: c.state, events };
}

export function hashSetup(c: HashChainConfig, env: Env): HashSetup {
  const n = c.records.length;
  const keep = c.keep && (c.prune === undefined || staticNum(c.prune, env, 1) !== 0) ? c.keep.map((k) => Math.round(k)) : null;
  return {
    mode: c.mode,
    records: c.records.slice(0, 8),
    hashLen: Math.max(2, Math.min(8, Math.round(c.hashLen ?? 4))),
    difficulty: Math.max(0, Math.min(3, Math.round(staticNum(c.difficulty, env, 0)))),
    tamper: c.tamper ? Math.round(staticNum(c.tamper.index, env, -1)) : -1,
    tamperValue: c.tamper?.value,
    redo: staticNum(c.redo, env, 0) !== 0,
    proof: Math.min(n - 1, Math.round(staticNum(c.proof, env, -1))),
    keep,
  };
}

export function machineSetup(c: StateMachineConfig, env: Env): MachineSetup {
  return {
    kind: c.kind,
    start: c.start,
    accept: c.accept ?? [],
    transitions: c.transitions,
    input: c.input ?? "",
    head: Math.round(c.head ?? 0),
    maxSteps: Math.max(1, Math.min(200, Math.round(staticNum(c.maxSteps, env, c.kind === "dfa" ? 64 : 40)))),
  };
}

/** States, transition matrix and start state of a markov-chain config (rows short of 1 keep the rest as a self-loop). */
export function markovModel(c: MarkovChainConfig, env: Env): { names: string[]; P: number[][]; start: number } {
  if (c.walk) {
    const T = Math.max(2, Math.min(40, Math.round(staticNum(c.walk.n, env, 10))));
    const p = Math.max(0, Math.min(1, staticNum(c.walk.p, env, 0.5)));
    const names = Array.from({ length: T + 1 }, (_, i) => String(i));
    const P = names.map((_, i) => names.map((__, j) => (i === 0 || i === T ? (i === j ? 1 : 0) : j === i + 1 ? p : j === i - 1 ? 1 - p : 0)));
    const start = Math.max(0, Math.min(T, Math.round(staticNum(c.walk.start, env, Math.floor(T / 2)))));
    return { names, P, start };
  }
  const names = (c.states ?? []).slice(0, 12);
  const P = names.map(() => names.map(() => 0));
  for (const e of c.edges ?? []) {
    const i = names.indexOf(e.from);
    const j = names.indexOf(e.to);
    if (i >= 0 && j >= 0) P[i][j] += Math.max(0, staticNum(e.p, env, 0));
  }
  P.forEach((row, i) => {
    const s = row.reduce((a, b) => a + b, 0);
    if (s > 1 + 1e-9) row.forEach((v, j) => (row[j] = v / s));
    else row[i] += 1 - s;
  });
  let start = 0;
  if (typeof c.start === "string" && names.includes(c.start)) start = names.indexOf(c.start);
  else if (c.start !== undefined) {
    const v = typeof c.start === "number" ? c.start : staticStr(c.start, env);
    const k = typeof v === "string" && names.includes(v) ? names.indexOf(v) : Math.round(Number(v));
    start = Number.isFinite(k) ? Math.max(0, Math.min(names.length - 1, k)) : 0;
  }
  return { names, P, start };
}

export function markovRun(c: MarkovChainConfig, env: Env): MarkovRun {
  const m = markovModel(c, env);
  let a = (c.seed ?? 1) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return runMarkov({ ...m, horizon: Math.max(1, Math.min(200, Math.round(staticNum(c.horizon, env, 30)))), walkers: staticNum(c.walkers, env, 0), next });
}

/** Markov readout functions over a run (state by name or index). */
export function markovFns(run: MarkovRun, t: number): Env {
  const at = (s: unknown) => (typeof s === "string" && run.names.includes(s) ? run.names.indexOf(s) : Math.round(Number(s)));
  const get = (arr: number[]) => (s: unknown) => arr[at(s)] ?? NaN;
  const tt = Math.max(0, Math.min(run.dist.length - 1, t));
  return {
    dist: get(run.dist[tt]),
    emp: get(run.emp[tt] ?? []),
    stat: get(run.limit),
    absorb: get(run.absorb),
    hit: get(run.hit),
    prob: (a: unknown, b: unknown) => run.P[at(a)]?.[at(b)] ?? NaN,
    absorbed: run.absorbedAt[tt] ?? 0,
    walkers: run.walkers,
    expDuration: run.expDuration,
    duration: run.duration,
  } as Env;
}

/** Last-step values as final_<name> (what a step-through ends with; usable in expect). */
const finals = (vars: Record<string, unknown>): Env => Object.fromEntries(Object.entries(vars).map(([k, v]) => [`final_${k}`, v as Value]));

const strList = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0);

export function validateMessageSequence(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const proto = c.protocol as Protocol;
  const pv = PROTOCOLS.includes(proto) ? PROTOCOL_VARS[proto] : [];
  const vars = [...SEQ_COMMON_VARS, ...pv];
  const k = base(spec, [...vars, ...vars.map((v) => `final_${v}`)], ["st"]);
  k.defs(c.defs);
  if (!PROTOCOLS.includes(proto)) k.add(`protocol: one of ${PROTOCOLS.join(", ")}`);
  if (!strList(c.nodes, 2, 7) || new Set(c.nodes as string[]).size !== (c.nodes as string[]).length) k.add("nodes: 2–7 distinct names");
  const nodes = Array.isArray(c.nodes) ? (c.nodes as string[]) : [];
  const ref = (v: unknown, where: string, star = false) => {
    for (const x of Array.isArray(v) ? v : [v]) if (!(typeof x === "string" && (nodes.includes(x) || (star && x === "*")))) k.add(`${where}: "${String(x)}" is not a node (${nodes.join(", ")})`);
  };
  if (c.acceptors !== undefined) ref(c.acceptors, "acceptors");
  if (c.links !== undefined) (Array.isArray(c.links) ? c.links : []).forEach((l, i) => ref(l, `links[${i}]`));
  if (isObj(c.logs))
    for (const [n, l] of Object.entries(c.logs)) {
      ref(n, "logs");
      if (!Array.isArray(l) || l.length > 12 || !l.every((t, i) => Number.isInteger(t) && t >= 1 && (i === 0 || t >= l[i - 1]))) k.add(`logs.${n}: up to 12 entry terms (integers ≥ 1, non-decreasing)`);
    }
  const allowed = PROTOCOLS.includes(proto) ? PROTOCOL_EVENTS[proto] : [];
  const checkEvents = (evs: unknown, where: string) => {
    if (!Array.isArray(evs) || !evs.length || evs.length > 30) return k.add(`${where}: 1–30 events`);
    evs.forEach((e, i) => {
      const w = `${where}[${i}]`;
      if (!isObj(e) || !allowed.includes(e.do as string)) return k.add(`${w}.do: ${proto} events are ${allowed.join(", ")}`);
      for (const f of ["by", "node", "lose", "loseReply"]) if (e[f] !== undefined) ref(e[f], `${w}.${f}`);
      if (e.to !== undefined) ref(e.to, `${w}.to`, proto === "script");
      if (["prepare", "accept"].includes(e.do as string) && typeof e.by !== "string") k.add(`${w}.by: the proposer`);
      if (e.do === "prepare" && e.n !== undefined && !(Number.isInteger(e.n) && (e.n as number) > 0)) k.add(`${w}.n: a positive integer proposal number`);
      if (["crash", "recover", "timeout"].includes(e.do as string) && typeof e.node !== "string") k.add(`${w}.node: required`);
      if (e.do === "mine" && e.by === undefined) k.add(`${w}.by: the miner(s)`);
      if (e.do === "send" && (e.by === undefined || typeof e.msg !== "string")) k.add(`${w}: send needs by and msg`);
    });
  };
  if (Array.isArray(c.events)) checkEvents(c.events, "events");
  else if (isObj(c.events)) {
    for (const [name, evs] of Object.entries(c.events)) checkEvents(evs, `events.${name}`);
    k.expr(c.scenario, "scenario");
  } else k.add("events: a list of events, or { scenarioName: [events] } with scenario");
  k.optExpr(c.speed, "speed");
  k.readouts(c.readouts, spec);
  return k.problems;
}

export function validateHashChain(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, [...HASH_VARS, ...HASH_VARS.map((v) => `final_${v}`)]);
  k.defs(c.defs);
  if (c.mode !== "chain" && c.mode !== "merkle") k.add("mode: chain | merkle");
  if (!strList(c.records, 2, 8)) k.add("records: 2–8 strings");
  const n = Array.isArray(c.records) ? c.records.length : 0;
  if (c.hashLen !== undefined && !(Number.isInteger(c.hashLen) && (c.hashLen as number) >= 2 && (c.hashLen as number) <= 8)) k.add("hashLen: 2–8 hex digits");
  for (const f of ["difficulty", "redo", "proof", "prune", "speed"]) k.optExpr(c[f], f);
  if (c.tamper !== undefined) {
    if (!isObj(c.tamper)) k.add("tamper: { index, value? }");
    else k.expr(c.tamper.index, "tamper.index");
  }
  if (c.keep !== undefined && !(Array.isArray(c.keep) && c.keep.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n))) k.add(`keep: leaf indices 0–${n - 1}`);
  if (c.mode === "chain" && (c.keep !== undefined || c.proof !== undefined)) k.add("keep/proof: merkle mode only");
  k.readouts(c.readouts, spec);
  return k.problems;
}

export function validateStateMachine(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, [...MACHINE_VARS, ...MACHINE_VARS.map((v) => `final_${v}`)], ["cell", "count"]);
  k.defs(c.defs);
  if (c.kind !== "dfa" && c.kind !== "turing") k.add("kind: dfa | turing");
  const rows = Array.isArray(c.transitions) ? c.transitions : [];
  if (!rows.length || rows.length > 24) k.add("transitions: 1–24 rows");
  const states = new Set<string>();
  rows.forEach((r, i) => {
    if (!isObj(r) || typeof r.from !== "string" || typeof r.to !== "string" || typeof r.read !== "string" || !r.read.length) return k.add(`transitions[${i}]: { from, read, to${c.kind === "turing" ? ", ops" : ""} }`);
    states.add(r.from);
    states.add(r.to);
    if (c.kind === "dfa" && r.read.length !== 1) k.add(`transitions[${i}].read: one symbol`);
    if (c.kind === "turing") {
      const p = opsProblem(r as unknown as Transition);
      if (p) k.add(`transitions[${i}].ops: ${p}`);
    }
  });
  if (typeof c.start !== "string" || !states.has(c.start)) k.add("start: a state used in transitions");
  if (c.accept !== undefined && !(Array.isArray(c.accept) && c.accept.every((s) => typeof s === "string" && states.has(s)))) k.add("accept: states used in transitions");
  if (c.input !== undefined && (typeof c.input !== "string" || c.input.length > 40)) k.add("input: a string of ≤ 40 symbols (_ = blank)");
  k.optExpr(c.maxSteps, "maxSteps");
  k.optExpr(c.speed, "speed");
  k.readouts(c.readouts, spec);
  return k.problems;
}

export function validateMarkovChain(c: unknown, spec: DemoSpec): string[] {
  if (!isObj(c)) return ["config must be an object"];
  const k = base(spec, MARKOV_VARS, MARKOV_FNS);
  k.defs(c.defs);
  if (isObj(c.walk)) {
    k.expr(c.walk.n, "walk.n");
    k.expr(c.walk.p, "walk.p");
    k.optExpr(c.walk.start, "walk.start");
  } else {
    const states = Array.isArray(c.states) ? (c.states as string[]) : [];
    if (!strList(c.states, 2, 12) || new Set(states).size !== states.length) k.add("states: 2–12 distinct names (or walk: { n, p, start })");
    const sums = new Map<string, number>();
    (Array.isArray(c.edges) ? c.edges : []).forEach((e, i) => {
      if (!isObj(e) || !states.includes(e.from as string) || !states.includes(e.to as string)) return k.add(`edges[${i}]: { from, to, p } between listed states`);
      k.expr(e.p, `edges[${i}].p`);
      if (typeof e.p === "number") {
        if (e.p < 0 || e.p > 1) k.add(`edges[${i}].p: a probability in [0, 1]`);
        sums.set(e.from as string, (sums.get(e.from as string) ?? 0) + e.p);
      }
    });
    if (!Array.isArray(c.edges) || !c.edges.length) k.add("edges: [{ from, to, p }] are required");
    for (const [s, v] of sums) if (v > 1 + 1e-6) k.add(`edges from ${s}: probabilities add to ${Number(v.toFixed(4))} > 1`);
    if (typeof c.start === "string" && !states.includes(c.start)) k.expr(c.start, "start");
  }
  if (c.layout !== undefined && c.layout !== "circle" && c.layout !== "line") k.add("layout: circle | line");
  for (const f of ["walkers", "horizon", "speed"]) k.optExpr(c[f], f);
  k.readouts(c.readouts, spec);
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
    when: "chance and statistics: repeated random trials (coins, dice, sums, categorical outcomes, multi-step processes played to the end, sampling, heavy-tailed sizes on log bins) building a histogram that approaches an expected distribution; law of large numbers.",
    configDoc: `{ seed?, trial: "expr per trial" (random: rand() uniform 0–1, randn() normal, randint(a,b) inclusive, coin(p) 0/1, exprand(rate), pareto(alpha, xmin), lognormal(mu, sigma), powerlaw(lo, hi, alpha) ∝ x^−alpha; repeat(n, expr) sums n draws) | process: { init: { var: start }, step: { var: "next value" } (all update together, random draws allowed), until?: "stop condition", maxSteps? (1000), result: "expr" } (a multi-step process played per trial, e.g. a gambler's ruin; k = steps taken), trials: total, categories?: [names] (results are indices 0…), perSecond? (animation rate), bins?: "integer" | { min, max, count?, log? (log-spaced bins and axis for heavy tails) } (integer when values are whole), expected?: "expr in x" (probability per integer x, or density for continuous bins) drawn as a line, xLabel?, readouts }. Variables: n (trials so far), mean, sd, last; frac(lo, hi) = share of results in [lo, hi] — these change while trials accumulate, so never use them in expect (expect only param-derived readouts like k*p). Expressions, defs, readouts: as in function-plot.`,
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
    configDoc: `{ algorithm: ${ALGORITHMS.join("|")}, array?: number[] (2–16) | { n, seed?, max?, sorted? }, target? (searches, two-pointers sum), graph?: { nodes: string[] (≤12), edges: [[a,b]], start, directed? } (bfs/dfs), fold?: { input: string (characters → their codes) | number[] (≤ 16), init, step: "expr in acc, x, i, n, ch" (int32(v)/uint32(v) wrap like 32-bit ints), name? ('h'), lines?: [init, update, return] code line indices } (fold: acc = step(acc, x) left to right, e.g. a string hashCode), speed? (steps per second, default 1), code? (false hides it; string[] replaces the listing), defs?, readouts }. Readout variables: step, steps, comparisons, swaps, done (0/1), found (index or -1), n, lo, hi, mid, i, j, visited, frontier, acc, x; result = fold's final value (fine for expect). Expressions, defs, readouts: as in function-plot.`,
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
    when: "a data structure under a list of operations: stack, queue, sorted linked list, binary search tree, min-heap (sift up/down), hash table with chaining, or open addressing with linear probing (del markers, wrap-around, runs).",
    configDoc: `{ defs?, kind: ${STRUCTURES.join("|")}, ops: [{ op: push|pop|enqueue|dequeue|insert|delete|search, value?: Num }] (1–24; stack push/pop/search, queue enqueue/dequeue/search, min-heap insert/pop, others insert/delete/search), buckets?: Num (table size m: hash-table 7, open-addressing 10, ≤ 24), hash?: "expr in key, m" (default key mod m), speed?: Num (steps per second, 1), code? (show the operation's pseudocode, default true), readouts }. Readout variables: step, steps, size, comparisons, height (bst/heap), collisions, maxChain (hash-table), probes (this operation), runLength (longest run of non-null slots), dels, load ((keys + dels)/m) (open-addressing), found (1/0 for the last search), top (top/front/min value), done — they change as the steps play, so never use them in expect. Expressions, defs, readouts: as in function-plot.`,
    example: {
      kind: "bst",
      ops: [{ op: "insert", value: 50 }, { op: "insert", value: 30 }, { op: "insert", value: 70 }, { op: "insert", value: 20 }, { op: "insert", value: 40 }, { op: "search", value: 40 }],
      readouts: { height: "height", cmp: "comparisons" },
    },
  },
  "heap-allocator": {
    when: "malloc-style allocators: first/next/best fit (alone or side by side), implicit vs explicit free lists, LIFO vs address order, splitting, coalescing, header/alignment overhead, utilization over a request trace.",
    configDoc: `{ defs?, heap? (bytes, 128), max? (8×heap), align? (8), header? (8), footer? (0), policy?: 'first'|'next'|'best' (expr; a select param), compare?: [policies] (1–3 heaps side by side, one step per request), list?: 'implicit'|'explicit', insert?: 'lifo'|'address', coalesce? (1), split? (1), trace: [{ op: malloc, size, id? } | { op: free, id }] (≤ 40; ids a, b, c… by default) | { requests, size: "expr" (rand, randint, pareto…), free? (0.4), seed? }, chart?: examined|utilization|heap, speed?, code? (true), readouts }. Variables (change as it plays): step, request, examined, last, heap, live, peak, util, internal, freeBlocks, largestFree, failed. Constants for expect: total_examined, final_heap, final_util, final_peak, total_failed. With compare each also has a policy suffix (total_examined_best). Expressions: as in function-plot.`,
    example: {
      heap: 96,
      policy: "policy",
      list: "list",
      trace: [{ op: "malloc", size: 16, id: "a" }, { op: "malloc", size: 8, id: "b" }, { op: "malloc", size: 24, id: "c" }, { op: "free", id: "b" }, { op: "malloc", size: 4, id: "d" }],
      readouts: { examined: "total_examined", util: { expr: "final_util", digits: 2 } },
    },
  },
  "attention-heads": {
    when: "multi-head or single-head attention over a few tokens: a heatmap or arcs per head, causal masking, cross-attention, 1/√dk scaling and temperature, heads vs per-head size and cost.",
    configDoc: `{ seed?, tokens: string[] (2–10), memory?: string[] (cross-attention keys/values), dModel? (8, ≤ 64), heads? (2, 1–8; dk = floor(dModel/heads)), causal? (1/0), scale? (1/0 ÷√dk, 1), temperature? (1), focus? (query row, last), view?: heatmaps|arcs, defs?, readouts }. Variables: n, m, h, dk, dModel, focus, meanEntropy (focus row, mean over heads), diversity (0–1 spread between heads), rawVar (var of q·k ≈ dk), scoreVar, projOps = 4·n·dModel², scoreOps = h·n·m·dk, params = 4·dModel². Functions: weight(head, i, j), entropy(head, i), maxw(head, i), argmaxw(head, i), rowsum(head, i). Expressions: as in function-plot.`,
    example: {
      seed: 4,
      tokens: ["the", "law", "will", "never", "be", "perfect"],
      dModel: "d",
      heads: "h",
      causal: "masked",
      readouts: { dk: "dk", ent: { expr: "meanEntropy", digits: 2 }, ops: "scoreOps" },
    },
  },
  "layer-stack": {
    when: "a transformer layer or a stack of N as a pipeline: embeddings (×√d) + positional encoding, attention / feed-forward sublayers, residuals, LayerNorm post/pre/none, dropout — stage by stage with the stream's RMS.",
    configDoc: `{ seed?, tokens: string[] (2–10), dModel? (16), dff? (4·dModel), layers? (1, ≤ 8), sublayers?: [attention|cross|ffn] (default [attention, ffn]), heads? (2), residual? (1), norm?: 'post'|'pre'|'none', embedScale? (1), posenc? (1), dropout? (0), focus? (row, 0), speed? (stages/s, 1), defs?, readouts }. Variables (change as it plays): stage, stages, layer, layers, rms, rmsFocus, mean, std (focus row). Constants for expect: rms_in, rms_out, growth, params (per layer: 4d² + 2·d·dff + dff + d), paramsTotal, n, dModel, dff, dk. Function rmsAt(k). Expressions: as in function-plot.`,
    example: {
      seed: 2,
      tokens: ["the", "cat", "sat", "on", "the", "mat"],
      dModel: 16,
      layers: "N",
      residual: "res",
      norm: "norm",
      readouts: { rms: { expr: "rms", digits: 2 }, growth: { expr: "growth", digits: 2 }, params: "params" },
    },
  },
  "message-sequence": {
    when: "distributed protocols as a sequence diagram: nodes exchange requests/replies over rounds (losses, crashes), with per-node state and logs — Paxos (later proposers adopt the highest accepted value), Raft (elections, replication, repair, commit rule), block flooding (longest chain wins), or a scripted exchange.",
    configDoc: `{ protocol: paxos|raft|flood|script, nodes: string[] (2–7), events: [event] (≤ 30) | { name: [event] } + scenario: "expr → name" (select param), speed?, readouts; paxos acceptors? (default: non-proposers); raft logs?: { node: [entry terms] }, terms?; flood links?: [[a,b]] (all pairs); script state?: { node: { key: value } } }. Events (optional note: caption, lose/loseReply: [nodes] whose requests/replies are lost): paxos {do:prepare, by, n, value?}, {do:accept, by, value?} (needs a majority of promises; proposes the highest-numbered accepted value they report, else its own); raft {do:timeout, node} (election), {do:client, value}, {do:replicate, to?} (steps back on mismatch; commits own-term entries on a majority; followers learn it on the next replicate); flood {do:mine, by (list = simultaneous), value}; script {do:send, by, to (node|list|"*"), msg, reply?, set?: { node: { key: value } }}, {do:set, set}; any {do:crash|recover, node}, {do:note, note}. The rules are applied, not scripted. Variables: step, steps, done, messages, lost, up; paxos chosen ('none'), chosenN, quorum, n, value, promises, accepts, promised; raft term, leader ('none'), leaders, committed, lastIndex, votes, quorum; flood height, reached, forks, agree, tip; st(node, key). final_<variable>: its value at the end (use in expect). Expressions: as in function-plot.`,
    example: {
      protocol: "paxos",
      nodes: ["P1", "P2", "A1", "A2", "A3"],
      events: [
        { do: "prepare", by: "P1", n: 1, value: "x" },
        { do: "accept", by: "P1", lose: ["A2", "A3"] },
        { do: "prepare", by: "P2", n: 2, value: "y" },
        { do: "accept", by: "P2" },
      ],
      readouts: { chosen: "final_chosen", quorum: "quorum" },
    },
  },
  "hash-chain": {
    when: "hash-linked records: a block chain (prev-hash links, toy proof-of-work, tampering breaks the next link, an attacker redoing the work) or a Merkle tree (pairs hashed up to the root, a leaf's proof path, tampering changes the root, pruning keeps only the needed hashes).",
    configDoc: `{ mode: chain|merkle, records: string[] (2–8), hashLen? (hex digits shown, 4), difficulty? (chain: leading zero digits the hash needs, 0–3), tamper?: { index (expr, −1 none), value? }, redo? (chain: 1 = recompute every later block), proof? (merkle: leaf index, −1 none), keep?: [leaf indices] (merkle pruning; prune?: expr 1/0 to show it), speed?, readouts }. Toy hash (FNV-1a). Steps: build, then proof, tamper, redo/prune as configured. Variables: step, steps, done, n, blocks, valid (1/0), brokenAt (first block whose prev doesn't match, −1), work, redoWork (nonces tried), tip, root (hex), proofLen, verified, pruned, kept, depth; final_<variable> = its value at the end (use those in expect). Expressions: as in function-plot.`,
    example: { mode: "merkle", records: ["Tx0", "Tx1", "Tx2", "Tx3"], proof: 3, keep: [3], readouts: { proof: "final_proofLen", pruned: "final_pruned" } },
  },
  "state-machine": {
    when: "a finite automaton reading an input string (state graph, accept/reject) or a Turing machine stepping over its tape from a transition table (head, m-configuration, the active row highlighted).",
    configDoc: `{ kind: dfa|turing, start, accept?: [states], transitions: [{ from, read (symbol; "_" blank; "*" any — an exact row wins), to, ops? (turing: "P0, R" — P<symbol> print, E erase, L, R, N; or write?, move?) }] (≤ 24), input? (string, "_" blank; the DFA's input or the initial tape), head? (0), maxSteps? (turing 40, ≤ 200), speed?, readouts }. A machine halts when no row matches. Variables: step, steps, done, state, head, halted, accepted (1/0; in accept), tape (text), moves, symbols (non-blank cells); cell(i), count(symbol); final_<variable> = its value at the end (use those in expect). Expressions: as in function-plot.`,
    example: {
      kind: "turing",
      start: "b",
      transitions: [
        { from: "b", read: "_", ops: "P0, R", to: "c" },
        { from: "c", read: "_", ops: "R", to: "e" },
        { from: "e", read: "_", ops: "P1, R", to: "f" },
        { from: "f", read: "_", ops: "R", to: "b" },
      ],
      maxSteps: 12,
      readouts: { state: "state", zeros: "count('0')" },
    },
  },
  "markov-chain": {
    when: "Markov chains and random walks: a weighted digraph's distribution evolving step by step (to a stationary distribution, or oscillating), absorbing states (absorption probabilities, expected duration), gambler's ruin — with seeded walkers that play the chain.",
    configDoc: `{ states: string[] (2–12), edges: [{ from, to, p }] (a row short of 1 keeps the rest as a self-loop; no out-edges = absorbing) | walk: { n (states 0..n ≤ 40; 0 and n absorb), p (up), start? }, start? (name or index), layout?: circle|line, walkers? (≤ 5000), seed?, horizon? (steps, 30), speed?, readouts }. Exact: dist(s) at step t, stat(s) stationary (or long-run average from start), absorb(s) P(end in s), expDuration; played: emp(s) share of walkers at s now, hit(s) share ending in s, duration (mean steps to absorption), absorbed (share absorbed by t), walkers; prob(a, b); s = name or index. Variables: step = t, steps, done. stat, absorb, hit, prob, expDuration, duration are fixed (fine for expect). Expressions: as in function-plot.`,
    example: {
      states: ["a", "b", "c", "d"],
      edges: [
        { from: "b", to: "a", p: 0.5 },
        { from: "b", to: "c", p: 0.5 },
        { from: "c", to: "b", p: 0.5 },
        { from: "c", to: "d", p: 0.5 },
      ],
      start: "b",
      layout: "line",
      walkers: 600,
      readouts: { atA: { expr: "absorb('a')", digits: 3 }, atD: { expr: "absorb('d')", digits: 3 } },
    },
  },
} as const;
