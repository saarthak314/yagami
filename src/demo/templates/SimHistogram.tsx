// sim-histogram: a seeded random experiment repeated many times; the histogram fills in and
// approaches the expected distribution.

import { useMemo } from "react";
import { axes, draw, rng, theme, useSim } from "../kit";
import { Stage } from "./stage";
import { compile, type Env } from "./expr";
import type { SimHistogramConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, logTicks, niceTicks, opt, paramEnv, randomFns, readoutValues, val, type TemplateProps } from "./runtime";

const HOLD = 2; // seconds the full histogram stays up before the run repeats
const MAX_TRIALS = 20000;
const PROCESS_BUDGET = 3_000_000; // process steps over all trials

export default function SimHistogram({ config, params, preset, playing, resetKey, width, height, setReadouts }: TemplateProps<SimHistogramConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      trial: config.trial !== undefined ? compile(config.trial) : null,
      process: config.process
        ? {
            init: Object.entries(config.process.init).map(([k, v]) => [k, opt(v)!] as const),
            step: Object.entries(config.process.step).map(([k, v]) => [k, compile(v)] as const),
            until: config.process.until ? compile(config.process.until) : null,
            maxSteps: opt(config.process.maxSteps),
            result: compile(config.process.result),
          }
        : null,
      trials: opt(config.trials)!,
      bins: config.bins && config.bins !== "integer" ? { min: opt(config.bins.min)!, max: opt(config.bins.max)!, count: config.bins.count, log: !!config.bins.log } : config.bins,
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
    const fns = randomFns(next);
    const total = Math.max(1, Math.min(MAX_TRIALS, Math.round(val(c.trials, env))));
    const tEnv = { ...env, ...fns };
    const p = c.process;
    let budget = PROCESS_BUDGET;
    const playOnce = (): number => {
      // A multi-step process: state variables updated together each step until `until` holds.
      const s: Env = { ...tEnv, k: 0 };
      for (const [name, v] of p!.init) s[name] = val(v, s);
      const cap = Math.max(1, Math.min(100000, Math.round(p!.maxSteps !== undefined ? val(p!.maxSteps, s) : 1000)));
      let k = 0;
      while (k < cap && budget > 0 && !(p!.until && val(p!.until, s))) {
        const next = p!.step.map(([name, e]) => [name, val(e, s)] as const);
        for (const [name, v] of next) s[name] = v;
        s.k = ++k;
        budget--;
      }
      return val(p!.result, s);
    };
    const results: number[] = [];
    for (let i = 0; i < total && (!p || budget > 0); i++) results.push(p ? playOnce() : val(c.trial ?? undefined, tEnv));
    const finite = results.filter(Number.isFinite);
    const cats = config.categories?.length ?? 0;
    const integer = cats > 0 || c.bins === "integer" || (c.bins === undefined && finite.every((v) => Number.isInteger(v)));
    let lo: number;
    let hi: number;
    let count: number;
    const log = !integer && !!c.bins && c.bins !== "integer" && c.bins.log;
    if (cats) {
      lo = 0;
      hi = cats - 1;
      count = cats;
    } else if (integer) {
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
    if (log) lo = Math.max(1e-9, lo);
    if (!(hi > lo)) hi = log ? lo * 10 : lo + 1;
    count = Math.max(1, Math.min(60, count));
    return { env, results, integer, lo, hi, count, total: results.length, log };
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
        const { lo, hi, count, integer, log } = run;
        const width1 = integer ? 1 : (hi - lo) / count;
        // Log bins: equal widths in log x (edges lo·(hi/lo)^(b/count)).
        const span = Math.log(hi / lo);
        const edge = (b: number) => (log ? lo * Math.exp((span * b) / count) : lo + b * width1);
        const counts = new Array<number>(count).fill(0);
        for (const v of sample) {
          const b = integer ? Math.round(v) - lo : log ? (v > 0 ? Math.floor((Math.log(v / lo) / span) * count) : -1) : Math.min(count - 1, Math.floor((v - lo) / width1));
          if (b >= 0 && b < count) counts[b]++;
          else if (log && b === count && v <= hi) counts[count - 1]++;
        }
        const shares = counts.map((k) => k / Math.max(1, sample.length));
        const expected = c.expected
          ? counts.map((_, b) => {
              if (log) {
                const x = Math.sqrt(edge(b) * edge(b + 1));
                return val(c.expected!, { ...run.env, x }) * (edge(b + 1) - edge(b));
              }
              const x = integer ? lo + b : lo + (b + 0.5) * width1;
              const p = val(c.expected!, { ...run.env, x });
              return integer ? p : p * width1;
            })
          : [];
        const top = Math.max(0.01, ...shares, ...expected.filter(Number.isFinite)) * 1.15;

        const yTicks = niceTicks(0, top, Math.max(2, Math.floor((height - 90) / 46)));
        const box = { left: 52, top: 26, width: width - 52 - 30, height: height - 26 - 46 };
        const xAt = log
          ? (v: number) => box.left + (Math.log(Math.max(lo, v) / lo) / span) * box.width
          : (v: number) => box.left + ((v - (integer ? lo - 0.5 : lo)) / ((integer ? hi + 0.5 : hi) - (integer ? lo - 0.5 : lo))) * box.width;
        const xTickVals = log ? logTicks(lo, hi) : integer ? niceTicks(lo, hi, Math.max(2, Math.floor(box.width / 46))).filter((v) => Number.isInteger(v)) : niceTicks(lo, hi, Math.max(2, Math.floor(box.width / 70)));
        const ax = axes(ctx, box, {
          xDomain: log ? [0, 1] : [integer ? lo - 0.5 : lo, integer ? hi + 0.5 : hi],
          yDomain: [0, top],
          yTicks,
          xTicks: log || config.categories?.length ? [] : xTickVals,
          xFormat: (v) => fmtTick(v, xTickVals),
          yFormat: (v) => fmtTick(v, yTicks),
          grid: true,
        });
        if (log)
          for (const tv of xTickVals) {
            draw.line(ctx, xAt(tv), box.top + box.height, xAt(tv), box.top + box.height + 4, { color: theme.muted, width: 1 });
            draw.text(ctx, fmtTick(tv, xTickVals), xAt(tv), box.top + box.height + 14, { kind: "mono", align: "center", color: theme.faint });
          }
        const bw = (box.width / count) * 0.78;
        const binX = (b: number) => (log ? (xAt(edge(b)) + xAt(edge(b + 1))) / 2 : integer ? xAt(lo + b) : xAt(lo + (b + 0.5) * width1));
        shares.forEach((sh, b) => {
          const x = binX(b);
          if (sh > 0) draw.rect(ctx, x - bw / 2, ax.y(sh), bw, ax.y(0) - ax.y(sh), { color: theme.muted, fill: theme.muted, width: 0.5 });
        });
        if (expected.length) {
          const pts: [number, number][] = expected.map((p, b) => [binX(b), ax.y(Math.max(0, Math.min(top, p)))]);
          draw.polyline(ctx, pts, { color: theme.accent, width: 1.75 });
          for (const [x, y] of pts) draw.dot(ctx, x, y, 2.5, theme.accent);
          draw.text(ctx, "expected", box.left + box.width - 2, box.top + 4, { color: theme.accent, align: "right" });
        }
        config.categories?.forEach((name, b) => draw.text(ctx, name, binX(b), box.top + box.height + 14, { kind: "mono", align: "center", color: theme.muted }));
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
