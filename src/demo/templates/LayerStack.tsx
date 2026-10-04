// layer-stack: a transformer encoder/decoder layer (or a stack of N) as a pipeline over seeded token vectors —
// embeddings (×√d) + positional encoding, attention / cross-attention / feed-forward sublayers, residual adds,
// LayerNorm (post, pre or none) and dropout. Steps through the stages with the stream drawn as a heatmap and
// the per-token RMS across stages as a line.

import { useMemo, useRef } from "react";
import { diverging, draw, matmul, randMatrix, rng, theme, transpose } from "../kit";
import { Stage } from "./stage";
import { num, type Compiled, type Env, type Value } from "./expr";
import { layerStackStatic, type LayerStackConfig, type Sublayer } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, niceTicks, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

type M = number[][];
interface StageRec {
  label: string;
  box: number; // index of the diagram box to highlight
  layer: number;
  X: M;
}

const rowRms = (r: number[]) => Math.sqrt(r.reduce((a, b) => a + b * b, 0) / Math.max(1, r.length));
const meanRms = (X: M) => X.reduce((a, r) => a + rowRms(r), 0) / Math.max(1, X.length);
const layerNorm = (X: M): M =>
  X.map((r) => {
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length + 1e-5);
    return r.map((v) => (v - m) / sd);
  });
const add = (A: M, B: M): M => A.map((r, i) => r.map((v, j) => v + B[i][j]));
const relu = (A: M): M => A.map((r) => r.map((v) => (v > 0 ? v : 0)));
const softmaxRows = (A: M): M =>
  A.map((r) => {
    const mx = Math.max(...r);
    const e = r.map((v) => Math.exp(v - mx));
    const s = e.reduce((a, b) => a + b, 0) || 1;
    return e.map((v) => v / s);
  });
const cap = (X: M): M => X.map((r) => r.map((v) => (Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0)));

const BOX_LABEL: Record<Sublayer, string> = { attention: "multi-head attention", cross: "cross-attention", ffn: "feed forward" };

export default function LayerStack({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<LayerStackConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      dModel: opt(config.dModel),
      dff: opt(config.dff),
      layers: opt(config.layers),
      heads: opt(config.heads),
      residual: opt(config.residual),
      norm: config.norm === undefined ? undefined : opt(config.norm),
      embedScale: opt(config.embedScale),
      posenc: opt(config.posenc),
      dropout: opt(config.dropout),
      focus: opt(config.focus),
      speed: opt(config.speed),
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
    const normOf = (): "post" | "pre" | "none" => {
      if (c.norm === undefined) return "post";
      let v: Value;
      try {
        v = typeof c.norm === "number" ? c.norm : c.norm(env);
      } catch {
        return "post";
      }
      if (v === "pre" || v === "none" || v === "post") return v;
      const n = num(v);
      return n === 0 ? "none" : n === 2 ? "pre" : "post";
    };
    const tokens = config.tokens.slice(0, 10);
    const n = tokens.length;
    // Sizes come from the same function validation uses (so a spec's expectations match what renders).
    const st = layerStackStatic(config, env);
    const { d, dff, L, h, dk } = st;
    const residual = flag(c.residual, true);
    const norm = normOf();
    const embedScale = flag(c.embedScale, true);
    const posenc = flag(c.posenc, true);
    const pRaw = c.dropout !== undefined ? val(c.dropout, env) : 0;
    const p = Number.isFinite(pRaw) ? Math.max(0, Math.min(0.9, pRaw)) : 0;
    const focus = Math.max(0, Math.min(n - 1, int(c.focus, 0, 0, n - 1)));
    const subs: Sublayer[] = st.subs;

    const next = rng(config.seed ?? 1);
    // Embeddings ~ N(0, 1/d) (RMS 1/√d); ×√d brings them to the scale of the positional encodings.
    let X = randMatrix(n, d, next, 1 / Math.sqrt(d));
    const stages: StageRec[] = [];
    if (embedScale) X = X.map((r) => r.map((v) => v * Math.sqrt(d)));
    stages.push({ label: embedScale ? "embeddings × √d" : "embeddings", box: 0, layer: 0, X });
    if (posenc) {
      const PE = Array.from({ length: n }, (_, pos) => Array.from({ length: d }, (_, i) => (i % 2 === 0 ? Math.sin(pos / 10000 ** (i / d)) : Math.cos(pos / 10000 ** ((i - 1) / d)))));
      X = add(X, PE);
      stages.push({ label: "+ positional encoding", box: 1, layer: 0, X });
    }
    const memory = randMatrix(n, d, next, 1);
    const attention = (Q0: M, KV: M, W: { q: M[]; k: M[]; v: M[]; o: M }): M => {
      const outs = W.q.map((_, hi) => {
        const Q = matmul(Q0, W.q[hi]);
        const K = matmul(KV, W.k[hi]);
        const V = matmul(KV, W.v[hi]);
        const A = softmaxRows(matmul(Q, transpose(K)).map((r) => r.map((v) => v / Math.sqrt(dk))));
        return matmul(A, V);
      });
      const concat = outs[0].map((_, i) => outs.flatMap((o) => o[i]));
      return matmul(concat, W.o);
    };
    const dropout = (A: M): M => (p > 0 ? A.map((r) => r.map((v) => (next() < p ? 0 : v / (1 - p)))) : A);
    const firstBox = posenc ? 2 : 1;
    for (let l = 1; l <= L; l++) {
      subs.forEach((sub, si) => {
        const s = 1 / Math.sqrt(d);
        const W =
          sub === "ffn"
            ? { w1: randMatrix(d, dff, next, Math.sqrt(2 / d)), w2: randMatrix(dff, d, next, 1 / Math.sqrt(dff)) }
            : { q: Array.from({ length: h }, () => randMatrix(d, dk, next, s)), k: Array.from({ length: h }, () => randMatrix(d, dk, next, s)), v: Array.from({ length: h }, () => randMatrix(d, dk, next, s)), o: randMatrix(h * dk, d, next, 1 / Math.sqrt(h * dk)) };
        const apply = (input: M): M => (sub === "ffn" ? matmul(relu(matmul(input, (W as { w1: M }).w1)), (W as { w2: M }).w2) : attention(input, sub === "cross" ? memory : input, W as { q: M[]; k: M[]; v: M[]; o: M }));
        const box = firstBox + si * 2;
        if (norm === "pre") {
          const out = cap(dropout(apply(layerNorm(X))));
          stages.push({ label: `${BOX_LABEL[sub]} (on LayerNorm(x))`, box, layer: l, X: out });
          X = cap(residual ? add(X, out) : out);
          stages.push({ label: residual ? "x + sublayer" : "sublayer output", box: box + 1, layer: l, X });
        } else {
          const out = cap(dropout(apply(X)));
          stages.push({ label: BOX_LABEL[sub], box, layer: l, X: out });
          const sum = residual ? add(X, out) : out;
          X = cap(norm === "post" ? layerNorm(sum) : sum);
          stages.push({ label: norm === "post" ? (residual ? "add & norm" : "norm") : residual ? "add" : "output", box: box + 1, layer: l, X });
        }
      });
    }
    if (norm === "pre") {
      X = layerNorm(X);
      stages.push({ label: "final LayerNorm", box: firstBox + subs.length * 2, layer: L, X });
    }
    const rmsList = stages.map((st) => meanRms(st.X));
    const perLayer = st.perLayer;
    const boxes = [embedScale ? "embedding × √d" : "embedding", ...(posenc ? ["+ positional encoding"] : []), ...subs.flatMap((sub) => (norm === "pre" ? [`${BOX_LABEL[sub]}`, "+ residual"] : [BOX_LABEL[sub], norm === "post" ? (residual ? "add & norm" : "norm") : residual ? "add" : "—"])), ...(norm === "pre" ? ["final LayerNorm"] : [])];
    // Each stage's heatmap uses its own symmetric scale (98th percentile of |x|) so its pattern stays
    // readable; growth across stages is what the RMS line shows.
    const mags = stages.map((st) => {
      const a = st.X.flat().map(Math.abs).sort((x, y) => x - y);
      return a[Math.floor(a.length * 0.98)] || 1;
    });
    return { env, tokens, n, d, dff, L, h, dk, subs, stages, rmsList, perLayer, boxes, mags, focus, firstBox };
  }, [c, paramsKey, config.tokens, config.sublayers, config.seed]); // params enter through paramsKey
  const clock = useRef({ t: 0, key: resetKey, run });

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const clk = clock.current;
        if (clk.key !== resetKey || clk.run !== run) Object.assign(clk, { t: 0, key: resetKey, run });
        clk.t += dt;
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 1 : 1);
        const k = stepIndex(clk.t, run.stages.length, speed);
        const st = run.stages[k];
        const mg = 20;

        // Diagram (bottom → top like the paper's figure), when there is room.
        const showDiagram = width >= 460;
        const diaW = showDiagram ? Math.min(190, width * 0.34) : 0;
        if (showDiagram) {
          const boxH = Math.min(30, (height - 2 * mg - 30) / run.boxes.length - 8);
          const gap = 8;
          const total = run.boxes.length * (boxH + gap) - gap;
          const bottom = mg + 10 + Math.min(height - 2 * mg - 20, total) + Math.max(0, (height - 2 * mg - 20 - total) / 2);
          const yOf = (i: number) => bottom - (i + 1) * (boxH + gap) + gap;
          run.boxes.forEach((label, i) => {
            const y = yOf(i);
            const on = i === st.box;
            draw.rect(ctx, mg + 0.5, y + 0.5, diaW - 1, boxH - 1, { color: on ? theme.accent : theme.line, width: on ? 1.75 : 1 });
            let s = label;
            while (s.length > 4 && textWidth(ctx, s, LABEL_FONT) > diaW - 12) s = `${s.slice(0, -2)}…`;
            draw.text(ctx, s, mg + diaW / 2, y + boxH / 2, { align: "center", color: on ? theme.fg : theme.muted });
            if (i > 0) draw.arrow(ctx, mg + diaW / 2, y + boxH + gap - 1, mg + diaW / 2, y + boxH + 1, { color: theme.faint, width: 1, head: 4 });
          });
          // The repeated layer, bracketed with ×N.
          if (run.L > 1) {
            const top = yOf(run.boxes.length - 1);
            const bot = yOf(run.firstBox) + boxH;
            draw.line(ctx, mg + diaW + 6, top, mg + diaW + 6, bot, { color: theme.muted, width: 1 });
            draw.text(ctx, `×${run.L}`, mg + diaW + 10, (top + bot) / 2, { color: theme.muted });
          }
        }

        // Heatmap of the stream at this stage.
        const left = mg + diaW + (showDiagram ? 34 : 0);
        const rightW = width - mg - left;
        const chartH = Math.min(120, Math.max(70, height * 0.26));
        const title = `${st.layer > 0 ? `layer ${st.layer}/${run.L} · ` : ""}${st.label}`;
        let tt = title;
        while (tt.length > 4 && textWidth(ctx, tt, LABEL_FONT) > rightW) tt = `${tt.slice(0, -2)}…`;
        draw.text(ctx, tt, left, mg + 4, { color: theme.fg });
        const hm = { left, top: mg + 20, width: rightW, height: height - mg - 20 - chartH - 34 - mg };
        const mag = run.mags[k];
        draw.matrix(ctx, st.X, hm, { map: diverging, domain: [-mag, mag], rowLabels: run.tokens, highlight: { row: run.focus }, square: false });
        draw.text(ctx, `colour scale ±${fmtTick(mag, [0, mag])}`, left + rightW, hm.top + hm.height + 12, { kind: "mono", align: "right", color: theme.faint });

        // RMS per stage.
        const box = { left: left + 34, top: height - mg - chartH + 14, width: rightW - 40, height: chartH - 34 };
        const hi = Math.max(1e-6, ...run.rmsList.filter(Number.isFinite)) * 1.1;
        const ticks = niceTicks(0, hi, 3);
        const sx = (i: number) => box.left + (run.stages.length <= 1 ? 0 : (i / (run.stages.length - 1)) * box.width);
        const sy = (y: number) => box.top + box.height - (y / hi) * box.height;
        draw.line(ctx, box.left, box.top + box.height, box.left + box.width, box.top + box.height, { color: theme.line, width: 1 });
        for (const tv of ticks) draw.text(ctx, fmtTick(tv, ticks), box.left - 6, sy(tv), { kind: "mono", align: "right", color: theme.faint });
        draw.polyline(ctx, run.rmsList.map((y, i) => [sx(i), sy(Number.isFinite(y) ? y : 0)] as [number, number]), { color: theme.accent, width: 1.5 });
        run.rmsList.forEach((y, i) => draw.dot(ctx, sx(i), sy(Number.isFinite(y) ? y : 0), i === k ? 4 : 2, i === k ? theme.accent : theme.muted));
        draw.text(ctx, "RMS per token, by stage", box.left, box.top - 10, { color: theme.muted });

        const focusRow = st.X[run.focus];
        const mean = focusRow.reduce((a, b) => a + b, 0) / focusRow.length;
        const std = Math.sqrt(focusRow.reduce((a, b) => a + (b - mean) ** 2, 0) / focusRow.length);
        const rmsAt = (kv: Value) => run.rmsList[Math.max(0, Math.min(run.rmsList.length - 1, Math.floor(num(kv))))] ?? NaN;
        const rmsIn = run.rmsList[0];
        const rmsOut = run.rmsList[run.rmsList.length - 1];
        setReadouts(
          readoutValues(c.readouts, {
            ...run.env,
            rmsAt,
            stage: k,
            stages: run.stages.length,
            layer: st.layer,
            layers: run.L,
            n: run.n,
            dModel: run.d,
            dff: run.dff,
            dk: run.dk,
            rms: run.rmsList[k],
            rmsFocus: rowRms(focusRow),
            mean,
            std,
            rms_in: rmsIn,
            rms_out: rmsOut,
            growth: rmsIn > 0 ? rmsOut / rmsIn : NaN,
            params: run.perLayer,
            paramsTotal: run.perLayer * run.L,
          }),
        );
      }}
    />
  );
}
