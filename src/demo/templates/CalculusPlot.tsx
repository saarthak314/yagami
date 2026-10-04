// calculus-plot: one curve f(x) with the tools of a first calculus course — a tangent and a secant at a,
// Riemann sums, a shaded area — and optional stacked graphs of f′ and ∫f sharing the x-axis.

import { useMemo, useRef } from "react";
import { Stage, draw, theme } from "../kit";
import type { Env } from "./expr";
import type { CalculusPlotConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, extent, opt, paramEnv, plotFrame, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";
import { compile } from "./expr";

/** ∫ f over [a, b] by Simpson's rule (NaN when f is undefined somewhere). */
function integrate(f: (x: number) => number, a: number, b: number, n = 400): number {
  if (!(Number.isFinite(a) && Number.isFinite(b))) return NaN;
  if (a === b) return 0;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

export default function CalculusPlot({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<CalculusPlotConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      f: compile(config.f),
      xMin: opt(config.x.min)!,
      xMax: opt(config.x.max)!,
      yMin: opt(config.y?.min),
      yMax: opt(config.y?.max),
      at: opt(config.at),
      h: opt(config.secant?.h),
      rFrom: opt(config.riemann?.from),
      rTo: opt(config.riemann?.to),
      rN: opt(config.riemann?.n),
      aFrom: opt(config.area?.from),
      aTo: opt(config.area?.to),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );
  const clock = useRef({ t: 0, key: resetKey });

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const k = clock.current;
        if (k.key !== resetKey) Object.assign(k, { t: 0, key: resetKey });
        k.t += dt;
        const seconds = config.sweep?.seconds ?? 6;
        const u = config.sweep ? (k.t % seconds) / seconds : 0;
        const env: Env = applyDefs({ ...paramEnv(params), t: k.t, u }, c.defs);
        const f = (x: number) => val(c.f, { ...env, x });

        let x0 = val(c.xMin, env);
        let x1 = val(c.xMax, env);
        if (!(x1 > x0)) [x0, x1] = [0, 1];
        const span = x1 - x0;
        const d = (x: number) => {
          const e = span * 1e-5;
          return (f(x + e) - f(x - e)) / (2 * e);
        };

        // Point, tangent, secant.
        const a = c.at !== undefined ? val(c.at, env) : NaN;
        const fa = f(a);
        const slope = d(a);
        const h = c.h !== undefined ? val(c.h, env) : NaN;
        const secant = (f(a + h) - fa) / h;

        // Riemann sum and the exact integral over the same range.
        const rule = config.riemann?.rule ?? "left";
        const rFrom = val(c.rFrom, env);
        const rTo = val(c.rTo, env);
        const n = Math.max(1, Math.min(400, Math.round(val(c.rN, env) || 1)));
        const rects: { xl: number; xr: number; yl: number; yr: number }[] = [];
        let riemann = NaN;
        if (config.riemann && Number.isFinite(rFrom) && Number.isFinite(rTo)) {
          const w = (rTo - rFrom) / n;
          riemann = 0;
          for (let i = 0; i < n; i++) {
            const xl = rFrom + i * w;
            const xr = xl + w;
            const yl = rule === "right" ? f(xr) : rule === "mid" ? f((xl + xr) / 2) : f(xl);
            const yr = rule === "trap" ? f(xr) : yl;
            riemann += rule === "trap" ? ((yl + yr) / 2) * w : yl * w;
            rects.push({ xl, xr, yl, yr });
          }
        }
        const exact = config.riemann ? integrate(f, rFrom, rTo) : NaN;
        const aFrom = c.aFrom !== undefined ? val(c.aFrom, env) : config.riemann ? rFrom : NaN;
        const aTo = c.aTo !== undefined ? val(c.aTo, env) : config.riemann ? rTo : NaN;
        const area = config.area || config.riemann ? integrate(f, aFrom, aTo) : NaN;

        // Samples.
        const m = Math.max(80, Math.min(500, Math.round(width)));
        const xs = Array.from({ length: m + 1 }, (_, i) => x0 + (span * i) / m);
        const ys = xs.map(f);

        // Layout: the main graph, then any stacked panels sharing x.
        const panels = config.panels ?? [];
        const pad = 10;
        const mainH = panels.length ? Math.max(150, (height - 2 * pad) * (panels.length === 1 ? 0.6 : 0.46)) : height - 2 * pad;
        const restH = panels.length ? (height - 2 * pad - mainH) / panels.length : 0;
        const label = config.label;
        const labelW = label ? textWidth(ctx, label, LABEL_FONT) + 14 : 0;

        let [y0, y1] = extent([...ys, ...(config.riemann ? [0, ...rects.map((r) => r.yl), ...rects.map((r) => r.yr)] : []), ...(config.area ? [0] : [])]);
        if (c.yMin !== undefined) y0 = val(c.yMin, env);
        if (c.yMax !== undefined) y1 = val(c.yMax, env);
        if (c.yMax === undefined) y1 += (y1 - y0) * 0.08;
        if (c.yMin === undefined && y0 < 0) y0 -= (y1 - y0) * 0.06;
        if (!(y1 > y0)) y1 = y0 + 1;

        const fr = plotFrame(ctx, { left: pad, top: pad, width: width - 2 * pad, height: mainH }, {
          x: [x0, x1],
          y: [y0, y1],
          xLabel: config.x.label,
          yLabel: config.y?.label,
          rightPad: labelW,
        });
        const clampY = (y: number) => Math.min(Math.max(y, fr.y0), fr.y1);
        const P = (x: number, y: number): [number, number] => [fr.px(x), fr.py(clampY(y))];
        const inY = (y: number) => Number.isFinite(y) && y >= fr.y0 && y <= fr.y1;

        ctx.save();
        ctx.beginPath();
        ctx.rect(fr.box.left, fr.box.top - 1, fr.box.width, fr.box.height + 2);
        ctx.clip();

        // Shaded area under the curve.
        if (config.area && Number.isFinite(aFrom) && Number.isFinite(aTo) && aTo > aFrom) {
          ctx.save();
          ctx.globalAlpha = 0.14;
          ctx.fillStyle = theme.accent;
          ctx.beginPath();
          const base = fr.py(clampY(0));
          ctx.moveTo(fr.px(aFrom), base);
          const steps = 120;
          for (let i = 0; i <= steps; i++) {
            const x = aFrom + ((aTo - aFrom) * i) / steps;
            const y = f(x);
            ctx.lineTo(fr.px(x), fr.py(clampY(Number.isFinite(y) ? y : 0)));
          }
          ctx.lineTo(fr.px(aTo), base);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        // Riemann rectangles (or trapezoids).
        for (const r of rects) {
          if (!(Number.isFinite(r.yl) && Number.isFinite(r.yr))) continue;
          const pts: [number, number][] = [P(r.xl, 0), P(r.xl, r.yl), P(r.xr, r.yr), P(r.xr, 0)];
          ctx.save();
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = theme.accent2;
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          draw.polyline(ctx, pts, { color: theme.accent2, width: n > 60 ? 0.75 : 1 });
        }

        // The curve.
        let seg: [number, number][] = [];
        const flush = () => {
          if (seg.length > 1) draw.polyline(ctx, seg, { color: theme.fg, width: 1.75 });
          seg = [];
        };
        xs.forEach((x, i) => (inY(ys[i]) ? seg.push([fr.px(x), fr.py(ys[i])]) : flush()));
        flush();

        // Secant and tangent through (a, f(a)).
        const lineThrough = (sl: number, color: string, dash?: number[]) => {
          if (!(Number.isFinite(a) && Number.isFinite(fa) && Number.isFinite(sl))) return;
          const xa = x0 - span;
          const xb = x1 + span;
          draw.line(ctx, fr.px(xa), fr.py(fa + sl * (xa - a)), fr.px(xb), fr.py(fa + sl * (xb - a)), { color, width: 1.5, dash });
        };
        if (config.secant && Number.isFinite(h) && h !== 0) lineThrough(secant, theme.accent2, [5, 4]);
        if (config.tangent) lineThrough(slope, theme.accent);
        ctx.restore();

        if (Number.isFinite(a) && inY(fa) && a >= x0 && a <= x1) {
          if (config.secant && Number.isFinite(h) && inY(f(a + h)) && a + h >= x0 && a + h <= x1) {
            draw.line(ctx, fr.px(a + h), fr.py(fa), fr.px(a + h), fr.py(f(a + h)), { color: theme.faint, width: 1, dash: [2, 3] });
            draw.line(ctx, fr.px(a), fr.py(fa), fr.px(a + h), fr.py(fa), { color: theme.faint, width: 1, dash: [2, 3] });
            draw.circle(ctx, fr.px(a + h), fr.py(f(a + h)), 3.5, { color: theme.accent2, width: 1.5 });
          }
          draw.circle(ctx, fr.px(a), fr.py(fa), 4, { color: theme.accent, width: 1.75 });
        }
        if (label) {
          let li = ys.length - 1;
          while (li > 0 && !inY(ys[li])) li--;
          if (inY(ys[li])) draw.text(ctx, label, fr.box.left + fr.box.width + 8, Math.max(fr.box.top + 6, Math.min(fr.box.top + fr.box.height - 6, fr.py(ys[li]))), { color: theme.fg });
        }

        // Stacked panels: f′ and ∫f over the same x range.
        panels.forEach((kind, pi) => {
          const top = pad + mainH + pi * restH;
          let vals: number[];
          if (kind === "derivative") vals = xs.map(d);
          else {
            vals = [0];
            for (let i = 1; i < xs.length; i++) vals.push(vals[i - 1] + ((ys[i - 1] + ys[i]) / 2) * (xs[i] - xs[i - 1]));
          }
          let [v0, v1] = extent([...vals, 0]);
          v1 += (v1 - v0) * 0.08;
          const pf = plotFrame(ctx, { left: pad, top, width: width - 2 * pad, height: restH }, {
            x: [x0, x1],
            y: [v0, v1],
            yLabel: kind === "derivative" ? "f′" : "∫ f",
            rightPad: labelW,
            xTicks: pi === panels.length - 1,
          });
          const pts: [number, number][] = [];
          xs.forEach((x, i) => {
            if (Number.isFinite(vals[i])) pts.push([pf.px(x), pf.py(Math.min(Math.max(vals[i], pf.y0), pf.y1))]);
          });
          draw.polyline(ctx, pts, { color: kind === "derivative" ? theme.accent : theme.accent2, width: 1.5 });
          if (Number.isFinite(a) && a >= x0 && a <= x1) {
            draw.line(ctx, pf.px(a), pf.box.top, pf.px(a), pf.box.top + pf.box.height, { color: theme.faint, width: 1, dash: [3, 4] });
            const i = Math.round(((a - x0) / span) * m);
            const v = kind === "derivative" ? slope : vals[Math.max(0, Math.min(vals.length - 1, i))];
            if (Number.isFinite(v) && v >= pf.y0 && v <= pf.y1) draw.circle(ctx, pf.px(a), pf.py(v), 3.5, { color: theme.fg, width: 1.5 });
          }
        });

        setReadouts(readoutValues(c.readouts, { ...env, a, fa, slope, secant, h, riemann, exact, error: riemann - exact, area, n }));
      }}
    />
  );
}
