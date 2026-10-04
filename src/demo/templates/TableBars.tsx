// table-bars: a few cases compared by formulas — a small table of computed columns and bars for one column.

import { useMemo } from "react";
import { Stage, draw, theme } from "../kit";
import { compile, num, type Env, type Value } from "./expr";
import type { TableBarsConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtValue, opt, paramEnv, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, MONO_FONT } from "./ui";

/** Fit text into `w` px with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, s: string, w: number, font: string): string {
  if (textWidth(ctx, s, font) <= w) return s;
  let t = s;
  while (t.length > 1 && textWidth(ctx, `${t}…`, font) > w) t = t.slice(0, -1);
  return `${t}…`;
}

export default function TableBars({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<TableBarsConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      rows: config.rows.map((r) => ({ label: r.label, vars: Object.entries(r.vars ?? {}).map(([k, v]) => [k, opt(v)!] as const) })),
      cols: config.columns.map((col) => ({ ...col, c: compile(col.expr) })),
      highlight: opt(config.highlight),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx) => {
        const env: Env = applyDefs({ ...paramEnv(params) }, c.defs);
        // Cell values: each row's vars, then the columns.
        const table: number[][] = c.rows.map((r, ri) => {
          const re: Env = { ...env, row: ri };
          for (const [k, v] of r.vars) re[k] = val(v, re);
          return c.cols.map((col) => val(col.c, re));
        });
        const colIdx = (id: Value) => c.cols.findIndex((col) => col.id === String(id));
        const fns: Env = {
          cell: (r: Value, id: Value) => table[Math.floor(num(r))]?.[colIdx(id)] ?? NaN,
          col: (id: Value) => table.map((row) => row[colIdx(id)]),
        };
        const hl = c.highlight !== undefined ? Math.round(val(c.highlight, env)) : -1;

        // Layout: table above the bars (or beside them when the stage is wide).
        const m = 20;
        const barCol = config.bar ? colIdx(config.bar.column) : -1;
        const wide = barCol >= 0 && width >= 720;
        const tableBox = { left: m, top: m, width: barCol >= 0 && wide ? width * 0.56 - m : width - 2 * m };
        const rowH = Math.max(22, Math.min(30, (height - 2 * m) / (c.rows.length + 1) / (barCol >= 0 && !wide ? 2 : 1)));
        const valueCols = c.cols.map((col) => col.label);
        const valueW = Math.min(150, Math.max(70, ...valueCols.map((l) => textWidth(ctx, l, LABEL_FONT) + 14)));
        const labelW = Math.max(60, tableBox.width - valueW * c.cols.length);

        // Header.
        const y0 = tableBox.top + rowH / 2;
        c.cols.forEach((col, j) => {
          const right = tableBox.left + labelW + valueW * (j + 1) - 6;
          draw.text(ctx, fit(ctx, col.label, valueW - 10, LABEL_FONT), right, y0, { color: theme.muted, align: "right" });
        });
        draw.line(ctx, tableBox.left, tableBox.top + rowH, tableBox.left + tableBox.width, tableBox.top + rowH, { color: theme.line, width: 1 });
        // Rows.
        c.rows.forEach((r, i) => {
          const y = tableBox.top + rowH * (i + 1.5);
          const on = i === hl;
          if (on) draw.rect(ctx, tableBox.left - 4, y - rowH / 2, tableBox.width + 8, rowH, { color: theme.accent, fill: null, width: 1 });
          draw.text(ctx, fit(ctx, r.label, labelW - 12, LABEL_FONT), tableBox.left + 2, y, { color: on ? theme.fg : theme.muted });
          c.cols.forEach((col, j) => {
            const right = tableBox.left + labelW + valueW * (j + 1) - 6;
            const s = fit(ctx, fmtValue(table[i][j], col.digits, col.unit), valueW - 10, MONO_FONT);
            draw.text(ctx, s, right, y, { kind: "mono", color: on ? theme.fg : theme.fg, align: "right" });
          });
        });

        // Bars for one column (log scale when asked or when values span orders of magnitude).
        if (barCol >= 0) {
          const vals = table.map((row) => row[barCol]);
          const pos = vals.filter((v) => Number.isFinite(v) && v > 0);
          const log = config.bar?.log ?? (pos.length > 1 && Math.max(...pos) / Math.min(...pos) > 200);
          const tableBottom = tableBox.top + rowH * (c.rows.length + 1);
          const bb = wide
            ? { left: width * 0.56 + 16, top: m + rowH, width: width * 0.44 - 16 - m, height: Math.min(height - 2 * m - rowH, rowH * c.rows.length) }
            : { left: m, top: tableBottom + 20, width: width - 2 * m, height: Math.max(40, height - tableBottom - 20 - m) };
          const lw = wide ? 0 : Math.min(160, Math.max(...c.rows.map((r) => textWidth(ctx, r.label, LABEL_FONT))) + 12);
          const slot = bb.height / c.rows.length;
          const bh = Math.max(6, Math.min(18, slot * 0.6));
          const tr = (v: number) => (log ? Math.log10(Math.max(v, 1e-300)) : v);
          const lo = log ? Math.floor(Math.log10(Math.min(...pos))) - 0.3 : Math.min(0, ...vals.filter(Number.isFinite));
          const hi = log ? Math.log10(Math.max(...pos)) : Math.max(...vals.filter(Number.isFinite), 0);
          const span = hi - lo || 1;
          const x0 = bb.left + lw;
          const W = bb.width - lw - 70;
          draw.text(ctx, `${c.cols[barCol].label}${log ? " (log)" : ""}`, x0, bb.top - 10, { color: theme.muted });
          c.rows.forEach((r, i) => {
            const y = bb.top + slot * (i + 0.5);
            const v = vals[i];
            if (!wide) draw.text(ctx, fit(ctx, r.label, lw - 10, LABEL_FONT), bb.left, y, { color: i === hl ? theme.fg : theme.muted });
            if (!Number.isFinite(v) || (log && v <= 0)) return;
            const w = Math.max(1, ((tr(v) - lo) / span) * W);
            draw.rect(ctx, x0, y - bh / 2, w, bh, { color: i === hl ? theme.accent : theme.muted, fill: i === hl ? theme.accent : theme.muted, width: 0.5 });
            draw.text(ctx, fmtValue(v, c.cols[barCol].digits), x0 + w + 6, y, { kind: "mono", color: theme.muted });
          });
        }

        setReadouts(readoutValues(c.readouts, { ...env, ...fns }));
      }}
    />
  );
}
