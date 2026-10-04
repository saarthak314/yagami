// sequence: terms aₙ (explicit, or a recurrence over state variables) revealed one by one, their partial
// sums approaching a limit, and an optional table of the first iterates (e.g. Euler steps).

import { useMemo, useRef } from "react";
import { Stage, draw, theme } from "../kit";
import { compile, compileField, type Env } from "./expr";
import type { SequenceConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, extent, fmtValue, opt, paramEnv, plotFrame, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { MONO_FONT } from "./ui";

interface Row {
  n: number;
  term: number;
  S: number;
  state: Record<string, number>;
}

export default function Sequence({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<SequenceConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      state: Object.entries(config.state ?? {}).map(([k, v]) => [k, compileField(v)] as const),
      next: Object.entries(config.next ?? {}).map(([k, v]) => [k, compile(v)] as const),
      term: config.term !== undefined ? compile(config.term) : null,
      n: opt(config.n)!,
      limit: opt(config.limit),
      speed: opt(config.speed),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );
  const paramsKey = JSON.stringify(params);

  // Every term up front (the animation only reveals them).
  const run = useMemo(() => {
    const env: Env = applyDefs({ ...paramEnv(params), t: 0 }, c.defs);
    const N = Math.max(1, Math.min(200, Math.round(val(c.n, env) || 1)));
    const state: Record<string, number> = {};
    for (const [k, e] of c.state) state[k] = val(e, env);
    const first = c.state[0]?.[0];
    const rows: Row[] = [];
    let S = 0;
    for (let n = 0; n < N; n++) {
      const e = { ...env, ...state, n };
      const term = c.term ? val(c.term, e) : first ? state[first] : NaN;
      S += Number.isFinite(term) ? term : 0;
      rows.push({ n, term, S, state: { ...state } });
      const nextState: Record<string, number> = { ...state };
      for (const [k, ex] of c.next) nextState[k] = val(ex, e);
      Object.assign(state, nextState);
    }
    return { env, rows, N, limit: c.limit !== undefined ? val(c.limit, env) : NaN };
  }, [c, paramsKey]); // params enter through paramsKey
  const clock = useRef({ t: 0, key: resetKey, params: paramsKey });

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const k = clock.current;
        if (k.key !== resetKey || k.params !== paramsKey) Object.assign(k, { t: 0, key: resetKey, params: paramsKey });
        k.t += dt;
        const { rows, N, limit } = run;
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 2 : 2);
        const idx = stepIndex(k.t, N, speed);
        const cur = rows[idx];
        const show = config.show ?? "both";

        // Layout: plot, and a table to the right (wide stages) or below.
        const table = config.table;
        const tRows = table ? Math.min(table.rows ?? 8, 12, N) : 0;
        const cols = table?.columns ?? [];
        const colW = cols.map((col) => Math.max(textWidth(ctx, col === "term" ? (config.label ?? "aₙ") : col, MONO_FONT), ...rows.slice(0, tRows).map((r) => textWidth(ctx, cellText(r, col), MONO_FONT))) + 16);
        const tableW = colW.reduce((s, w) => s + w, 0);
        const side = table && width >= 520 && tableW < width * 0.42;
        const lineH = 18;
        const tableH = table ? (tRows + 1) * lineH + 8 : 0;
        const plotArea = side
          ? { left: 10, top: 10, width: width - tableW - 34, height: height - 20 }
          : { left: 10, top: 10, width: width - 20, height: height - 20 - (table ? tableH + 10 : 0) };

        const vals: number[] = [];
        if (show !== "sum") vals.push(...rows.map((r) => r.term));
        if (show !== "terms") vals.push(...rows.map((r) => r.S));
        if (Number.isFinite(limit)) vals.push(limit);
        let [y0, y1] = extent([...vals, 0]);
        y1 += (y1 - y0) * 0.08;
        const fr = plotFrame(ctx, plotArea, { x: [-0.5, N - 0.5], y: [y0, y1], xLabel: config.xLabel ?? "n", yLabel: config.label });
        const cy = (v: number) => fr.py(Math.min(Math.max(v, fr.y0), fr.y1));

        if (Number.isFinite(limit) && limit >= fr.y0 && limit <= fr.y1) {
          draw.line(ctx, fr.box.left, fr.py(limit), fr.box.left + fr.box.width, fr.py(limit), { color: theme.muted, width: 1, dash: [5, 4] });
          draw.text(ctx, "limit", fr.box.left + fr.box.width - 4, fr.py(limit) - 8, { align: "right", color: theme.muted });
        }
        const base = cy(0);
        if (show !== "sum")
          for (const r of rows.slice(0, idx + 1)) {
            if (!Number.isFinite(r.term)) continue;
            const x = fr.px(r.n);
            draw.line(ctx, x, base, x, cy(r.term), { color: r.n === idx ? theme.accent : theme.muted, width: r.n === idx ? 2 : 1.25 });
            draw.dot(ctx, x, cy(r.term), r.n === idx ? 3.5 : 2.5, r.n === idx ? theme.accent : theme.muted);
          }
        if (show !== "terms") {
          const pts = rows.slice(0, idx + 1).filter((r) => Number.isFinite(r.S)).map((r): [number, number] => [fr.px(r.n), cy(r.S)]);
          draw.polyline(ctx, pts, { color: theme.fg, width: 1.5 });
          if (pts.length) draw.circle(ctx, pts[pts.length - 1][0], pts[pts.length - 1][1], 4, { color: theme.fg, width: 1.5 });
        }

        // Table of the first iterates; the revealed row is highlighted.
        if (table && tRows) {
          const tx = side ? width - tableW - 14 : Math.max(10, (width - tableW) / 2);
          const ty = side ? Math.max(14, (height - tableH) / 2) : fr.box.top + fr.box.height + 44;
          let x = tx;
          cols.forEach((col, j) => {
            draw.text(ctx, col === "term" ? (config.label ?? "aₙ") : col, x + colW[j] - 8, ty + lineH / 2, { kind: "mono", align: "right", color: theme.muted });
            x += colW[j];
          });
          draw.line(ctx, tx, ty + lineH + 2, tx + tableW, ty + lineH + 2, { color: theme.line, width: 1 });
          for (let i = 0; i < tRows; i++) {
            const r = rows[i];
            const y = ty + (i + 1) * lineH + 6;
            if (i === idx) {
              ctx.save();
              ctx.globalAlpha = 0.14;
              ctx.fillStyle = theme.accent;
              ctx.fillRect(tx, y - 1, tableW, lineH);
              ctx.restore();
            }
            let cx = tx;
            cols.forEach((col, j) => {
              draw.text(ctx, cellText(r, col), cx + colW[j] - 8, y + lineH / 2 - 1, { kind: "mono", align: "right", color: i <= idx ? theme.fg : theme.faint });
              cx += colW[j];
            });
          }
        }

        const last = rows[rows.length - 1];
        setReadouts(readoutValues(c.readouts, { ...run.env, ...cur.state, n: cur.n, N, term: cur.term, S: cur.S, term_N: last.term, S_N: last.S, limit }));
      }}
    />
  );
}

function cellText(r: Row, col: string): string {
  const v = col === "n" ? r.n : col === "term" ? r.term : col === "S" ? r.S : r.state[col];
  return fmtValue(v, Number.isInteger(v) ? undefined : 4);
}
