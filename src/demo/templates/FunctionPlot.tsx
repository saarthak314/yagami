// function-plot: 1–4 curves y = f(x; params) with an optional marker, sweep and annotated points.

import { useMemo, useRef } from "react";
import { axes, draw, theme } from "../kit";
import { Stage } from "./stage";
import { compile, type Compiled, type Env } from "./expr";
import type { FunctionPlotConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, logTicks, niceTicks, opt, paramEnv, readoutValues, spread, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, SERIES, tc } from "./ui";

export default function FunctionPlot({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<FunctionPlotConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      xMin: opt(config.x.min)!,
      xMax: opt(config.x.max)!,
      yMin: opt(config.y?.min),
      yMax: opt(config.y?.max),
      curves: config.curves.map((cv) => compile(cv.y)),
      marker: opt(config.marker?.x),
      points: (config.points ?? []).map((p) => ({ x: opt(p.x)!, y: opt(p.y)!, label: p.label })),
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

        const xLog = !!config.x.log;
        const yLog = !!config.y?.log;
        let x0 = val(c.xMin, env);
        let x1 = val(c.xMax, env);
        if (!(x1 > x0)) [x0, x1] = [0, 1];
        if (xLog) x0 = Math.max(x0, x1 * 1e-9);

        // Sample every curve.
        const n = Math.max(80, Math.min(600, Math.round(width)));
        const xs = Array.from({ length: n + 1 }, (_, i) => (xLog ? x0 * (x1 / x0) ** (i / n) : x0 + ((x1 - x0) * i) / n));
        const curveAt = (cv: Compiled, x: number) => val(cv, { ...env, x });
        const ys = c.curves.map((cv) => xs.map((x) => curveAt(cv, x)));

        // y range: configured, else the data's (with headroom; include 0 when it is close).
        const finite = ys.flat().filter((v) => Number.isFinite(v) && (!yLog || v > 0));
        let y0 = c.yMin !== undefined ? val(c.yMin, env) : Math.min(...finite);
        let y1 = c.yMax !== undefined ? val(c.yMax, env) : Math.max(...finite);
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) [y0, y1] = [0, 1];
        if (!yLog && c.yMin === undefined && y0 > 0 && y0 < (y1 - y0) * 0.6) y0 = 0;
        if (y1 <= y0) y1 = y0 + (Math.abs(y0) || 1);
        if (!yLog) {
          const pad = (y1 - y0) * 0.08;
          if (c.yMax === undefined) y1 += pad;
          if (c.yMin === undefined && y0 !== 0) y0 -= pad;
        } else y0 = Math.max(y0, y1 * 1e-9);

        const tx = (v: number) => (xLog ? Math.log10(v) : v);
        const ty = (v: number) => (yLog ? Math.log10(Math.max(v, y0)) : v);
        const xTicks = xLog ? logTicks(x0, x1) : niceTicks(x0, x1, Math.max(2, Math.floor((width - 120) / 90)));
        const yTicks = yLog ? logTicks(y0, y1) : niceTicks(y0, y1, Math.max(2, Math.floor((height - 90) / 46)));
        const yLabels = yTicks.map((v) => fmtTick(v, yTicks));
        const xLabels = xTicks.map((v) => fmtTick(v, xTicks));

        // Margins from the labels that sit outside the plot box.
        const left = 22 + Math.max(16, ...yLabels.map((s) => textWidth(ctx, s)));
        const curveLabelW = Math.max(0, ...config.curves.map((cv) => (cv.label ? textWidth(ctx, cv.label, LABEL_FONT) + 12 : 0)));
        const xLabelW = config.x.label ? textWidth(ctx, config.x.label, LABEL_FONT) + 26 : 0;
        const right = Math.max(24, xLabelW, curveLabelW + 8);
        const top = config.y?.label ? 38 : 24;
        const bottom = 40;
        const box = { left, top, width: Math.max(40, width - left - right), height: Math.max(40, height - top - bottom) };
        const ax = axes(ctx, box, {
          xDomain: [tx(x0), tx(x1)],
          yDomain: [ty(y0), ty(y1)],
          xTicks: xTicks.map(tx),
          yTicks: yTicks.map(ty),
          xFormat: (v) => xLabels[xTicks.map(tx).indexOf(v)] ?? "",
          yFormat: (v) => yLabels[yTicks.map(ty).indexOf(v)] ?? "",
          xLabel: config.x.label,
          yLabel: config.y?.label,
          grid: true,
        });
        const px = (x: number) => ax.x(tx(x));
        const py = (y: number) => ax.y(ty(Math.min(Math.max(y, y0), y1)));
        const inY = (y: number) => Number.isFinite(y) && y >= y0 - (y1 - y0) * 1e-6 && y <= y1 + (y1 - y0) * 1e-6;

        // Curves (split where the curve leaves the range or isn't defined).
        const ends: { y: number; label: string; color: string }[] = [];
        config.curves.forEach((cv, ci) => {
          const color = tc(cv.color, SERIES[ci % SERIES.length]);
          const pts = ys[ci];
          if (cv.fill) {
            ctx.save();
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = color;
            ctx.beginPath();
            const base = py(yLog ? y0 : Math.min(Math.max(0, y0), y1));
            let open = false;
            xs.forEach((x, i) => {
              if (!Number.isFinite(pts[i])) return;
              if (!open) ctx.moveTo(px(x), base);
              open = true;
              ctx.lineTo(px(x), py(pts[i]));
            });
            ctx.lineTo(px(x1), base);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
          let seg: [number, number][] = [];
          const flush = () => {
            if (seg.length > 1) draw.polyline(ctx, seg, { color, width: ci === 0 ? 1.75 : 1.5, dash: cv.dashed ? [5, 4] : undefined });
            seg = [];
          };
          xs.forEach((x, i) => {
            if (inY(pts[i])) seg.push([px(x), py(pts[i])]);
            else flush();
          });
          flush();
          if (cv.label) {
            let li = pts.length - 1;
            while (li > 0 && !inY(pts[li])) li--;
            if (inY(pts[li])) ends.push({ y: py(pts[li]), label: cv.label, color });
          }
        });
        const ly = spread(
          ends.map((e) => e.y),
          15,
          box.top + 6,
          box.top + box.height - 6,
        );
        ends.forEach((e, i) => draw.text(ctx, e.label, box.left + box.width + 8, ly[i], { color: e.color }));

        // Fixed points.
        for (const p of c.points) {
          const x = val(p.x, env);
          const y = val(p.y, env);
          if (!Number.isFinite(x) || !inY(y) || x < x0 || x > x1) continue;
          draw.dot(ctx, px(x), py(y), 3.5, theme.fg);
          if (p.label) {
            const w = textWidth(ctx, p.label, LABEL_FONT);
            const lx = Math.min(px(x) + 7, box.left + box.width - w - 2);
            draw.text(ctx, p.label, lx, Math.max(box.top + 8, py(y) - 11), { color: theme.fg });
          }
        }

        // Marker: a vertical line at mx with the curves' values.
        const mx = c.marker !== undefined ? val(c.marker, env) : NaN;
        const yAt: Record<string, number> = {};
        c.curves.forEach((cv, i) => (yAt[`y${i + 1}`] = Number.isFinite(mx) ? curveAt(cv, mx) : NaN));
        if (Number.isFinite(mx) && mx >= x0 && mx <= x1) {
          const X = px(mx);
          draw.line(ctx, X, box.top, X, box.top + box.height, { color: theme.muted, width: 1, dash: [3, 4] });
          c.curves.forEach((_, i) => {
            const y = yAt[`y${i + 1}`];
            if (inY(y)) draw.circle(ctx, X, py(y), 4, { color: tc(config.curves[i].color, SERIES[i % SERIES.length]), width: 1.5 });
          });
          if (config.marker?.label) {
            const w = textWidth(ctx, config.marker.label, LABEL_FONT);
            const lx = Math.min(Math.max(X + 6, box.left + 4), box.left + box.width - w - 4);
            draw.text(ctx, config.marker.label, lx, box.top + 8, { color: theme.muted });
          }
        }

        setReadouts(readoutValues(c.readouts, { ...env, mx, ...yAt }));
      }}
    />
  );
}
