// cell-grid: up to four rows of cells whose contents and styles are formulas of the cell index i and an
// animation step k — bits of a word with labelled fields, memory words, hash buckets, a table row being
// filled — with pointers, field brackets and a one-line message.

import { useMemo, useRef } from "react";
import { Stage, draw, theme } from "../kit";
import { compile, compileField, num, type Compiled, type Env, type Value } from "./expr";
import type { CellGridConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, tc } from "./ui";

const big = (v: Value): bigint | null => {
  const n = num(v);
  return Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? BigInt(n) : null;
};
const back = (b: bigint | null): number => (b === null ? NaN : Number(b));
const two = (f: (a: bigint, b: bigint) => bigint) => (a: Value, b: Value) => {
  const x = big(a);
  const y = big(b);
  return x === null || y === null ? NaN : back(f(x, y));
};

/** Bit and string helpers (exact for integers up to 2^53; negatives are two's complement). */
export const CELL_ENV: Env = {
  bit: (x, i) => {
    const b = big(x);
    const k = num(i);
    return b === null || !(k >= 0 && k < 64) ? NaN : Number((b >> BigInt(Math.floor(k))) & 1n);
  },
  band: two((a, b) => a & b),
  bor: two((a, b) => a | b),
  bxor: two((a, b) => a ^ b),
  bnot: (x, bits) => {
    const b = big(x);
    const w = Math.max(1, Math.min(53, Math.floor(num(bits ?? 32))));
    return b === null ? NaN : back(~b & ((1n << BigInt(w)) - 1n));
  },
  shl: two((a, n) => a << n),
  shr: two((a, n) => a >> n),
  hex: (x) => {
    const b = big(x);
    return b === null ? "—" : `${b < 0n ? "-" : ""}0x${(b < 0n ? -b : b).toString(16)}`;
  },
  bin: (x, width) => {
    const b = big(x);
    if (b === null) return "—";
    const w = Math.max(1, Math.min(64, Math.floor(num(width ?? 8))));
    return (b < 0n ? (1n << BigInt(w)) + b : b).toString(2).padStart(w, "0").slice(-w);
  },
  str: (x) => (typeof x === "string" ? x : Array.isArray(x) ? x.join(",") : Number.isFinite(x) ? String(x) : "—"),
  pad: (s, w) => String(s).padStart(Math.max(0, Math.min(64, Math.floor(num(w)))), " "),
};

const STYLES = ["normal", "active", "muted", "done"] as const;

interface CRow {
  label?: string;
  n: Compiled | number;
  value: Compiled;
  style?: Compiled;
  index?: Compiled;
  groups: { from: Compiled | number; to: Compiled | number; label: string; color?: string }[];
}

export default function CellGrid({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<CellGridConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      rows: config.rows.map<CRow>((r) => ({
        label: r.label,
        n: compileField(r.n),
        value: compile(r.value),
        style: r.style !== undefined ? compile(r.style) : undefined,
        index: r.index !== undefined ? compile(r.index) : undefined,
        groups: (r.groups ?? []).map((g) => ({ from: compileField(g.from), to: compileField(g.to), label: g.label, color: g.color })),
      })),
      pointers: (config.pointers ?? []).map((p) => ({ row: p.row ?? 0, at: compileField(p.at), label: p.label, color: p.color })),
      steps: opt(config.steps),
      speed: opt(config.speed),
      message: config.message ? [...config.message.split(/(\{[^}]+\})/)].map((part) => (part.startsWith("{") && part.endsWith("}") ? compile(part.slice(1, -1)) : part)) : null,
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
        const clk = clock.current;
        if (clk.key !== resetKey) Object.assign(clk, { t: 0, key: resetKey });
        clk.t += dt;
        const env0: Env = applyDefs({ ...paramEnv(params), ...CELL_ENV, t: clk.t }, c.defs);
        const steps = c.steps !== undefined ? Math.max(1, Math.min(500, Math.round(val(c.steps, env0) || 1))) : 1;
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, env0) || 1 : 1);
        const k = steps > 1 ? stepIndex(clk.t, steps, speed) : 0;
        const env: Env = applyDefs({ ...paramEnv(params), ...CELL_ENV, t: clk.t, k, steps }, c.defs);

        // Each row may wrap onto several lines of cells (e.g. 64 bits → 2 × 32).
        const m = 22;
        const usable = width - 2 * m;
        const minCell = 16;
        const lines = c.rows.map((r) => {
          const n = Math.max(1, Math.min(64, Math.round(val(r.n, env) || 1)));
          const perLine = Math.min(n, Math.max(4, Math.floor(usable / minCell)));
          const count = Math.ceil(n / perLine);
          return { n, per: Math.ceil(n / count), count };
        });
        const cell = Math.min(40, ...lines.map((l) => usable / l.per));
        const groupH = 22;
        const rowBlock = (i: number) => (c.rows[i].label ? 18 : 0) + lines[i].count * (cell + 16 + (c.rows[i].groups.length ? groupH : 0)) + (c.pointers.some((p) => p.row === i) ? 34 : 0);
        const total = c.rows.reduce((s, _, i) => s + rowBlock(i) + 14, 0) + (c.message ? 26 : 0);
        let y = Math.max(m, (height - total) / 2);

        c.rows.forEach((r, ri) => {
          const { n, per, count } = lines[ri];
          if (r.label) {
            draw.text(ctx, r.label, m, y + 8, { color: theme.muted });
            y += 18;
          }
          const values: (string | number)[] = [];
          const styles: (typeof STYLES)[number][] = [];
          const labels: string[] = [];
          for (let i = 0; i < n; i++) {
            const e = { ...env, i };
            let v: Value;
            try {
              v = r.value(e);
            } catch {
              v = NaN;
            }
            values.push(typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000) : "—");
            const st = r.style ? Math.round(val(r.style, e)) : 0;
            styles.push(STYLES[Math.max(0, Math.min(3, Number.isFinite(st) ? st : 0))]);
            let lab: Value = i;
            if (r.index) {
              try {
                lab = r.index(e);
              } catch {
                lab = "";
              }
            }
            labels.push(typeof lab === "number" ? (Number.isFinite(lab) ? String(lab) : "") : String(lab));
          }
          const groups = r.groups.map((g) => ({ from: Math.round(val(g.from, env)), to: Math.round(val(g.to, env)), label: g.label, color: tc(g.color as never, "muted") }));
          const xOf: ((i: number) => number)[] = [];
          for (let li = 0; li < count; li++) {
            const lo = li * per;
            const hi = Math.min(n, lo + per);
            const top = y + (groups.length ? groupH : 0);
            const box = { left: m, top, width: usable, height: cell + 16 };
            const layout = draw.cells(ctx, values.slice(lo, hi), box, { style: (i) => styles[lo + i], indices: labels.slice(lo, hi), maxCell: cell });
            xOf[li] = layout.x;
            // Field brackets above this line's part of each group.
            for (const g of groups) {
              const a = Math.max(g.from, lo);
              const b = Math.min(g.to, hi - 1);
              if (b < a) continue;
              const x1 = layout.x(a - lo) - layout.cellSize / 2 + 2;
              const x2 = layout.x(b - lo) + layout.cellSize / 2 - 2;
              const by = layout.top - 6;
              draw.polyline(ctx, [[x1, by + 4], [x1, by], [x2, by], [x2, by + 4]], { color: g.color, width: 1 });
              let text = g.label;
              while (text.length > 1 && textWidth(ctx, text, LABEL_FONT) > x2 - x1 + layout.cellSize) text = `${text.slice(0, -2)}…`;
              draw.text(ctx, text, (x1 + x2) / 2, by - 8, { align: "center", color: g.color });
            }
            // Pointers into this line.
            for (const p of c.pointers.filter((q) => q.row === ri)) {
              const at = Math.round(val(p.at, env));
              if (!(at >= lo && at < hi)) continue;
              draw.pointer(ctx, layout.x(at - lo), layout.top + layout.height + 18, p.label, { color: tc(p.color as never, "accent") });
            }
            y = top + cell + 16;
          }
          if (c.pointers.some((p) => p.row === ri)) y += 34;
          y += 14;
        });

        if (c.message) {
          const text = c.message.map((part) => (typeof part === "string" ? part : fmtPart(part, env))).join("");
          let s = text;
          while (s.length > 4 && textWidth(ctx, s, LABEL_FONT.replace("11px", "12px")) > width - 2 * m) s = `${s.slice(0, -2)}…`;
          draw.text(ctx, s, width / 2, y + 6, { align: "center", color: theme.fg, size: 12 });
        }

        setReadouts(readoutValues(c.readouts, env));
      }}
    />
  );
}

function fmtPart(c: Compiled, env: Env): string {
  try {
    const v = c(env);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.join(", ");
    return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)) : "—";
  } catch {
    return "—";
  }
}
