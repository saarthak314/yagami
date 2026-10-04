// ode-sim: state variables integrated with RK4 from expression derivatives; a scene and/or time plots.

import { useMemo } from "react";
import { Stage, axes, draw, rk4, scale, theme, useSim } from "../kit";
import { compile, type Compiled, type Env } from "./expr";
import type { Color, OdeSimConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, niceTicks, opt, paramEnv, readoutValues, spread, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, SERIES, tc } from "./ui";

const HOLD = 1.5; // seconds a finished run stays up before it restarts

export default function OdeSim({ config, params, preset, playing, resetKey, width, height, setReadouts }: TemplateProps<OdeSimConfig>) {
  const vars = useMemo(() => Object.keys(config.state), [config]);
  const c = useMemo(() => {
    const s = config.scene;
    return {
      defs: compileDefs(config.defs),
      init: vars.map((v) => opt(config.state[v])!),
      deriv: vars.map((v) => compile(config.deriv[v])),
      stop: config.stop ? compile(config.stop) : undefined,
      tMax: opt(config.tMax),
      scene: s && {
        x: s.x.map((v) => opt(v)!) as [Compiled | number, Compiled | number],
        y: s.y.map((v) => opt(v)!) as [Compiled | number, Compiled | number],
        ground: opt(s.ground),
        bodies: (s.bodies ?? []).map((b) => ({ ...b, cx: compile(b.x), cy: compile(b.y) })),
        links: (s.links ?? []).map((l) => ({ ...l, c: [l.x1, l.y1, l.x2, l.y2].map((v) => opt(v)!) })),
        arrows: (s.arrows ?? []).map((a) => ({ ...a, c: [a.x, a.y, a.dx, a.dy].map((v) => opt(v)!) })),
      },
      plot: config.plot
        ? { series: config.plot.y.map((p) => ({ ...p, c: compile(p.expr) })), min: opt(config.plot.min), max: opt(config.plot.max) }
        : !config.scene
          ? { series: vars.map((v): PlotSeries => ({ label: v, c: compile(v) })), min: undefined, max: undefined }
          : undefined,
      readouts: compileReadouts(config.readouts),
    };
  }, [config, vars]);

  const paramsKey = JSON.stringify(params);
  const base = () => applyDefs(paramEnv(params), c.defs);
  const sim = useSim(() => {
    const env = base();
    return {
      y: c.init.map((i) => val(i, env)),
      t: 0,
      hold: 0,
      hist: [] as { t: number; v: number[] }[],
      trails: c.scene?.bodies.map(() => [] as [number, number][]) ?? [],
      lo: Infinity,
      hi: -Infinity,
    };
  }, [resetKey, preset, paramsKey, c]);

  const dtSim = config.dt ?? 0.005;
  const speed = config.speed ?? 1;
  const span = config.plot?.span;

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const s = sim.current;
        const env0 = base();
        const stateEnv = (y: number[], t: number): Env => {
          const e: Env = { ...env0, t };
          vars.forEach((v, i) => (e[v] = y[i]));
          return e;
        };
        const restart = () => {
          const e = base();
          s.y = c.init.map((i) => val(i, e));
          s.t = 0;
          s.hold = 0;
          s.hist = [];
          s.trails = s.trails.map(() => []);
        };

        // Advance.
        if (dt > 0) {
          if (s.hold > 0) {
            s.hold -= dt;
            if (s.hold <= 0) restart();
          } else {
            let left = dt * speed;
            const steps = Math.min(4000, Math.ceil(left / dtSim));
            const h = left / Math.max(1, steps);
            for (let k = 0; k < steps; k++) {
              const t = s.t;
              const f = (y: number[], tt: number) => c.deriv.map((d) => val(d, stateEnv(y, tt)));
              const next = rk4(s.y, h, (y) => f(y, t));
              if (next.some((v) => !Number.isFinite(v))) break;
              const ended = (y: number[], tt: number) => {
                const e = stateEnv(y, tt);
                return (c.stop !== undefined && !!val(c.stop, e)) || (c.tMax !== undefined && tt >= val(c.tMax, e));
              };
              if (ended(next, t + h)) {
                // Land exactly on the stop condition: bisect the step (so e.g. a ball stops at the ground).
                let lo = 0;
                let hi = h;
                for (let b = 0; b < 30; b++) {
                  const mid = (lo + hi) / 2;
                  if (ended(rk4(s.y, mid, (y) => f(y, t)), t + mid)) hi = mid;
                  else lo = mid;
                }
                s.y = rk4(s.y, hi, (y) => f(y, t));
                s.t += hi;
                s.hold = HOLD;
                break;
              }
              s.y = next;
              s.t += h;
              left -= h;
            }
          }
        }
        const env = stateEnv(s.y, s.t);

        // Record history for the plot and trails.
        if (c.plot) {
          const v = c.plot.series.map((p) => val(p.c, env));
          const last = s.hist[s.hist.length - 1];
          if (!last || s.t - last.t > 0.01 || s.hist.length === 0) s.hist.push({ t: s.t, v });
          if (s.hist.length > 4000) s.hist.splice(0, s.hist.length - 4000);
          for (const x of v) if (Number.isFinite(x)) (s.lo = Math.min(s.lo, x)), (s.hi = Math.max(s.hi, x));
        }

        // Layout: scene and plot side by side when wide, stacked when tall.
        const m = 20;
        const both = !!c.scene && !!c.plot;
        const wide = width >= height * 1.15;
        const sceneBox = both ? (wide ? { left: m, top: m, width: width * 0.46 - m, height: height - 2 * m } : { left: m, top: m, width: width - 2 * m, height: height * 0.5 - m }) : { left: m, top: m, width: width - 2 * m, height: height - 2 * m };
        const plotBox = both ? (wide ? { left: width * 0.46 + 8, top: m, width: width * 0.54 - 8 - m, height: height - 2 * m } : { left: m, top: height * 0.5 + 4, width: width - 2 * m, height: height * 0.5 - 4 - m }) : sceneBox;

        if (c.scene) drawScene(ctx, c.scene, env, sceneBox, s.trails);
        if (c.plot) drawPlot(ctx, c.plot, s, env, plotBox, span);

        setReadouts(readoutValues(c.readouts, env));
      }}
    />
  );
}

type Field = Compiled | number;
type SceneCfg = NonNullable<OdeSimConfig["scene"]>;
interface Scene {
  x: [Field, Field];
  y: [Field, Field];
  ground?: Field;
  bodies: (NonNullable<SceneCfg["bodies"]>[number] & { cx: Compiled; cy: Compiled })[];
  links: (NonNullable<SceneCfg["links"]>[number] & { c: Field[] })[];
  arrows: (NonNullable<SceneCfg["arrows"]>[number] & { c: Field[] })[];
}
interface PlotSeries {
  label?: string;
  color?: Color;
  dashed?: boolean;
  c: Compiled;
}
type Box = { left: number; top: number; width: number; height: number };

function drawScene(ctx: CanvasRenderingContext2D, sc: Scene, env: Env, box: Box, trails: [number, number][][]) {
  let [x0, x1] = sc.x.map((v) => val(v, env));
  let [y0, y1] = sc.y.map((v) => val(v, env));
  if (!(x1 > x0)) [x0, x1] = [-1, 1];
  if (!(y1 > y0)) [y0, y1] = [-1, 1];
  // Inner padding so bodies and labels at the range edges stay inside.
  const pad = 14;
  const inner = { left: box.left + pad, top: box.top + pad, width: box.width - 2 * pad - 24, height: box.height - 2 * pad - 10 };
  let sx = scale([x0, x1], [inner.left, inner.left + inner.width]);
  let sy = scale([y0, y1], [inner.top + inner.height, inner.top]);
  // Equal aspect when asked (or when the ranges are similar): keep shapes true.
  const kx = inner.width / (x1 - x0);
  const ky = inner.height / (y1 - y0);
  const k = Math.min(kx, ky);
  const cx = inner.left + inner.width / 2;
  const cy = inner.top + inner.height / 2;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  if (Math.abs(Math.log(kx / ky)) < 0.7) {
    sx = (v: number) => cx + (v - mx) * k;
    sy = (v: number) => cy - (v - my) * k;
  }

  if (sc.ground !== undefined) {
    const g = val(sc.ground, env);
    if (Number.isFinite(g)) draw.ground(ctx, box.left + 6, box.left + box.width - 6, Math.min(sy(g), box.top + box.height - 10), { color: theme.muted });
  }
  for (const l of sc.links) {
    const [a, b, c2, d] = l.c.map((v) => val(v, env));
    if (![a, b, c2, d].every(Number.isFinite)) continue;
    if (l.kind === "spring") draw.spring(ctx, sx(a), sy(b), sx(c2), sy(d), { color: theme.muted, coils: 9, amp: 6 });
    else draw.line(ctx, sx(a), sy(b), sx(c2), sy(d), { color: theme.muted, width: 1.25, dash: l.dashed ? [4, 4] : undefined });
  }
  sc.bodies.forEach((b, i) => {
    const x = val(b.cx, env);
    const y = val(b.cy, env);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const X = sx(x);
    const Y = sy(y);
    if (b.trail) {
      const tr = trails[i];
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last[0] - X, last[1] - Y) > 1.5) tr.push([X, Y]);
      if (tr.length > 400) tr.splice(0, tr.length - 400);
      draw.polyline(ctx, tr, { color: tc(b.color, "accent"), width: 1, alpha: 0.5 });
    }
    const r = b.r ?? 7;
    draw.circle(ctx, X, Y, r, { color: tc(b.color, "fg"), width: 1.5 });
    if (b.label) {
      const w = textWidth(ctx, b.label, theme.fonts.symbol);
      const lx = X + r + 5 + w > box.left + box.width ? X - r - 5 - w : X + r + 5;
      draw.text(ctx, b.label, lx, Y, { kind: "symbol" });
    }
  });
  for (const a of sc.arrows) {
    const [x, y, dx, dy] = a.c.map((v) => val(v, env));
    if (![x, y, dx, dy].every(Number.isFinite)) continue;
    const X1 = sx(x);
    const Y1 = sy(y);
    const X2 = sx(x + dx);
    const Y2 = sy(y + dy);
    if (Math.hypot(X2 - X1, Y2 - Y1) < 2) continue;
    const color = tc(a.color, "accent");
    draw.arrow(ctx, X1, Y1, X2, Y2, { color, width: 1.5 });
    if (a.label) {
      const w = textWidth(ctx, a.label, theme.fonts.symbol);
      const lx = Math.min(Math.max(X2 + 6, box.left), box.left + box.width - w);
      draw.text(ctx, a.label, lx, Math.min(Math.max(Y2, box.top + 8), box.top + box.height - 8), { kind: "symbol", color });
    }
  }
}

function drawPlot(
  ctx: CanvasRenderingContext2D,
  plot: { series: PlotSeries[]; min?: Field; max?: Field },
  s: { t: number; hist: { t: number; v: number[] }[]; lo: number; hi: number },
  env: Env,
  box: Box,
  span: number | undefined,
) {
  const tEnd = Math.max(s.t, 1e-6);
  const t0 = span ? Math.max(0, tEnd - span) : 0;
  const t1 = span ? Math.max(span, tEnd) : Math.max(1, tEnd * 1.05);
  let lo = plot.min !== undefined ? val(plot.min, env) : s.lo;
  let hi = plot.max !== undefined ? val(plot.max, env) : s.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (hi - lo < 1e-9) [lo, hi] = [lo - 1, hi + 1];
  if (plot.min === undefined && lo > 0 && lo < (hi - lo) * 0.6) lo = 0;
  const padY = (hi - lo) * 0.08;
  if (plot.max === undefined) hi += padY;
  if (plot.min === undefined && lo !== 0) lo -= padY;

  const yTicks = niceTicks(lo, hi, Math.max(2, Math.floor(box.height / 48)));
  const xTicks = niceTicks(t0, t1, Math.max(2, Math.floor(box.width / 80)));
  const leftPad = 18 + Math.max(14, ...yTicks.map((v) => textWidth(ctx, fmtTick(v, yTicks))));
  const labelW = Math.max(0, ...plot.series.map((p) => (p.label ? textWidth(ctx, p.label, LABEL_FONT) + 10 : 0)));
  const inner = { left: box.left + leftPad, top: box.top + 10, width: Math.max(30, box.width - leftPad - Math.max(labelW, 18)), height: Math.max(30, box.height - 40) };
  const ax = axes(ctx, inner, {
    xDomain: [t0, t1],
    yDomain: [lo, hi],
    xTicks,
    yTicks,
    xFormat: (v) => fmtTick(v, xTicks),
    yFormat: (v) => fmtTick(v, yTicks),
    grid: true,
  });
  draw.text(ctx, "t", inner.left + inner.width, inner.top + inner.height + 28, { kind: "symbol", align: "right" });
  const ends: { y: number; label: string; color: string }[] = [];
  plot.series.forEach((p, i) => {
    const color = tc(p.color, SERIES[i % SERIES.length]);
    const pts: [number, number][] = [];
    for (const h of s.hist) if (h.t >= t0 && Number.isFinite(h.v[i])) pts.push([ax.x(h.t), ax.y(Math.min(hi, Math.max(lo, h.v[i])))]);
    draw.polyline(ctx, pts, { color, width: 1.5, dash: p.dashed ? [5, 4] : undefined });
    const last = pts[pts.length - 1];
    if (last) draw.dot(ctx, last[0], last[1], 2.5, color);
    if (p.label && last) ends.push({ y: last[1], label: p.label, color });
  });
  const ly = spread(
    ends.map((e) => e.y),
    14,
    inner.top + 4,
    inner.top + inner.height - 4,
  );
  ends.forEach((e, i) => draw.text(ctx, e.label, inner.left + inner.width + 6, ly[i], { color: e.color }));
}
