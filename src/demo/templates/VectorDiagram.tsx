// vector-diagram: 2-D vectors from expressions, with sums, an angle arc and a projection.

import { useMemo } from "react";
import { Stage, draw, theme, useSim } from "../kit";
import { compile, num, type Compiled, type Env, type Value } from "./expr";
import type { VectorDiagramConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, spread, textWidth, val, type TemplateProps } from "./runtime";
import { SERIES, tc } from "./ui";

const vec = (v: Value): [number, number] => (Array.isArray(v) ? [num(v[0] as Value), num(v[1] as Value)] : [NaN, NaN]);
const FUNCS = {
  dot: (a: Value, b: Value) => ((x, y) => x[0] * y[0] + x[1] * y[1])(vec(a), vec(b)),
  cross: (a: Value, b: Value) => ((x, y) => x[0] * y[1] - x[1] * y[0])(vec(a), vec(b)),
  norm: (a: Value) => Math.hypot(...vec(a)),
  angle: (a: Value, b: Value) => {
    const [x, y] = [vec(a), vec(b)];
    return (Math.acos(Math.max(-1, Math.min(1, (x[0] * y[0] + x[1] * y[1]) / (Math.hypot(...x) * Math.hypot(...y))))) * 180) / Math.PI;
  },
};

export default function VectorDiagram({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<VectorDiagramConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      range: opt(config.range)!,
      vectors: config.vectors.map((v) => ({
        ...v,
        cx: compile(v.x),
        cy: compile(v.y),
        from: Array.isArray(v.from) ? (v.from.map((f) => opt(f)!) as (Compiled | number)[]) : v.from,
      })),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );
  const clock = useSim(() => ({ t: 0 }), [resetKey]);

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        clock.current.t += dt;
        const env: Env = applyDefs({ ...paramEnv(params), t: clock.current.t, ...FUNCS }, c.defs);

        // Evaluate vectors in order; each adds name, name_x, name_y, name_len, name_ang to the env.
        const tips = new Map<string, [number, number]>();
        const placed = c.vectors.map((v) => {
          const x = val(v.cx, env);
          const y = val(v.cy, env);
          let tail: [number, number] = [0, 0];
          if (typeof v.from === "string") tail = tips.get(v.from) ?? [0, 0];
          else if (Array.isArray(v.from)) tail = [val(v.from[0], env), val(v.from[1], env)];
          env[v.name] = [x, y];
          env[`${v.name}_x`] = x;
          env[`${v.name}_y`] = y;
          env[`${v.name}_len`] = Math.hypot(x, y);
          env[`${v.name}_ang`] = (Math.atan2(y, x) * 180) / Math.PI;
          tips.set(v.name, [tail[0] + x, tail[1] + y]);
          return { v, x, y, tail };
        });

        // Square plot area centred on the origin.
        const R = Math.max(0.1, val(c.range, env) || 5);
        const m = 30;
        const side = Math.max(60, Math.min(width - 2 * m - 60, height - 2 * m));
        const ox = width / 2 - 20;
        const oy = height / 2;
        const k = side / (2 * R);
        const X = (v: number) => ox + v * k;
        const Y = (v: number) => oy - v * k;

        // Grid and axes.
        if (config.grid !== false) {
          const step = R <= 6 ? 1 : R <= 12 ? 2 : R <= 30 ? 5 : 10;
          for (let g = -Math.floor(R / step) * step; g <= R + 1e-9; g += step) {
            draw.line(ctx, X(g), Y(-R), X(g), Y(R), { color: theme.grid, width: 1 });
            draw.line(ctx, X(-R), Y(g), X(R), Y(g), { color: theme.grid, width: 1 });
          }
          draw.text(ctx, String(step), X(step), Y(0) + 12, { kind: "mono", align: "center", color: theme.faint });
        }
        draw.arrow(ctx, X(-R), Y(0), X(R) + 8, Y(0), { color: theme.muted, width: 1, head: 5 });
        draw.arrow(ctx, X(0), Y(-R), X(0), Y(R) - 8, { color: theme.muted, width: 1, head: 5 });
        draw.text(ctx, "x", X(R) + 12, Y(0), { kind: "symbol" });
        draw.text(ctx, "y", X(0) + 8, Y(R) - 6, { kind: "symbol" });

        // Projection of one vector onto another.
        if (config.projection) {
          const a = placed.find((p) => p.v.name === config.projection!.of);
          const b = placed.find((p) => p.v.name === config.projection!.onto);
          if (a && b) {
            const bl = Math.hypot(b.x, b.y);
            if (bl > 1e-9) {
              const s = (a.x * b.x + a.y * b.y) / (bl * bl);
              const px = a.tail[0] + s * b.x;
              const py = a.tail[1] + s * b.y;
              draw.line(ctx, X(a.tail[0] + a.x), Y(a.tail[1] + a.y), X(px), Y(py), { color: theme.faint, width: 1, dash: [3, 3] });
              draw.line(ctx, X(a.tail[0]), Y(a.tail[1]), X(px), Y(py), { color: theme.accent, width: 4, alpha: 0.35 });
            }
          }
        }

        // Angle arc between two vectors.
        if (config.angle) {
          const a = placed.find((p) => p.v.name === config.angle![0]);
          const b = placed.find((p) => p.v.name === config.angle![1]);
          if (a && b && Math.hypot(a.x, a.y) > 1e-9 && Math.hypot(b.x, b.y) > 1e-9) {
            const t1 = Math.atan2(a.y, a.x);
            let t2 = Math.atan2(b.y, b.x);
            let d = t2 - t1;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            t2 = t1 + d;
            const r = Math.min(30, 0.3 * k * Math.min(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y)));
            ctx.beginPath();
            ctx.arc(X(a.tail[0]), Y(a.tail[1]), r, -t1, -t2, d > 0);
            ctx.strokeStyle = theme.muted;
            ctx.lineWidth = 1;
            ctx.stroke();
            const mid = t1 + d / 2;
            draw.text(ctx, "θ", X(a.tail[0]) + (r + 9) * Math.cos(mid), Y(a.tail[1]) - (r + 9) * Math.sin(mid), { kind: "symbol", align: "center", color: theme.muted });
          }
        }

        // Vectors, then their labels spread so they don't collide.
        const labels: { x: number; y: number; text: string; color: string }[] = [];
        placed.forEach(({ v, x, y, tail }, i) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          const color = tc(v.color, SERIES[i % SERIES.length]);
          const x1 = X(tail[0]);
          const y1 = Y(tail[1]);
          const x2 = X(tail[0] + x);
          const y2 = Y(tail[1] + y);
          if (Math.hypot(x2 - x1, y2 - y1) < 1) draw.dot(ctx, x1, y1, 3, color);
          else draw.arrow(ctx, x1, y1, x2, y2, { color, width: 2, head: 8, dash: v.dashed ? [5, 4] : undefined });
          if (v.label) {
            // Beside the middle of the arrow, on its left-hand side.
            const len = Math.hypot(x2 - x1, y2 - y1) || 1;
            const nx = -(y2 - y1) / len;
            const ny = (x2 - x1) / len;
            labels.push({ x: (x1 + x2) / 2 - nx * 12, y: (y1 + y2) / 2 - ny * 12, text: v.label, color });
          }
        });
        const ys = spread(
          labels.map((l) => l.y),
          14,
          14,
          height - 14,
        );
        labels.forEach((l, i) => {
          const w = textWidth(ctx, l.text, theme.fonts.symbol);
          const lx = Math.min(Math.max(l.x - w / 2, 6), width - w - 6);
          draw.text(ctx, l.text, lx, ys[i], { kind: "symbol", color: l.color });
        });

        setReadouts(readoutValues(c.readouts, env));
      }}
    />
  );
}

