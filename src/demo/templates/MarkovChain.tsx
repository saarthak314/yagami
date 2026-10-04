// markov-chain: a weighted digraph (or a walk on a line) whose exact distribution evolves step by step,
// next to seeded walkers that actually play the chain, with the long-run / absorption values marked.

import { useMemo, useRef } from "react";
import { draw, theme } from "../kit";
import { Stage } from "./stage";
import { markovFns, markovRun, type MarkovChainConfig } from "./configs";
import { END_HOLD, applyDefs, autoPace, compileDefs, compileReadouts, drawNote, opt, paramEnv, readoutValues, stepIndex, val, type TemplateProps } from "./runtime";

const pText = (p: number) => {
  for (const d of [2, 3, 4, 5, 6, 8, 10]) if (Math.abs(p * d - Math.round(p * d)) < 1e-9) return Math.round(p * d) === d ? "1" : `${Math.round(p * d)}/${d}`;
  return p.toFixed(2);
};

export default function MarkovChain({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<MarkovChainConfig>) {
  const c = useMemo(() => ({ defs: compileDefs(config.defs), speed: opt(config.speed), readouts: compileReadouts(config.readouts) }), [config]);
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env = applyDefs(paramEnv(params), c.defs);
    const r = markovRun(config, env);
    let top = 0;
    for (let t = 0; t < r.dist.length; t++) for (let s = 0; s < r.names.length; s++) top = Math.max(top, r.dist[t][s], r.emp[t]?.[s] ?? 0);
    for (let s = 0; s < r.names.length; s++) top = Math.max(top, r.absorbing.some(Boolean) ? r.absorb[s] : r.limit[s]);
    return { env, r, top: Math.min(1, top * 1.1 || 1) };
  }, [c, paramsKey, config]); // params enter through paramsKey
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
        const r = run.r;
        const count = r.dist.length;
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 1 : autoPace(count));
        const t = stepIndex(clk.t, count, speed, END_HOLD);
        const fns = markovFns(r, t);
        setReadouts(readoutValues(c.readouts, { ...run.env, ...fns, step: t, t, steps: count, done: t === count - 1 ? 1 : 0 }));
        if (width < 80 || height < 80) return;

        const n = r.names.length;
        const m = 16;
        const noteH = 40;
        const absorbingAny = r.absorbing.some(Boolean);
        const longRun = absorbingAny ? r.absorb : r.limit;
        const line = config.layout === "line" || !!config.walk || n > 8;
        const graphH = Math.max(70, Math.min(line ? 110 : 210, (height - noteH) * (line ? 0.32 : 0.5)));
        const barTop = graphH + (config.walk ? 40 : 26);
        const barBottom = height - noteH - 34;
        const slot = (width - 2 * m) / n;
        const R = Math.max(5, Math.min(17, slot / 2 - 3, line ? 17 : graphH / 6));
        const cy = graphH / 2 + 8;
        const rad = Math.max(30, Math.min(width / 2 - m - R - 30, graphH / 2 - R - 10));
        const pos = r.names.map((_, i) =>
          line ? ([m + slot * (i + 0.5), cy] as [number, number]) : ([width / 2 + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), cy + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)] as [number, number]),
        );

        // Edges (a walk on a line: just the line; its rule is written underneath).
        const showP = !config.walk && n <= 10;
        const plainLine = line && (!!config.walk || n > 10);
        if (plainLine) draw.line(ctx, pos[0][0], cy, pos[n - 1][0], cy, { color: theme.muted, width: 1.25 });
        for (let i = 0; i < n && !plainLine; i++)
          for (let j = 0; j < n; j++) {
            const p = r.P[i][j];
            if (p <= 0 || (i === j && !showP)) continue;
            const [x1, y1] = pos[i];
            const [x2, y2] = pos[j];
            if (i === j) {
              if (p >= 1 - 1e-12 || showP) {
                ctx.beginPath();
                ctx.arc(x1, y1 - R - 7, 8, 0.75 * Math.PI, 2.25 * Math.PI);
                ctx.strokeStyle = theme.muted;
                ctx.lineWidth = 1.1;
                ctx.stroke();
                draw.text(ctx, pText(p), x1, y1 - R - 22, { kind: "mono", align: "center", size: 10, color: theme.muted });
              }
              continue;
            }
            const both = r.P[j][i] > 0;
            const dx = x2 - x1;
            const dy = y2 - y1;
            const d = Math.hypot(dx, dy) || 1;
            const skip = line && Math.abs(i - j) > 1;
            const bend = (both ? 10 : 0) + (skip ? 26 : 0);
            const nx = -dy / d;
            const ny = dx / d;
            const qx = (x1 + x2) / 2 + nx * bend;
            const qy = (y1 + y2) / 2 + ny * bend;
            const u1 = Math.hypot(qx - x1, qy - y1) || 1;
            const u2 = Math.hypot(qx - x2, qy - y2) || 1;
            const sx = x1 + ((qx - x1) / u1) * (R + 1);
            const sy = y1 + ((qy - y1) / u1) * (R + 1);
            const gapEnd = r.absorbing[j] ? R + 5 : R + 2;
            const ex = x2 + ((qx - x2) / u2) * gapEnd;
            const ey = y2 + ((qy - y2) / u2) * gapEnd;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.quadraticCurveTo(qx, qy, ex, ey);
            ctx.strokeStyle = theme.muted;
            ctx.lineWidth = 1.1;
            ctx.stroke();
            const tl = Math.hypot(ex - qx, ey - qy) || 1;
            draw.arrow(ctx, ex - ((ex - qx) / tl) * 5, ey - ((ey - qy) / tl) * 5, ex, ey, { color: theme.muted, width: 1.1, head: 5 });
            if (showP) draw.text(ctx, pText(p), qx + nx * 9, qy + ny * 9, { kind: "mono", align: "center", size: 10, color: theme.muted });
          }

        // Nodes: the disc's area is the probability of being there now.
        const sampleAt = r.sample[t];
        for (let i = 0; i < n; i++) {
          const [x, y] = pos[i];
          draw.circle(ctx, x, y, R, { color: r.absorbing[i] ? theme.fg : theme.muted, width: 1.25, fill: theme.bg });
          if (r.absorbing[i]) draw.circle(ctx, x, y, R + 3, { color: theme.faint, width: 1, fill: null });
          const pr = r.dist[t][i];
          if (pr > 1e-4) {
            ctx.save();
            ctx.globalAlpha = 0.45;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(1.5, R * Math.sqrt(Math.min(1, pr))), 0, 2 * Math.PI);
            ctx.fillStyle = theme.accent;
            ctx.fill();
            ctx.restore();
          }
          if (sampleAt === i) draw.circle(ctx, x, y, R + 6, { color: theme.accent2, width: 1.75, fill: null });
          if (R >= 9 || i % Math.ceil(12 / Math.max(1, R)) === 0 || i === n - 1) draw.text(ctx, r.names[i], x, y, { kind: "mono", align: "center", size: Math.min(11, Math.max(8, R)), color: theme.fg });
        }
        if (config.walk) {
          const p = r.P[1]?.[2] ?? 0;
          draw.text(ctx, `each step +1 with p = ${pText(p)}, −1 with q = ${pText(1 - p)}; ${r.names[0]} and ${r.names[n - 1]} absorb`, width / 2, cy + R + 18, { align: "center", size: 10, color: theme.muted });
        }

        // Bars: exact (accent), walkers (muted), long-run / absorption (accent2 tick).
        if (barBottom - barTop > 30) {
          const top = run.top;
          const yOf = (v: number) => barBottom - (Math.max(0, v) / top) * (barBottom - barTop);
          const bx = (i: number) => (line ? pos[i][0] : m + slot * (i + 0.5));
          const bw = Math.max(2, Math.min(18, slot * 0.32));
          draw.line(ctx, m, barBottom + 0.5, width - m, barBottom + 0.5, { color: theme.line, width: 1 });
          for (let i = 0; i < n; i++) {
            const x = bx(i);
            const pe = r.dist[t][i];
            if (pe > 0) draw.rect(ctx, x - bw - 1, yOf(pe), bw, barBottom - yOf(pe), { color: theme.accent, width: 1, fill: theme.accent });
            if (r.walkers) {
              const pw = r.emp[t][i];
              if (pw > 0) draw.rect(ctx, x + 1, yOf(pw), bw, barBottom - yOf(pw), { color: theme.muted, width: 1 });
            }
            const lr = longRun[i];
            if (lr > 1e-6) draw.line(ctx, x - bw - 4, yOf(lr), x + bw + 4, yOf(lr), { color: theme.accent2, width: 2, dash: [3, 2] });
            if (!line && (slot >= 16 || i % 2 === 0)) draw.text(ctx, r.names[i], x, barBottom + 10, { kind: "mono", align: "center", size: 10, color: theme.faint });
          }
          const legend = [`exact P(at s after ${t})`, r.walkers ? `${r.walkers} walkers` : "", absorbingAny ? "absorption prob." : "stationary"].filter(Boolean);
          const colors = [theme.accent, theme.muted, theme.accent2];
          let lx = m;
          legend.forEach((s, i) => {
            const col = r.walkers || i === 0 ? colors[i] : colors[2];
            if (col === theme.accent2) draw.line(ctx, lx - 1, barTop - 10, lx + 9, barTop - 10, { color: col, width: 2, dash: [3, 2] });
            else draw.rect(ctx, lx, barTop - 14, 8, 8, { color: col, width: 1, fill: i === 0 ? col : null });
            draw.text(ctx, s, lx + 12, barTop - 10, { size: 10, color: theme.muted });
            lx += 12 + s.length * 5.6 + 14;
          });
        }

        const absorbed = r.walkers && absorbingAny ? ` · ${Math.round(r.absorbedAt[t] * 100)}% of the walkers absorbed` : "";
        const where = r.walkers ? ` · walker 1 at ${r.names[sampleAt] ?? "?"}` : "";
        drawNote(ctx, `t = ${t}${absorbed}${where}`, width, height - noteH + 12, 1);
      }}
    />
  );
}
