// Softmax temperature (reference demo for machine-learning texts).
// Five query vectors score six candidate tokens by dot product with their key
// vectors; softmax(scores / τ) turns each row of scores into a probability
// distribution. Low τ sharpens every row towards its best token, high τ
// flattens it towards uniform. A highlight sweeps through the rows; the bar
// chart shows the highlighted row in detail.

import { useMemo } from "react";
import { Stage, draw, dot, fmt, randMatrix, rng, sequential, softmax, theme, useSim } from "../../kit";
import type { DemoProps } from "../../../types";

const QUERIES = ["the", "a", "on", "by", "it"];
const TOKENS = ["cat", "dog", "sat", "mat", "ran", "sun"];
const D = 8; // vector width
const SWEEP = 1.6; // seconds per highlighted row

/** Entropy in bits. */
const entropy = (p: number[]) => -p.reduce((s, x) => (x > 0 ? s + x * Math.log2(x) : s), 0);

export default function SoftmaxTemperature({ params, preset, playing, resetKey, width, height, setReadouts }: DemoProps) {
  const tau = Number(params.tau ?? 1);
  const showScores = Boolean(params.showScores);
  const sweep = Boolean(params.sweep ?? true);

  // Fixed, seeded vectors: the same numbers on every render.
  const scores = useMemo(() => {
    const next = rng(7);
    const q = randMatrix(QUERIES.length, D, next, 0.9);
    const k = randMatrix(TOKENS.length, D, next, 0.9);
    return q.map((qi) => k.map((kj) => dot(qi, kj)));
  }, []);
  const probs = useMemo(() => scores.map((row) => softmax(row, tau)), [scores, tau]);

  const sim = useSim(() => ({ t: 0 }), [resetKey, preset]);

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const s = sim.current;
        if (sweep) s.t += dt;
        const row = Math.floor(s.t / SWEEP) % QUERIES.length;
        const p = probs[row];

        // Layout: heatmap on the left, the highlighted row as bars on the right,
        // the whole block centred vertically.
        const m = 24;
        const split = Math.round(width * 0.54);
        const cell = Math.min((split - 2 * m - 32) / TOKENS.length, (height - 2 * m - 80) / QUERIES.length, 52);
        const blockH = cell * QUERIES.length + 19;
        const top = Math.max(m + 36, (height - blockH) / 2);
        draw.text(ctx, "softmax(scores / τ), one row per query", m, top - 24, { color: theme.muted });
        const grid = draw.matrix(ctx, probs, { left: m, top, width: split - 2 * m, height: blockH }, {
          map: sequential,
          domain: [0, 1],
          rowLabels: QUERIES,
          colLabels: TOKENS,
          showValues: true,
          format: (v) => v.toFixed(2),
          highlight: { row },
        });

        const bx = split + 8;
        const bw = width - bx - m;
        const best = p.indexOf(Math.max(...p));
        draw.chip(ctx, `query: ${QUERIES[row]}`, bx, top - 24, { align: "left", active: true });
        draw.text(ctx, `τ = ${tau.toFixed(2)}`, width - m, top - 24, { kind: "mono", align: "right", color: theme.muted });
        const barsBottom = grid.top + grid.height + 18;
        draw.bars(ctx, p, { left: bx, top: grid.top, width: bw, height: barsBottom - grid.top }, {
          labels: TOKENS,
          min: 0,
          max: 1,
          highlight: best,
          showValues: true,
          format: (v) => v.toFixed(2),
        });
        if (showScores) {
          const slot = bw / TOKENS.length;
          draw.text(ctx, "score", bx - 6, barsBottom + 16, { align: "right", color: theme.faint });
          scores[row].forEach((v, i) => draw.text(ctx, v.toFixed(1), bx + slot * i + slot / 2, barsBottom + 16, { kind: "mono", align: "center", color: theme.faint }));
        }

        setReadouts({
          entropy: `${fmt(entropy(p), 2)} bits`,
          max: fmt(Math.max(...p), 3),
          sum: fmt(p.reduce((a, b) => a + b, 0), 3),
          best: TOKENS[best],
        });
      }}
    />
  );
}
