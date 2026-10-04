// Work done by gravity (ch. 13, §13-2; Figs. 13-2 to 13-4).
// A body is carried along a path in small steps and W = Σ F·ds is summed as it
// goes. With uniform gravity only the vertical parts of the steps count, so any
// two paths between 1 and 2 give mg(z1 − z2). Around a central mass, circular
// steps do no work and the radial ones cancel, so a closed loop gives zero.

import { useMemo } from "react";
import { Stage, draw, fmt, theme, useSim } from "../kit";
import type { DemoProps } from "../../types";

type Pt = [number, number];

/** A traversable path: vertices, cumulative arc length, cumulative work. */
interface Track {
  pts: Pt[];
  len: number[];
  work: number[];
}

/** Sum F·ds along the path, split into short pieces so W can be read anywhere along it. */
function track(path: Pt[], force: (p: Pt) => Pt): Track {
  const pts: Pt[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
    for (let k = 1; k <= n; k++) pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  const len = [0];
  const work = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const [fx, fy] = force([(ax + bx) / 2, (ay + by) / 2]);
    len.push(len[i - 1] + Math.hypot(bx - ax, by - ay));
    work.push(work[i - 1] + fx * (bx - ax) + fy * (by - ay));
  }
  return { pts, len, work };
}

/** Position, work so far and current step direction at fraction u of the track. */
function at(tr: Track, u: number) {
  const s = u * tr.len[tr.len.length - 1];
  let i = 1;
  while (i < tr.len.length - 1 && tr.len[i] < s) i++;
  const f = (s - tr.len[i - 1]) / (tr.len[i] - tr.len[i - 1] || 1);
  const [ax, ay] = tr.pts[i - 1];
  const [bx, by] = tr.pts[i];
  return {
    p: [ax + (bx - ax) * f, ay + (by - ay) * f] as Pt,
    w: tr.work[i - 1] + (tr.work[i] - tr.work[i - 1]) * f,
    dir: [bx - ax, by - ay] as Pt,
  };
}

/** Replace each chord by an "outward" leg then an "across" leg, both ending at the same points. */
function stepped(samples: Pt[], legs: (a: Pt, b: Pt) => Pt[]): Pt[] {
  const out: Pt[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) out.push(...legs(samples[i - 1], samples[i]));
  return out;
}

export default function WorkGravity({ params, preset, playing, resetKey, width, height, setReadouts }: DemoProps) {
  const steps = Number(params.steps);
  const speed = Number(params.speed);
  const radial = Boolean(params.radial);
  const central = preset === "central";

  const scene = useMemo(() => {
    const u = Math.min(width, height * 1.4);
    const ox = (width - u) / 2;
    const oy = (height - u / 1.4) / 2;
    const P = (x: number, y: number): Pt => [ox + x * u, oy + (y * u) / 1.4];
    const H = u / 1.4; // one length unit

    if (!central) {
      // Uniform field pointing down, mg = 1 per length unit H.
      const force = (): Pt => [0, 1 / H];
      const p1 = P(0.14, 0.32);
      const p2 = P(0.8, 0.82);
      const c = P(0.42, 0.02);
      const sample = (curve: (t: number) => Pt) => Array.from({ length: steps + 1 }, (_, i) => curve(i / steps));
      const a = sample((t) => [
        (1 - t) ** 2 * p1[0] + 2 * (1 - t) * t * c[0] + t * t * p2[0],
        (1 - t) ** 2 * p1[1] + 2 * (1 - t) * t * c[1] + t * t * p2[1],
      ]);
      const b = sample((t) => [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]);
      // In a uniform field "radial" means vertical, "circular" means horizontal.
      const legs = (s: Pt, e: Pt): Pt[] => [[s[0], e[1]], e];
      const paths = [a, b].map((pts) => track(radial ? stepped(pts, legs) : pts, force));
      return { kind: "uniform" as const, H, p1, p2, paths, expected: (p2[1] - p1[1]) / H, ground: P(0, 0.92)[1] };
    }

    // Central mass at M; F = GMm/r² toward M, with GMm = 0.4 in units of H.
    const M = P(0.12, 0.5);
    const k = 0.4 * H; // GMm in px·(work units)
    const force = ([x, y]: Pt): Pt => {
      const dx = M[0] - x;
      const dy = M[1] - y;
      const r = Math.hypot(dx, dy);
      return [(k * dx) / r ** 3, (k * dy) / r ** 3];
    };
    const centre = P(0.6, 0.5);
    const loop = (t: number): Pt => {
      const th = t * Math.PI * 2;
      const r = 0.24 * (1 + 0.18 * Math.sin(2 * th) + 0.1 * Math.cos(3 * th));
      return [centre[0] - Math.cos(th) * r * u * 0.9, centre[1] + Math.sin(th) * r * u * 0.6];
    };
    const samples = Array.from({ length: steps + 1 }, (_, i) => loop(i / steps));
    const smooth = Array.from({ length: 241 }, (_, i) => loop(i / 240));
    const polar = ([x, y]: Pt) => [Math.hypot(x - M[0], y - M[1]), Math.atan2(y - M[1], x - M[0])];
    const fromPolar = (r: number, a: number): Pt => [M[0] + r * Math.cos(a), M[1] + r * Math.sin(a)];
    // Radial leg out to the new radius, then a circular arc to the new angle.
    const legs = (s: Pt, e: Pt): Pt[] => {
      const [, a0] = polar(s);
      const [r1, a1] = polar(e);
      const arc = Array.from({ length: 8 }, (_, j) => fromPolar(r1, a0 + ((a1 - a0) * (j + 1)) / 8));
      return [fromPolar(r1, a0), ...arc];
    };
    const path = track(radial ? stepped(samples, legs) : samples, force);
    const r1 = polar(samples[0])[0];
    return { kind: "central" as const, H, M, k, r1, smooth, paths: [path], polar };
  }, [central, steps, radial, width, height]);

  const sim = useSim(() => ({ u: 0, hold: 0 }), [resetKey, preset, steps, radial]);

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const s = sim.current;
        if (s.u < 1) s.u = Math.min(1, s.u + speed * dt);
        else if ((s.hold += dt) > 1.5) Object.assign(s, { u: 0, hold: 0 });

        const now = scene.paths.map((tr) => at(tr, s.u));

        if (scene.kind === "uniform") {
          // Field: faint downward arrows; ground; g marker.
          for (let x = 0.1; x < 1; x += 0.11)
            for (let y = 0.12; y < 0.85; y += 0.16)
              draw.arrow(ctx, x * width, y * height, x * width, y * height + 14, { color: theme.grid, width: 1, head: 4 });
          draw.ground(ctx, width * 0.06, width * 0.94, scene.ground);
          draw.arrow(ctx, width - 32, 24, width - 32, 64, { color: theme.muted, width: 1 });
          draw.text(ctx, "g", width - 22, 30, { kind: "symbol" });

          scene.paths.forEach((tr, i) => {
            draw.polyline(ctx, tr.pts, { color: theme.faint, width: 1 });
            const done = tr.pts.filter((_, j) => tr.len[j] <= s.u * tr.len[tr.len.length - 1]);
            draw.polyline(ctx, [...done, now[i].p], { width: 1.5 });
          });
          draw.text(ctx, "A", scene.paths[0].pts[Math.floor(scene.paths[0].pts.length * 0.3)][0], scene.paths[0].pts[Math.floor(scene.paths[0].pts.length * 0.3)][1] - 14, { kind: "symbol" });
          const bMid = scene.paths[1].pts[Math.floor(scene.paths[1].pts.length * 0.35)];
          draw.text(ctx, "B", bMid[0] - 6, bMid[1] + 16, { kind: "symbol", align: "right" });
          draw.dot(ctx, ...scene.p1);
          draw.dot(ctx, ...scene.p2);
          draw.text(ctx, "1", scene.p1[0] - 12, scene.p1[1], { kind: "symbol" });
          draw.text(ctx, "2", scene.p2[0] + 8, scene.p2[1] - 4, { kind: "symbol" });

          now.forEach(({ p, dir }) => {
            const d = Math.hypot(...dir) || 1;
            draw.arrow(ctx, p[0], p[1], p[0] + (dir[0] / d) * 26, p[1] + (dir[1] / d) * 26, { color: theme.accent });
            draw.arrow(ctx, p[0], p[1], p[0], p[1] + 40, { color: theme.muted });
            draw.circle(ctx, p[0], p[1], 6);
          });
          setReadouts({ w: `A ${fmt(now[0].w)} · B ${fmt(now[1].w)}`, expected: fmt(scene.expected) });
        } else {
          const { M, r1, polar } = scene;
          for (const r of [0.15, 0.3, 0.45, 0.6, 0.75])
            draw.circle(ctx, M[0], M[1], r * scene.H, { color: theme.grid, width: 1, fill: null });
          draw.polyline(ctx, scene.smooth, { color: theme.faint, width: 1, dash: [3, 4] });
          const tr = scene.paths[0];
          const done = tr.pts.filter((_, j) => tr.len[j] <= s.u * tr.len[tr.len.length - 1]);
          draw.polyline(ctx, tr.pts, { color: theme.faint, width: 1, alpha: 0.6 });
          draw.polyline(ctx, [...done, now[0].p], { width: 1.5 });

          draw.circle(ctx, M[0], M[1], 9, { fill: theme.fg });
          draw.text(ctx, "M", M[0], M[1] + 22, { kind: "symbol", align: "center" });

          const { p, dir } = now[0];
          const [r] = polar(p);
          const fLen = Math.min(60, (scene.k / (r * r)) * 18 * scene.H);
          draw.arrow(ctx, p[0], p[1], p[0] + ((M[0] - p[0]) / r) * fLen, p[1] + ((M[1] - p[1]) / r) * fLen, { color: theme.muted });
          draw.text(ctx, "F", p[0] + ((M[0] - p[0]) / r) * fLen, p[1] + ((M[1] - p[1]) / r) * fLen - 10, { kind: "symbol" });
          const d = Math.hypot(...dir) || 1;
          draw.arrow(ctx, p[0], p[1], p[0] + (dir[0] / d) * 26, p[1] + (dir[1] / d) * 26, { color: theme.accent });
          draw.circle(ctx, p[0], p[1], 6);
          draw.text(ctx, "ds", p[0] + (dir[0] / d) * 30 + 4, p[1] + (dir[1] / d) * 30, { kind: "symbol", color: theme.accent });

          const H = scene.H;
          const expected = (scene.k / H) * (H / r - H / r1);
          setReadouts({ w: fmt(now[0].w), expected: fmt(expected), r: fmt(r / H, 2) });
        }
      }}
    />
  );
}
