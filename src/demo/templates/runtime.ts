// Shared pieces for template components: parameter environments, defs, readouts, ticks.

import type { DemoProps, Params } from "../../types";
import { axes } from "../kit";
import { compile, compileField, evalNum, num, type Compiled, type Env, type Value } from "./expr";
import type { ReadoutDef } from "./configs";

export type TemplateProps<C> = DemoProps & { config: C };

/** Params as expression values: booleans become 1/0. */
export function paramEnv(params: Params): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(params)) env[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return env;
}

export type Defs = [string, Compiled][];

export function compileDefs(defs: Record<string, string> | undefined): Defs {
  return Object.entries(defs ?? {}).map(([k, e]) => [k, compile(e)]);
}

/** Evaluate defs in order into `env` (each def sees the earlier ones). */
export function applyDefs(env: Env, defs: Defs): Env {
  for (const [k, c] of defs) {
    try {
      env[k] = c(env);
    } catch {
      env[k] = NaN;
    }
  }
  return env;
}

export interface Readout {
  id: string;
  c: Compiled | number;
  digits?: number;
  unit?: string;
}

export function compileReadouts(r: Record<string, ReadoutDef> | undefined): Readout[] {
  return Object.entries(r ?? {}).map(([id, d]) =>
    typeof d === "object" && d !== null ? { id, c: compileField(d.expr), digits: d.digits, unit: d.unit } : { id, c: compileField(d) },
  );
}

/** A readout value as text: integers exactly, otherwise `digits` decimals (3), exponent form when tiny/huge. */
export function fmtValue(v: Value | undefined, digits?: number, unit?: string): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return unit ? `${v} ${unit}` : v;
  if (Array.isArray(v)) return v.length ? v.map((x) => fmtValue(x, digits)).join(", ") : "—";
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  let s: string;
  if (digits === undefined && Number.isInteger(v) && a < 1e15) s = String(v);
  else if (a !== 0 && (a < 1e-3 || a >= 1e6)) s = v.toExponential(Math.min(digits ?? 2, 4));
  else s = v.toFixed(digits ?? 3);
  return unit ? `${s} ${unit}` : s;
}

export function readoutValues(list: Readout[], env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of list) {
    let v: Value | undefined;
    try {
      v = typeof r.c === "number" ? r.c : r.c(env);
    } catch {
      v = undefined;
    }
    out[r.id] = fmtValue(v, r.digits, r.unit);
  }
  return out;
}

/** Numeric value of an expression-or-number field (NaN on error). */
export const val = (c: Compiled | number | undefined, env: Env) => evalNum(c, env);

/** Compile an optional field. */
export const opt = (v: unknown): Compiled | number | undefined => (v === undefined ? undefined : compileField(v));

/** "Nice" tick values covering [min, max] with at most `count` ticks. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(Number.isFinite(min) && Number.isFinite(max)) || max <= min) return [];
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Tick labels: one format per axis — exponent form when the axis is tiny or huge, else as few digits as the spacing needs. */
export function fmtTick(v: number, ticks: number[]): string {
  if (v === 0) return "0";
  const big = Math.max(...ticks.map(Math.abs), Math.abs(v));
  if (big >= 1e5 || big < 1e-2) {
    const e = Math.floor(Math.log10(Math.abs(v)));
    const m = v / 10 ** e;
    return Math.abs(m - Math.round(m)) < 1e-6 ? `${Math.round(m)}e${e}` : `${m.toFixed(1)}e${e}`;
  }
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : Math.abs(v);
  const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(decimals);
}

/** Log-scale ticks: powers of ten inside [min, max] (min > 0). */
export function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = Math.ceil(Math.log10(min) - 1e-9); e <= Math.floor(Math.log10(max) + 1e-9); e++) out.push(10 ** e);
  return out;
}

/** Spread label positions (sorted by desired y) so neighbours are at least `gap` apart, within [lo, hi]. */
export function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
  const idx = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const [y, i] of idx) {
    const v = Math.max(y, prev + gap, lo);
    out[i] = v;
    prev = v;
  }
  // Push back up if the last ones ran past `hi`.
  let next = Infinity;
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k][1];
    out[i] = Math.min(out[i], next - gap, hi);
    next = out[i];
  }
  return out;
}

/** Approximate text width in px for layout before drawing (the kit's 11px label/mono fonts). */
export const textWidth = (ctx: CanvasRenderingContext2D, s: string, font = '11px "Geist Mono Variable", ui-monospace, monospace') => {
  ctx.font = font;
  return ctx.measureText(s).width;
};

export { num };

// ---------------------------------------------------------------------------
// Plot frames (shared by calculus-plot and parametric-plot)
// ---------------------------------------------------------------------------

export interface Frame {
  px: (x: number) => number;
  py: (y: number) => number;
  box: { left: number; top: number; width: number; height: number };
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Axes with nice ticks inside `area` (labels included). `equal` widens one range so both axes share a scale.
 * `rightPad` reserves room for curve labels at the right edge.
 */
export function plotFrame(
  ctx: CanvasRenderingContext2D,
  area: { left: number; top: number; width: number; height: number },
  o: { x: [number, number]; y: [number, number]; xLabel?: string; yLabel?: string; equal?: boolean; rightPad?: number; xTicks?: boolean },
): Frame {
  let [x0, x1] = o.x;
  let [y0, y1] = o.y;
  if (!(Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0)) [x0, x1] = [0, 1];
  if (!(Number.isFinite(y0) && Number.isFinite(y1) && y1 > y0)) [y0, y1] = [0, 1];
  const yTicks0 = niceTicks(y0, y1, Math.max(2, Math.floor((area.height - 50) / 46)));
  const yLabels0 = yTicks0.map((v) => fmtTick(v, yTicks0));
  const left = area.left + 18 + Math.max(16, ...yLabels0.map((s) => textWidth(ctx, s)));
  const xLabelW = o.xLabel ? textWidth(ctx, o.xLabel, '11px "Geist Variable", system-ui, sans-serif') + 26 : 0;
  const right = Math.max(18, xLabelW, o.rightPad ?? 0);
  const top = area.top + (o.yLabel ? 30 : 14);
  const bottom = o.xTicks === false ? 14 : 34;
  const box = { left, top, width: Math.max(40, area.left + area.width - right - left), height: Math.max(30, area.top + area.height - bottom - top) };
  if (o.equal) {
    // Same units per pixel on both axes: grow the range that is too small for its side.
    const sx = (x1 - x0) / box.width;
    const sy = (y1 - y0) / box.height;
    if (sx > sy) {
      const pad = (sx * box.height - (y1 - y0)) / 2;
      y0 -= pad;
      y1 += pad;
    } else {
      const pad = (sy * box.width - (x1 - x0)) / 2;
      x0 -= pad;
      x1 += pad;
    }
  }
  const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor((box.width - 40) / 90)));
  const yTicks = niceTicks(y0, y1, Math.max(2, Math.floor((box.height - 20) / 46)));
  const xl = xTicks.map((v) => fmtTick(v, xTicks));
  const yl = yTicks.map((v) => fmtTick(v, yTicks));
  const ax = axes(ctx, box, {
    xDomain: [x0, x1],
    yDomain: [y0, y1],
    xTicks: o.xTicks === false ? [] : xTicks,
    yTicks,
    xFormat: (v) => xl[xTicks.indexOf(v)] ?? "",
    yFormat: (v) => yl[yTicks.indexOf(v)] ?? "",
    xLabel: o.xLabel,
    yLabel: o.yLabel,
    grid: true,
  });
  return { px: ax.x, py: ax.y, box, x0, x1, y0, y1 };
}

/** Finite min/max of values (with a fallback when there are none). */
export function extent(values: number[], fallback: [number, number] = [0, 1]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values)
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (!(hi >= lo)) return fallback;
  if (hi === lo) return [lo - (Math.abs(lo) || 1) * 0.5, hi + (Math.abs(hi) || 1) * 0.5];
  return [lo, hi];
}

/** A shared loop clock for step animations: elapsed steps with a hold at the end, then repeat. */
export function stepIndex(t: number, count: number, perSecond: number, hold = 1.6): number {
  if (count <= 1) return 0;
  const cycle = (count - 1) / perSecond + hold;
  const s = ((t % cycle) + cycle) % cycle;
  return Math.min(count - 1, Math.floor(s * perSecond));
}
