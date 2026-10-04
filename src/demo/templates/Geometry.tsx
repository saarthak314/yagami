// geometry: named points from expressions (later points may use earlier ones), segments, rays, lines,
// circles, polygons, angle marks and arcs, all moving with the parameters; distances, angles and areas
// as readouts.

import { useMemo, useRef } from "react";
import { Stage, draw, theme } from "../kit";
import { compileField, type Compiled, type Env, type Value } from "./expr";
import type { GeometryConfig, GeometryShape } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, tc } from "./ui";

type Pt = [number, number];

const asPt = (v: Value | undefined): Pt => (Array.isArray(v) && v.length >= 2 ? [Number(v[0]), Number(v[1])] : [NaN, NaN]);

/** Geometry functions over point values [x, y]. */
const GEO: Env = {
  dist: (a, b) => {
    const [ax, ay] = asPt(a);
    const [bx, by] = asPt(b);
    return Math.hypot(bx - ax, by - ay);
  },
  ang: (a, o, b) => {
    const [ax, ay] = asPt(a);
    const [ox, oy] = asPt(o);
    const [bx, by] = asPt(b);
    const t = Math.atan2(by - oy, bx - ox) - Math.atan2(ay - oy, ax - ox);
    const d = Math.abs(((t * 180) / Math.PI + 540) % 360 - 180);
    return d;
  },
  area: (...ps) => {
    const pts = ps.map(asPt);
    let s = 0;
    for (let i = 0; i < pts.length; i++) s += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
    return Math.abs(s) / 2;
  },
  mid: (a, b) => {
    const [ax, ay] = asPt(a);
    const [bx, by] = asPt(b);
    return [(ax + bx) / 2, (ay + by) / 2];
  },
  dir: (a, b) => {
    const [ax, ay] = asPt(a);
    const [bx, by] = asPt(b);
    return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  },
};

/** Evaluate every point (in order) into env: name → [x, y], name_x, name_y. */
function evalPoints(points: { name: string; x: Compiled | number; y: Compiled | number }[], env: Env): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const p of points) {
    const x = val(p.x, env);
    const y = val(p.y, env);
    out.set(p.name, [x, y]);
    env[p.name] = [x, y];
    env[`${p.name}_x`] = x;
    env[`${p.name}_y`] = y;
  }
  return out;
}

export default function Geometry({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<GeometryConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      points: config.points.map((p) => ({ ...p, x: compileField(p.x), y: compileField(p.y) })),
      shapes: (config.shapes ?? []).map((sh) => ({
        sh,
        r: "r" in sh ? opt(sh.r) : undefined,
        from: sh.kind === "arc" ? opt(sh.from) : undefined,
        to: sh.kind === "arc" ? opt(sh.to) : undefined,
      })),
      view: config.view ? { x0: opt(config.view.x[0])!, x1: opt(config.view.x[1])!, y0: opt(config.view.y[0])!, y1: opt(config.view.y[1])! } : null,
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );
  const paramsKey = JSON.stringify(params);

  // Auto view: fit everything over the sweep (sampled once per params), so the scale doesn't jump.
  const autoView = useMemo(() => {
    if (c.view) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const env: Env = applyDefs({ ...paramEnv(params), ...GEO, t: 0, u: i / 8 }, c.defs);
      const pts = evalPoints(c.points, env);
      for (const [x, y] of pts.values()) if (Number.isFinite(x) && Number.isFinite(y)) (xs.push(x), ys.push(y));
      for (const s of c.shapes) {
        if ((s.sh.kind === "circle" || s.sh.kind === "arc") && s.r !== undefined) {
          const ctr = pts.get(s.sh.center);
          const r = val(s.r, env);
          if (ctr && Number.isFinite(r)) xs.push(ctr[0] - r, ctr[0] + r), ys.push(ctr[1] - r, ctr[1] + r);
        }
      }
      if (!config.sweep) break;
    }
    if (!xs.length) return { x0: -1, x1: 1, y0: -1, y1: 1 };
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const pad = Math.max(x1 - x0, y1 - y0, 1e-9) * 0.14;
    return { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
  }, [c, paramsKey, config.sweep]); // params enter through paramsKey
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
        const env: Env = applyDefs({ ...paramEnv(params), ...GEO, t: k.t, u }, c.defs);
        const pts = evalPoints(c.points, env);

        // Equal-scale view centred in the stage.
        const v = c.view ? { x0: val(c.view.x0, env), x1: val(c.view.x1, env), y0: val(c.view.y0, env), y1: val(c.view.y1, env) } : autoView!;
        const m = 24;
        const sx = (width - 2 * m) / Math.max(1e-9, v.x1 - v.x0);
        const sy = (height - 2 * m) / Math.max(1e-9, v.y1 - v.y0);
        const sc = Math.min(sx, sy);
        const ox = m + (width - 2 * m - sc * (v.x1 - v.x0)) / 2;
        const oy = m + (height - 2 * m - sc * (v.y1 - v.y0)) / 2;
        const X = (x: number) => ox + (x - v.x0) * sc;
        const Y = (y: number) => oy + (v.y1 - y) * sc;
        const S = (p: Pt): Pt => [X(p[0]), Y(p[1])];
        const ok = (p: Pt | undefined): p is Pt => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

        if (config.grid) {
          const step = 10 ** Math.floor(Math.log10(Math.max(1e-9, (v.x1 - v.x0) / 6)));
          for (let x = Math.ceil(v.x0 / step) * step; x <= v.x1; x += step) draw.line(ctx, X(x), Y(v.y0), X(x), Y(v.y1), { color: theme.grid, width: 1 });
          for (let y = Math.ceil(v.y0 / step) * step; y <= v.y1; y += step) draw.line(ctx, X(v.x0), Y(y), X(v.x1), Y(y), { color: theme.grid, width: 1 });
        }

        const texts: { x: number; y: number; text: string; color: string }[] = [];
        const centroid: Pt = (() => {
          const list = [...pts.values()].filter(ok);
          return list.length ? [list.reduce((s, p) => s + p[0], 0) / list.length, list.reduce((s, p) => s + p[1], 0) / list.length] : [0, 0];
        })();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        for (const { sh, r, from, to } of c.shapes) {
          const color = tc(sh.color, sh.kind === "polygon" ? "accent" : "fg");
          const dash = "dashed" in sh && sh.dashed ? [5, 4] : undefined;
          if (sh.kind === "segment" || sh.kind === "ray" || sh.kind === "line") {
            const a = pts.get(sh.from);
            const b = pts.get(sh.to);
            if (!ok(a) || !ok(b)) continue;
            let [ax, ay] = S(a);
            let [bx, by] = S(b);
            const d = Math.hypot(bx - ax, by - ay) || 1;
            const far = width + height;
            if (sh.kind !== "segment") ((bx = ax + ((bx - ax) / d) * far), (by = ay + ((by - ay) / d) * far));
            if (sh.kind === "line") ((ax = ax - ((bx - ax) / far) * far), (ay = ay - ((by - ay) / far) * far));
            if ((sh as { arrow?: boolean }).arrow) draw.arrow(ctx, ax, ay, bx, by, { color, width: 1.5, dash });
            else draw.line(ctx, ax, ay, bx, by, { color, width: 1.5, dash });
            if (sh.label) {
              const [mx, my] = S([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
              const nx = -(by - ay) / d;
              const ny = (bx - ax) / d;
              texts.push({ x: mx + nx * 12, y: my + ny * 12, text: sh.label, color });
            }
          } else if (sh.kind === "circle") {
            const ctr = pts.get(sh.center);
            const rr = val(r, env);
            if (!ok(ctr) || !(rr > 0)) continue;
            draw.circle(ctx, X(ctr[0]), Y(ctr[1]), rr * sc, { color, width: 1.5, dash, fill: null });
            if (sh.label) texts.push({ x: X(ctr[0]) + rr * sc * 0.72 + 4, y: Y(ctr[1]) - rr * sc * 0.72 - 6, text: sh.label, color });
          } else if (sh.kind === "polygon") {
            const list = sh.points.map((n) => pts.get(n)).filter(ok);
            if (list.length < 2) continue;
            const screen = list.map(S);
            if ((sh as { fill?: boolean }).fill) {
              ctx.save();
              ctx.globalAlpha = 0.12;
              ctx.fillStyle = color;
              ctx.beginPath();
              screen.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
            draw.polyline(ctx, screen, { color, width: 1.5, close: list.length > 2, dash });
            if (sh.label) {
              const cx = screen.reduce((s, p) => s + p[0], 0) / screen.length;
              const cy = screen.reduce((s, p) => s + p[1], 0) / screen.length;
              texts.push({ x: cx - textWidth(ctx, sh.label, LABEL_FONT) / 2, y: cy, text: sh.label, color });
            }
          } else if (sh.kind === "angle") {
            const o = pts.get(sh.at);
            const a = pts.get(sh.from);
            const b = pts.get(sh.to);
            if (!ok(o) || !ok(a) || !ok(b)) continue;
            const t1 = Math.atan2(-(a[1] - o[1]), a[0] - o[0]);
            let t2 = Math.atan2(-(b[1] - o[1]), b[0] - o[0]);
            let delta = t2 - t1;
            while (delta > Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            t2 = t1 + delta;
            const R = 18;
            ctx.beginPath();
            ctx.arc(X(o[0]), Y(o[1]), R, Math.min(t1, t2), Math.max(t1, t2));
            ctx.strokeStyle = tc(sh.color, "accent2");
            ctx.lineWidth = 1.25;
            ctx.stroke();
            if (sh.label) {
              const mid = t1 + delta / 2;
              texts.push({ x: X(o[0]) + Math.cos(mid) * (R + 12) - 4, y: Y(o[1]) + Math.sin(mid) * (R + 12), text: sh.label, color: tc(sh.color, "accent2") });
            }
          } else if (sh.kind === "arc") {
            const ctr = pts.get(sh.center);
            const rr = val(r, env);
            const a0 = (-val(from, env) * Math.PI) / 180;
            const a1 = (-val(to, env) * Math.PI) / 180;
            if (!ok(ctr) || !(rr > 0) || !Number.isFinite(a0) || !Number.isFinite(a1)) continue;
            ctx.beginPath();
            ctx.arc(X(ctr[0]), Y(ctr[1]), rr * sc, Math.min(a0, a1), Math.max(a0, a1));
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash(dash ?? []);
            ctx.stroke();
            ctx.setLineDash([]);
            if (sh.label) {
              const mid = (a0 + a1) / 2;
              texts.push({ x: X(ctr[0]) + Math.cos(mid) * (rr * sc + 10), y: Y(ctr[1]) + Math.sin(mid) * (rr * sc + 10), text: sh.label, color });
            }
          }
        }

        // Points and their labels (pushed away from the figure's centre).
        for (const p of config.points) {
          const q = pts.get(p.name);
          if (p.hidden || !ok(q)) continue;
          const [x, y] = S(q);
          draw.dot(ctx, x, y, 3.5, tc(p.color, "fg"));
          if (p.label) {
            const [cx, cy] = S(centroid);
            const d = Math.hypot(x - cx, y - cy) || 1;
            const w = textWidth(ctx, p.label, LABEL_FONT);
            texts.push({ x: x + ((x - cx) / d) * 12 - (x < cx ? w : 0), y: y + ((y - cy) / d) * 12, text: p.label, color: tc(p.color, "fg") });
          }
        }
        ctx.restore();
        for (const t of texts) {
          const w = textWidth(ctx, t.text, LABEL_FONT);
          draw.text(ctx, t.text, Math.max(4, Math.min(t.x, width - w - 4)), Math.max(10, Math.min(t.y, height - 10)), { color: t.color });
        }

        setReadouts(readoutValues(c.readouts, env));
      }}
    />
  );
}

export type { GeometryShape };
