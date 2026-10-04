// attention-heads: scaled dot-product attention split over h heads, with seeded token vectors and weights.
// Each head is drawn as a heatmap (queries × keys) or as arcs from the focus token; masking, scaling,
// temperature and cross-attention to a separate memory are config switches.

import { useMemo } from "react";
import { draw, matmul, randMatrix, rng, sequential, theme, transpose } from "../kit";
import { Stage } from "./stage";
import { num, type Compiled, type Env, type Value } from "./expr";
import { attentionHeadsStatic, type AttentionHeadsConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

type M = number[][];

const softmaxRow = (r: number[]): number[] => {
  const fin = r.filter((v) => v !== -Infinity);
  const mx = fin.length ? Math.max(...fin) : 0;
  const e = r.map((v) => (v === -Infinity ? 0 : Math.exp(v - mx)));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((v) => v / s);
};
const entropyOf = (p: number[]) => -p.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0);
const variance = (xs: number[]) => {
  const f = xs.filter(Number.isFinite);
  if (!f.length) return 0;
  const m = f.reduce((a, b) => a + b, 0) / f.length;
  return f.reduce((a, b) => a + (b - m) ** 2, 0) / f.length;
};

export default function AttentionHeads({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<AttentionHeadsConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      dModel: opt(config.dModel),
      heads: opt(config.heads),
      causal: opt(config.causal),
      scale: opt(config.scale),
      temperature: opt(config.temperature),
      focus: opt(config.focus),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );

  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env: Env = applyDefs(paramEnv(params), c.defs);
    const int = (f: Compiled | number | undefined, d: number, lo: number, hi: number) => {
      const x = f === undefined ? d : val(f, env);
      return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : d)));
    };
    const flag = (f: Compiled | number | undefined, d: boolean) => {
      if (f === undefined) return d;
      const x = val(f, env);
      return Number.isFinite(x) ? x !== 0 : d;
    };
    const tokens = config.tokens.slice(0, 10);
    const keys = config.memory?.length ? config.memory.slice(0, 10) : tokens;
    const cross = !!config.memory?.length;
    // Sizes come from the same function validation uses (so a spec's expectations match what renders).
    const st = attentionHeadsStatic(config, env);
    const { n, m, dModel, h, dk } = st;
    const scaled = flag(c.scale, true);
    const causal = flag(c.causal, false) && !cross;
    const tempRaw = c.temperature !== undefined ? val(c.temperature, env) : 1;
    const temp = Number.isFinite(tempRaw) && tempRaw > 0.01 ? tempRaw : 1;
    const focus = Math.max(0, Math.min(n - 1, c.focus !== undefined ? int(c.focus, n - 1, 0, n - 1) : n - 1));

    // Unit-variance token vectors and projections scaled by 1/√dModel, so q·k has variance ≈ dk.
    const next = rng(config.seed ?? 1);
    const X = randMatrix(n, dModel, next, 1);
    const Mem = cross ? randMatrix(m, dModel, next, 1) : X;
    const s = 1 / Math.sqrt(dModel);
    const heads = Array.from({ length: h }, () => {
      const Wq = randMatrix(dModel, dk, next, s);
      const Wk = randMatrix(dModel, dk, next, s);
      const Wv = randMatrix(dModel, dk, next, s);
      const Q = matmul(X, Wq);
      const K = matmul(Mem, Wk);
      const V = matmul(Mem, Wv);
      const raw = matmul(Q, transpose(K));
      const div = (scaled ? Math.sqrt(dk) : 1) * temp;
      const scores: M = raw.map((r, i) => r.map((v, j) => (causal && j > i ? -Infinity : v / div)));
      const A = scores.map(softmaxRow);
      return { raw, scores, A, out: matmul(A, V) };
    });
    const rawVar = variance(heads.flatMap((hd) => hd.raw.flat()));
    const scoreVar = variance(heads.flatMap((hd) => hd.scores.flat()));
    const focusRows = heads.map((hd) => hd.A[focus]);
    const meanEntropy = focusRows.reduce((a, r) => a + entropyOf(r), 0) / h;
    let pairs = 0;
    let dist = 0;
    for (let a = 0; a < h; a++)
      for (let b = a + 1; b < h; b++) {
        pairs++;
        dist += 0.5 * focusRows[a].reduce((sum, x, j) => sum + Math.abs(x - focusRows[b][j]), 0);
      }
    const head = (hv: Value) => heads[Math.max(0, Math.min(h - 1, Math.floor(num(hv))))];
    const row = (hv: Value, iv: Value) => head(hv).A[Math.max(0, Math.min(n - 1, Math.floor(num(iv))))];
    const fns: Env = {
      weight: (hv, iv, jv) => row(hv, iv)[Math.max(0, Math.min(m - 1, Math.floor(num(jv))))] ?? NaN,
      entropy: (hv, iv) => entropyOf(row(hv, iv)),
      maxw: (hv, iv) => Math.max(...row(hv, iv)),
      argmaxw: (hv, iv) => ((r) => r.indexOf(Math.max(...r)))(row(hv, iv)),
      rowsum: (hv, iv) => row(hv, iv).reduce((a, b) => a + b, 0),
    };
    const vars: Env = {
      ...env,
      ...fns,
      n,
      m,
      h,
      dk,
      dModel,
      focus,
      meanEntropy,
      diversity: pairs ? dist / pairs : 0,
      rawVar,
      scoreVar,
      projOps: st.projOps,
      scoreOps: st.scoreOps,
      params: st.params,
    };
    return { tokens, keys, n, m, h, dk, heads, focus, causal, cross, scaled, vars };
  }, [c, paramsKey, config.tokens, config.memory, config.seed]); // params enter through paramsKey

  const arcs = config.view === "arcs";
  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx) => {
        const { tokens, keys, n, m, h, dk, heads, focus } = run;
        const mg = 20;
        const note = `${h} head${h === 1 ? "" : "s"} · dk = ${dk}${run.scaled ? " · ÷√dk" : " · unscaled"}${run.causal ? " · causal mask" : ""}${run.cross ? " · cross-attention" : ""}`;
        const colors = [theme.accent, theme.accent2, theme.fg, theme.muted];

        if (!arcs) {
          // One heatmap per head in a grid; row labels on the first column, key labels on the top row.
          const area = { left: mg, top: mg, width: width - 2 * mg, height: height - 2 * mg - 22 };
          const cols = Math.max(1, Math.min(h, Math.round(Math.sqrt((h * area.width) / Math.max(1, area.height)) + 0.2)));
          const rows = Math.ceil(h / cols);
          const rowLabW = Math.max(...tokens.map((s) => textWidth(ctx, s, LABEL_FONT))) + 8;
          const cellW = (area.width - rowLabW) / cols;
          const cellH = area.height / rows;
          // Key labels on top only when each fits its column (small heatmaps would make them collide).
          const keyW = Math.max(...keys.map((s) => textWidth(ctx, s, LABEL_FONT)));
          const colPx = Math.min((cellW - 10) / Math.max(1, m), (cellH - 22) / Math.max(1, n));
          const showKeys = keyW + 4 <= colPx;
          heads.forEach((hd, i) => {
            const cx = i % cols;
            const cy = Math.floor(i / cols);
            const box = { left: area.left + (cx === 0 ? 0 : rowLabW) + cx * cellW, top: area.top + cy * cellH + 16, width: cellW + (cx === 0 ? rowLabW : 0) - 10, height: cellH - 22 };
            const layout = draw.matrix(ctx, hd.A, box, {
              map: sequential,
              domain: [0, 1],
              rowLabels: cx === 0 ? tokens : undefined,
              colLabels: cy === 0 && showKeys ? keys : undefined,
              highlight: { row: focus },
            });
            draw.text(ctx, h === 1 ? "attention weights" : `head ${i + 1}`, layout.left, Math.max(8, layout.top - (cy === 0 && showKeys ? 26 : 10)), { color: colors[i % 4] === theme.fg ? theme.muted : colors[i % 4] });
          });
        } else {
          // Arcs from the focus query to every key, one colour per head, thickness ∝ weight.
          const left = mg + 10;
          const right = width - mg - 10;
          const baseY = height - mg - 48;
          const xs = keys.map((_, j) => left + ((right - left) * (j + 0.5)) / m);
          const qx = run.cross ? left + ((right - left) * (focus + 0.5)) / n : xs[focus];
          const maxH = Math.max(40, baseY - mg - 30);
          heads.forEach((hd, i) => {
            const col = colors[i % 4];
            const dash = i >= 4 ? [4, 3] : [];
            hd.A[focus].forEach((w, j) => {
              if (w < 0.02) return;
              const x2 = xs[j];
              const lift = Math.min(maxH, 18 + Math.abs(x2 - qx) * 0.45) * (0.75 + (0.25 * (i + 1)) / h);
              const pts: [number, number][] = [];
              for (let q = 0; q <= 20; q++) {
                const u = q / 20;
                pts.push([qx + (x2 - qx) * u, baseY - 10 - lift * 4 * u * (1 - u)]);
              }
              draw.polyline(ctx, pts, { color: col, width: 0.75 + 4 * w, alpha: 0.35 + 0.65 * w, dash });
            });
          });
          keys.forEach((tok, j) => {
            const isFocus = !run.cross && j === focus;
            draw.dot(ctx, xs[j], baseY - 8, isFocus ? 4 : 2.5, isFocus ? theme.fg : theme.muted);
            draw.text(ctx, tok, xs[j], baseY + 8, { align: "center", color: isFocus ? theme.fg : theme.muted });
          });
          if (run.cross) draw.text(ctx, `query: ${tokens[focus]}`, left, mg + 6, { color: theme.fg });
          // Legend.
          let lx = left;
          heads.forEach((_, i) => {
            const label = `head ${i + 1}`;
            draw.line(ctx, lx, baseY + 28, lx + 14, baseY + 28, { color: colors[i % 4], width: 2, dash: i >= 4 ? [4, 3] : [] });
            draw.text(ctx, label, lx + 18, baseY + 28, { color: theme.muted });
            lx += 26 + textWidth(ctx, label, LABEL_FONT);
          });
        }
        let msg = note;
        while (msg.length > 4 && textWidth(ctx, msg, LABEL_FONT) > width - 2 * mg) msg = `${msg.slice(0, -2)}…`;
        draw.text(ctx, msg, width / 2, height - mg + 4, { align: "center", color: theme.muted });
        setReadouts(readoutValues(c.readouts, run.vars));
      }}
    />
  );
}
