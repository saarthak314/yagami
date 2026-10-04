// sim-histogram: a seeded random experiment repeated many times; the histogram fills in and
// approaches the expected distribution.

import { useMemo } from "react";
import { Stage, axes, draw, randn, rng, theme, useSim } from "../kit";
import { compile, type Env } from "./expr";
import type { SimHistogramConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, niceTicks, opt, paramEnv, readoutValues, val, type TemplateProps } from "./runtime";

const HOLD = 2; // seconds the full histogram stays up before the run repeats
const MAX_TRIALS = 20000;

export default function SimHistogram({ config, params, preset, playing, resetKey, width, height, setReadouts }: TemplateProps<SimHistogramConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      trial: compile(config.trial),
      trials: opt(config.trials)!,
      bins: config.bins && config.bins !== "integer" ? { min: opt(config.bins.min)!, max: opt(config.bins.max)!, count: config.bins.count } : config.bins,
      expected: config.expected ? compile(config.expected) : undefined,
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );

  // Every result is drawn up front (deterministic for the seed and params); the animation reveals them.
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env: Env = applyDefs(paramEnv(params), c.defs);
    const next = rng(config.seed ?? 1);
    const fns: Env = {
      rand: () => next(),
      randn: () => randn(next),
      randint: (a, b) => {
        const lo = Math.ceil(Number(a));
        const hi = Math.floor(Number(b));
        return lo + Math.floor(next() * (hi - lo + 1));
      },
      coin: (p) => (next() < Number(p ?? 0.5) ? 1 : 0),
    };
    const total = Math.max(1, Math.min(MAX_TRIALS, Math.round(val(c.trials, env))));
    const tEnv = { ...env, ...fns };
    const results = Array.from({ length: total }, () => val(c.trial, tEnv));
    const finite = results.filter(Number.isFinite);
    const integer = c.bins === "integer" || (c.bins === undefined && finite.every((v) => Number.isInteger(v)));
    let lo: number;
    let hi: number;
    let count: number;
    if (integer) {
      lo = Math.min(...finite);
      hi = Math.max(...finite);
      count = hi - lo + 1;
    } else if (c.bins && c.bins !== "integer") {
      lo = val(c.bins.min, env);
      hi = val(c.bins.max, env);
      count = c.bins.count ?? 24;
    } else {
      lo = Math.min(...finite);
      hi = Math.max(...finite);
      count = 24;
    }
    if (!(hi > lo)) hi = lo + 1;
    count = Math.max(1, Math.min(60, count));
    return { env, results, integer, lo, hi, count, total };
  }, [c, paramsKey, config.seed]); // params enter through paramsKey

  const perSecond = config.perSecond ?? Math.max(20, run.total / 5);
  const sim = useSim(() => ({ shown: 0, hold: 0 }), [resetKey, preset, paramsKey]);

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const s = sim.current;
        if (s.hold > 0) {
          s.hold -= dt;
          if (s.hold <= 0) s.shown = 0;
        } else {
          s.shown = Math.min(run.total, s.shown + dt * perSecond);
          if (s.shown >= run.total && dt > 0) s.hold = HOLD;
        }
        // Paused before anything ran: show the whole experiment (a still frame should be informative).
        const n = playing || s.shown > 0 ? Math.max(1, Math.floor(s.shown)) : run.total;
        const sample = run.results.slice(0, n).filter(Number.isFinite);

        // Histogram (share of trials per bin).
        const { lo, hi, count, integer } = run;
        const width1 = integer ? 1 : (hi - lo) / count;
        const counts = new Array<number>(count).fill(0);
        for (const v of sample) {
          const b = integer ? Math.round(v) - lo : Math.min(count - 1, Math.floor((v - lo) / width1));
          if (b >= 0 && b < count) counts[b]++;
        }
        const shares = counts.map((k) => k / Math.max(1, sample.length));
        const expected = c.expected
          ? counts.map((_, b) => {
              const x = integer ? lo + b : lo + (b + 0.5) * width1;
              const p = val(c.expected!, { ...run.env, x });
              return integer ? p : p * width1;
            })
          : [];
        const top = Math.max(0.01, ...shares, ...expected.filter(Number.isFinite)) * 1.15;

        const yTicks = niceTicks(0, top, Math.max(2, Math.floor((height - 90) / 46)));
        const box = { left: 52, top: 26, width: width - 52 - 30, height: height - 26 - 46 };
        const xAt = (v: number) => box.left + ((v - (integer ? lo - 0.5 : lo)) / ((integer ? hi + 0.5 : hi) - (integer ? lo - 0.5 : lo))) * box.width;
        const xTickVals = integer ? niceTicks(lo, hi, Math.max(2, Math.floor(box.width / 46))).filter((v) => Number.isInteger(v)) : niceTicks(lo, hi, Math.max(2, Math.floor(box.width / 70)));
        const ax = axes(ctx, box, {
          xDomain: [integer ? lo - 0.5 : lo, integer ? hi + 0.5 : hi],
          yDomain: [0, top],
          yTicks,
          xTicks: xTickVals,
          xFormat: (v) => fmtTick(v, xTickVals),
          yFormat: (v) => fmtTick(v, yTicks),
          grid: true,
        });
        const bw = (box.width / count) * 0.78;
        shares.forEach((sh, b) => {
          const x = integer ? xAt(lo + b) : xAt(lo + (b + 0.5) * width1);
          if (sh > 0) draw.rect(ctx, x - bw / 2, ax.y(sh), bw, ax.y(0) - ax.y(sh), { color: theme.muted, fill: theme.muted, width: 0.5 });
        });
        if (expected.length) {
          const pts: [number, number][] = expected.map((p, b) => [integer ? xAt(lo + b) : xAt(lo + (b + 0.5) * width1), ax.y(Math.max(0, Math.min(top, p)))]);
          draw.polyline(ctx, pts, { color: theme.accent, width: 1.75 });
          for (const [x, y] of pts) draw.dot(ctx, x, y, 2.5, theme.accent);
          draw.text(ctx, "expected", box.left + box.width - 2, box.top + 4, { color: theme.accent, align: "right" });
        }
        if (config.xLabel) draw.text(ctx, config.xLabel, box.left + box.width / 2, box.top + box.height + 30, { kind: "label", align: "center", color: theme.muted });
        draw.text(ctx, `${sample.length} trials`, box.left + 6, box.top + 4, { kind: "mono", color: theme.muted });

        const mean = sample.reduce((a, b) => a + b, 0) / Math.max(1, sample.length);
        const sd = Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sample.length));
        const frac = (a: unknown, b: unknown) => sample.filter((v) => v >= Number(a) && v <= Number(b)).length / Math.max(1, sample.length);
        setReadouts(readoutValues(c.readouts, { ...run.env, n: sample.length, mean, sd, last: sample[sample.length - 1] ?? NaN, frac: frac as never }));
      }}
    />
  );
}
