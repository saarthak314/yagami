// matrix-ops: seeded matrices through a pipeline of operations, drawn as labelled heatmaps.

import { useMemo } from "react";
import { diverging, draw, matmul, randn, rng, sequential, theme, transpose } from "../kit";
import { Stage } from "./stage";
import { compile, num, type Compiled, type Env, type Value } from "./expr";
import type { MatrixOpsConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtValue, opt, paramEnv, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

type M = number[][];

const rowOf = (A: Value, i: Value): number[] => (Array.isArray(A) && Array.isArray(A[Math.floor(num(i))]) ? (A[Math.floor(num(i))] as Value[]).map((x) => num(x)) : []);
const flat = (A: Value): number[] => (Array.isArray(A) ? (A as Value[]).flatMap((r) => (Array.isArray(r) ? r.map((x) => num(x as Value)) : [num(r)])) : [num(A)]);
const FUNCS = {
  get: (A: Value, i: Value, j: Value) => rowOf(A, i)[Math.floor(num(j))] ?? NaN,
  rowsum: (A: Value, i: Value) => rowOf(A, i).reduce((s, x) => s + x, 0),
  rowmax: (A: Value, i: Value) => Math.max(...rowOf(A, i)),
  rowmin: (A: Value, i: Value) => Math.min(...rowOf(A, i)),
  argmax: (A: Value, i: Value) => ((r) => r.indexOf(Math.max(...r)))(rowOf(A, i)),
  entropy: (A: Value, i: Value) => -rowOf(A, i).reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0),
  var: (A: Value) => {
    const xs = flat(A).filter(Number.isFinite);
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  },
  rows: (A: Value) => (Array.isArray(A) ? A.length : 0),
  cols: (A: Value) => (Array.isArray(A) && Array.isArray(A[0]) ? (A[0] as Value[]).length : 0),
};

const softmaxRows = (A: M): M =>
  A.map((r) => {
    const mx = Math.max(...r.filter((v) => v !== -Infinity));
    const e = r.map((v) => (v === -Infinity || !Number.isFinite(mx) ? 0 : Math.exp(v - mx)));
    const s = e.reduce((a, b) => a + b, 0) || 1;
    return e.map((v) => v / s);
  });
const layernorm = (A: M): M =>
  A.map((r) => {
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length) || 1;
    return r.map((v) => (v - m) / sd);
  });

export default function MatrixOps({ config, params, width, height, setReadouts, playing, resetKey }: TemplateProps<MatrixOpsConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      inputs: Object.entries(config.inputs).map(([name, m]) => ({
        name,
        m,
        rows: opt(m.rows),
        cols: opt(m.cols),
        std: opt(m.std),
        init: m.init && !["random", "identity", "zeros", "ones", "causal"].includes(m.init) ? compile(m.init) : undefined,
      })),
      steps: config.steps.map((s) => ({ ...s, by: opt(s.by), fn: s.expr ? compile(s.expr) : undefined })),
      highlight: opt(config.highlightRow),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );

  // The matrices only depend on params: compute once per change, not per frame.
  const paramsKey = JSON.stringify(params);
  const computed = useMemo(() => {
    const env: Env = applyDefs({ ...paramEnv(params), ...FUNCS }, c.defs);
    const next = rng(config.seed ?? 1);
    const mats = new Map<string, M>();
    const titles = new Map<string, string>();
    const at = (fn: Compiled, vars: Record<string, number>) => val(fn, { ...env, ...vars });
    for (const inp of c.inputs) {
      let A: M;
      if (inp.m.values) A = inp.m.values.map((r) => [...r]);
      else {
        const R = Math.max(1, Math.min(32, Math.round(val(inp.rows, env))));
        const C = Math.max(1, Math.min(64, Math.round(val(inp.cols, env))));
        const std = inp.std !== undefined ? val(inp.std, env) : 1;
        const kind = inp.m.init ?? "random";
        A = Array.from({ length: R }, (_, i) =>
          Array.from({ length: C }, (_, j) =>
            inp.init ? at(inp.init, { i, j }) : kind === "identity" ? +(i === j) : kind === "zeros" ? 0 : kind === "ones" ? 1 : kind === "causal" ? +(j <= i) : randn(next) * std,
          ),
        );
      }
      mats.set(inp.name, A);
      titles.set(inp.name, inp.name);
    }
    let error: string | null = null;
    for (const s of c.steps) {
      const A = mats.get(s.a);
      const B = s.b ? mats.get(s.b) : undefined;
      if (!A) continue;
      let out: M;
      switch (s.op) {
        case "matmul":
          if (!B || A[0].length !== B.length) {
            error = `${s.name}: can't multiply ${A.length}×${A[0].length} by ${B ? `${B.length}×${B[0].length}` : "?"}`;
            out = A;
          } else out = matmul(A, B);
          break;
        case "transpose":
          out = transpose(A);
          break;
        case "scale": {
          const k = s.by !== undefined ? val(s.by, env) : 1;
          out = A.map((r) => r.map((v) => v * k));
          break;
        }
        case "softmax":
          out = softmaxRows(A);
          break;
        case "mask":
          out = A.map((r, i) => r.map((v, j) => ((s.fn ? at(s.fn, { i, j }) : +(j <= i)) ? v : -Infinity)));
          break;
        case "add":
          out = B && B.length === A.length && B[0].length === A[0].length ? A.map((r, i) => r.map((v, j) => v + B[i][j])) : A;
          break;
        case "relu":
          out = A.map((r) => r.map((v) => Math.max(0, v)));
          break;
        case "layernorm":
          out = layernorm(A);
          break;
        case "map":
          out = A.map((r, i) => r.map((v, j) => (s.fn ? at(s.fn, { v, i, j }) : v)));
          break;
      }
      mats.set(s.name, out!);
      titles.set(s.name, s.label ?? s.name);
    }
    for (const [k, A] of mats) env[k] = A;
    return { env, mats, titles, error, softmaxed: new Set(c.steps.filter((s) => s.op === "softmax").map((s) => s.name)) };
  }, [c, paramsKey, config.seed]); // params enter through paramsKey

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx) => {
        const { env, mats, titles, error, softmaxed } = computed;
        const show = config.show.filter((n) => mats.has(n));
        const hl = c.highlight !== undefined ? Math.round(val(c.highlight, env)) : undefined;

        // Lay out the matrices in one row when they fit, else a grid.
        const n = show.length;
        const m = 18;
        const perRow = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * width) / Math.max(1, height)) + 0.3)));
        const rowsN = Math.ceil(n / perRow);
        const cellW = (width - 2 * m) / perRow;
        const cellH = (height - 2 * m) / rowsN;
        show.forEach((name, i) => {
          const A = mats.get(name)!;
          const col = i % perRow;
          const row = Math.floor(i / perRow);
          const labelsR = config.labels?.rows && config.labels.rows.length === A.length ? config.labels.rows : undefined;
          const labelsC = config.labels?.cols && config.labels.cols.length === A[0].length ? config.labels.cols : undefined;
          // Room for row labels on the left and column labels on top.
          const box = { left: m + col * cellW + 6, top: m + row * cellH + 22, width: cellW - 18, height: cellH - 34 };
          const finite = A.flat().filter(Number.isFinite);
          const lo = Math.min(...finite);
          const hi = Math.max(...finite);
          const signed = lo < 0 && hi > 0 && !softmaxed.has(name);
          const mag = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
          // Masked (−∞) cells draw as the lowest value: no weight.
          const shown = A.map((r) => r.map((v) => (Number.isFinite(v) ? v : lo)));
          const layout = draw.matrix(ctx, shown, box, {
            map: signed ? diverging : sequential,
            domain: softmaxed.has(name) ? [0, 1] : signed ? [-mag, mag] : [lo, hi === lo ? lo + 1 : hi],
            rowLabels: labelsR,
            colLabels: labelsC,
            showValues: !!config.values,
            format: (v) => fmtValue(v, 2),
            highlight: hl !== undefined && hl >= 0 && hl < A.length ? { row: hl } : undefined,
          });
          const title = `${titles.get(name)}  ${A.length}×${A[0].length}`;
          const w = textWidth(ctx, title, LABEL_FONT);
          const tx = Math.min(Math.max(layout.left, m), width - m - w);
          draw.text(ctx, title, tx, Math.max(10, layout.top - (labelsC ? 26 : 12)), { color: theme.muted });
        });
        if (error) draw.text(ctx, error, m, height - 10, { color: theme.accent2 });
        setReadouts(readoutValues(c.readouts, env));
      }}
    />
  );
}
