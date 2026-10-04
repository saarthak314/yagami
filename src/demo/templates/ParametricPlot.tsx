// parametric-plot: curves x(s), y(s) or polar r(s), a point moving along one of them (velocity arrow,
// bold trail, a swept sector for equal-area arguments) and an optional vector field u(x, y), v(x, y).

import { useMemo, useRef } from "react";
import { draw, theme } from "../kit";
import { Stage } from "./stage";
import { compile, type Compiled, type Env } from "./expr";
import type { ParametricPlotConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, plotFrame, readoutValues, spread, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, SERIES, tc } from "./ui";

interface CompiledCurve {
  x?: Compiled;
  y?: Compiled;
  r?: Compiled;
  s0: Compiled | number;
  s1: Compiled | number;
}

export default function ParametricPlot({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<ParametricPlotConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      view: { x0: opt(config.view.x[0])!, x1: opt(config.view.x[1])!, y0: opt(config.view.y[0])!, y1: opt(config.view.y[1])! },
      curves: config.curves.map<CompiledCurve>((cv) => ({
        x: cv.r === undefined && cv.x !== undefined ? compile(cv.x) : undefined,
        y: cv.r === undefined && cv.y !== undefined ? compile(cv.y) : undefined,
        r: cv.r !== undefined ? compile(cv.r) : undefined,
        s0: opt(cv.s[0])!,
        s1: opt(cv.s[1])!,
      })),
      field: config.field ? { u: compile(config.field.u), v: compile(config.field.v) } : null,
      ps: opt(config.point?.s),
      trail: opt(config.point?.trail),
      sector: config.point?.sector ? { cx: opt(config.point.sector.cx)!, cy: opt(config.point.sector.cy)!, span: opt(config.point.sector.span)! } : null,
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
        const seconds = config.sweep?.seconds ?? 8;
        const u = config.sweep ? (k.t % seconds) / seconds : 0;
        const env: Env = applyDefs({ ...paramEnv(params), t: k.t, u }, c.defs);

        // A curve's point at s.
        const at = (cv: CompiledCurve, s: number): [number, number] => {
          const e = { ...env, s };
          if (cv.r) {
            const r = val(cv.r, e);
            return [r * Math.cos(s), r * Math.sin(s)];
          }
          return [val(cv.x, e), val(cv.y, e)];
        };

        const fr = plotFrame(ctx, { left: 10, top: 10, width: width - 20, height: height - 20 }, {
          x: [val(c.view.x0, env), val(c.view.x1, env)],
          y: [val(c.view.y0, env), val(c.view.y1, env)],
          equal: !!config.view.equal,
          xLabel: config.view.xLabel,
          yLabel: config.view.yLabel,
          rightPad: Math.max(0, ...config.curves.map((cv) => (cv.label ? textWidth(ctx, cv.label, LABEL_FONT) + 14 : 0))),
        });
        const inView = (x: number, y: number) => x >= fr.x0 && x <= fr.x1 && y >= fr.y0 && y <= fr.y1;
        const P = (x: number, y: number): [number, number] => [fr.px(x), fr.py(y)];

        ctx.save();
        ctx.beginPath();
        ctx.rect(fr.box.left, fr.box.top, fr.box.width, fr.box.height);
        ctx.clip();

        // Vector field on a grid; arrows scaled to the largest one (or all equal when normalised).
        if (c.field) {
          const nn = Math.max(4, Math.min(24, config.field?.n ?? 12));
          const cell = Math.min(fr.box.width, fr.box.height) / nn;
          const arrows: { x: number; y: number; u: number; v: number }[] = [];
          for (let i = 0; i < nn; i++)
            for (let j = 0; j < nn; j++) {
              const x = fr.x0 + ((i + 0.5) * (fr.x1 - fr.x0)) / nn;
              const y = fr.y0 + ((j + 0.5) * (fr.y1 - fr.y0)) / nn;
              const e = { ...env, x, y };
              arrows.push({ x, y, u: val(c.field.u, e), v: val(c.field.v, e) });
            }
          const mags = arrows.map((a) => Math.hypot(a.u, a.v)).filter(Number.isFinite);
          const maxMag = Math.max(1e-12, ...mags);
          const color = tc(config.field?.color, "faint");
          for (const a of arrows) {
            const mag = Math.hypot(a.u, a.v);
            if (!Number.isFinite(mag) || mag === 0) continue;
            const len = (config.field?.normalize ? 1 : mag / maxMag) * cell * 0.75;
            const [X, Y] = P(a.x, a.y);
            const ux = a.u / mag;
            const uy = -a.v / mag;
            draw.arrow(ctx, X - (ux * len) / 2, Y - (uy * len) / 2, X + (ux * len) / 2, Y + (uy * len) / 2, { color, width: 1, head: Math.min(5, len / 3) });
          }
        }

        // Curves.
        const samples = c.curves.map((cv) => {
          const s0 = val(cv.s0, env);
          const s1 = val(cv.s1, env);
          const m = 400;
          return Array.from({ length: m + 1 }, (_, i) => {
            const s = s0 + ((s1 - s0) * i) / m;
            return { s, p: at(cv, s) };
          });
        });
        const ends: { y: number; label: string; color: string }[] = [];
        config.curves.forEach((cv, ci) => {
          const color = tc(cv.color, SERIES[ci % SERIES.length]);
          let seg: [number, number][] = [];
          const flush = () => {
            if (seg.length > 1) draw.polyline(ctx, seg, { color, width: 1.5, dash: cv.dashed ? [5, 4] : undefined });
            seg = [];
          };
          for (const { p } of samples[ci]) {
            if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) < 1e9 && Math.abs(p[1]) < 1e9) seg.push(P(p[0], p[1]));
            else flush();
          }
          flush();
          if (cv.label) {
            const last = [...samples[ci]].reverse().find(({ p }) => inView(p[0], p[1]));
            if (last) ends.push({ y: fr.py(last.p[1]), label: cv.label, color });
          }
        });

        // The moving point.
        const vars: Record<string, number> = { s: NaN, px: NaN, py: NaN, vx: NaN, vy: NaN, speed: NaN, r: NaN, theta: NaN, sector: NaN, length: NaN };
        const point = config.point;
        if (point && c.ps !== undefined) {
          const ci = Math.max(0, Math.min(c.curves.length - 1, point.curve ?? 0));
          const cv = c.curves[ci];
          const s = val(c.ps, env);
          const [x, y] = at(cv, s);
          const ds = Math.max(1e-6, Math.abs(val(cv.s1, env) - val(cv.s0, env)) * 1e-5);
          const p1 = at(cv, s + ds);
          const p0 = at(cv, s - ds);
          const vx = (p1[0] - p0[0]) / (2 * ds);
          const vy = (p1[1] - p0[1]) / (2 * ds);
          // Arc length from the curve's start to s.
          const sStart = val(cv.s0, env);
          let length = 0;
          if (Number.isFinite(s) && Number.isFinite(sStart)) {
            const steps = 300;
            let prev = at(cv, sStart);
            for (let i = 1; i <= steps; i++) {
              const q = at(cv, sStart + ((s - sStart) * i) / steps);
              length += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
              prev = q;
            }
          }
          let sector = NaN;
          if (c.sector) {
            const cx = val(c.sector.cx, env);
            const cy = val(c.sector.cy, env);
            const span = val(c.sector.span, env);
            const steps = 80;
            const poly: [number, number][] = [[cx, cy]];
            for (let i = 0; i <= steps; i++) poly.push(at(cv, s - span + (span * i) / steps));
            sector = 0;
            for (let i = 0; i < poly.length; i++) {
              const [ax, ay] = poly[i];
              const [bx, by] = poly[(i + 1) % poly.length];
              sector += ax * by - bx * ay;
            }
            sector = Math.abs(sector) / 2;
            ctx.save();
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = theme.accent;
            ctx.beginPath();
            poly.forEach(([px, py], i) => (i ? ctx.lineTo(fr.px(px), fr.py(py)) : ctx.moveTo(fr.px(px), fr.py(py))));
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            draw.line(ctx, ...P(cx, cy), ...P(poly[1][0], poly[1][1]), { color: theme.accent, width: 1 });
            draw.line(ctx, ...P(cx, cy), ...P(x, y), { color: theme.accent, width: 1 });
          }
          if (c.trail !== undefined) {
            const span = val(c.trail, env);
            const pts: [number, number][] = [];
            for (let i = 0; i <= 60; i++) {
              const q = at(cv, s - span + (span * i) / 60);
              if (Number.isFinite(q[0]) && Number.isFinite(q[1])) pts.push(P(q[0], q[1]));
            }
            draw.polyline(ctx, pts, { color: theme.accent, width: 3 });
          }
          if (Number.isFinite(x) && Number.isFinite(y)) {
            if (point.velocity) {
              const sp = Math.hypot(vx, vy);
              const maxSp = Math.max(1e-12, ...samples[ci].slice(0, -1).map((q, i) => Math.hypot(samples[ci][i + 1].p[0] - q.p[0], samples[ci][i + 1].p[1] - q.p[1]) / Math.max(1e-12, samples[ci][i + 1].s - q.s)).filter(Number.isFinite));
              const len = (sp / maxSp) * Math.min(fr.box.width, fr.box.height) * 0.18;
              if (sp > 0) draw.arrow(ctx, fr.px(x), fr.py(y), fr.px(x) + (vx / sp) * len, fr.py(y) - (vy / sp) * len, { color: theme.accent2, width: 1.5 });
            }
            draw.circle(ctx, fr.px(x), fr.py(y), 5, { color: theme.accent, width: 2 });
          }
          Object.assign(vars, { s, px: x, py: y, vx, vy, speed: Math.hypot(vx, vy), r: Math.hypot(x, y), theta: (Math.atan2(y, x) * 180) / Math.PI, sector, length });
        }

        // Fixed points.
        const labels: { x: number; y: number; text: string; color: string }[] = [];
        for (const p of c.points) {
          const x = val(p.x, env);
          const y = val(p.y, env);
          if (!inView(x, y)) continue;
          draw.dot(ctx, fr.px(x), fr.py(y), 3.5, theme.fg);
          if (p.label) labels.push({ x: fr.px(x) + 7, y: fr.py(y) - 10, text: p.label, color: theme.fg });
        }
        if (point?.label && Number.isFinite(vars.px) && inView(vars.px, vars.py)) labels.push({ x: fr.px(vars.px) + 9, y: fr.py(vars.py) + 12, text: point.label, color: theme.accent });
        ctx.restore();

        for (const l of labels) {
          const w = textWidth(ctx, l.text, LABEL_FONT);
          const x = Math.max(fr.box.left + 2, Math.min(l.x, fr.box.left + fr.box.width - w - 2));
          const y = Math.max(fr.box.top + 8, Math.min(l.y, fr.box.top + fr.box.height - 8));
          draw.text(ctx, l.text, x, y, { color: l.color });
        }
        const ly = spread(
          ends.map((e) => e.y),
          15,
          fr.box.top + 6,
          fr.box.top + fr.box.height - 6,
        );
        ends.forEach((e, i) => draw.text(ctx, e.label, fr.box.left + fr.box.width + 8, ly[i], { color: e.color }));

        setReadouts(readoutValues(c.readouts, { ...env, ...vars }));
      }}
    />
  );
}
