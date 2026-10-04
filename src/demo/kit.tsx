// Demo kit: the only module generated demos should import besides React and
// ../../types. Keeps every demo in one visual language — thin monochrome line
// art on the dark stage, italic serif for physical symbols, mono for numbers.

import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export const theme = {
  bg: "#0a0a0a",
  fg: "#ededed",
  muted: "#a1a1a1",
  faint: "#5c5c5c",
  grid: "#1f1f1f",
  /** One accent, for the single quantity the demo is about. Use sparingly. */
  accent: "#52a8ff",
  /** Second accent for a contrasting quantity (e.g. U vs T). */
  accent2: "#f5a623",
  fonts: {
    /** Physical symbols and variable names: m, g, F, ds, r₀ … */
    symbol: 'italic 15px "KaTeX_Math", "Times New Roman", serif',
    /** Small annotations: "Earth", "shot sideways", tick labels. */
    label: '11px "Geist Variable", system-ui, sans-serif',
    mono: '11px "Geist Mono Variable", ui-monospace, monospace',
  },
} as const;

// ---------------------------------------------------------------------------
// Stage: a DPR-aware canvas with an animation loop
// ---------------------------------------------------------------------------

export interface FrameInfo {
  /** Seconds since last frame, clamped to 1/30. 0 while paused. */
  dt: number;
  /** Seconds of simulated (playing) time since mount / last reset. */
  t: number;
  width: number;
  height: number;
}

export interface StageProps {
  width: number;
  height: number;
  playing: boolean;
  /**
   * Called every animation frame (also while paused, with dt = 0) after the
   * canvas is cleared. Advance your simulation by `dt`, then draw. Reads the
   * latest closure on every frame, so it is safe to use current props inside.
   */
  onFrame: (ctx: CanvasRenderingContext2D, frame: FrameInfo) => void;
  /** Change to restart the `t` clock (pass DemoProps.resetKey). */
  resetKey?: unknown;
  onPointerDown?: (p: { x: number; y: number }) => void;
  onPointerMove?: (p: { x: number; y: number; down: boolean }) => void;
  onPointerUp?: () => void;
}

export function Stage({
  width,
  height,
  playing,
  onFrame,
  resetKey,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(onFrame);
  const playingRef = useRef(playing);
  const tRef = useRef(0);
  const downRef = useRef(false);
  frameRef.current = onFrame;
  playingRef.current = playing;

  useEffect(() => {
    tRef.current = 0;
  }, [resetKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const raw = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const dt = playingRef.current ? raw : 0;
      tRef.current += dt;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      frameRef.current(ctx, { dt, t: tRef.current, width, height });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // The shell may CSS-scale the stage on narrow screens: map back to stage coordinates.
    const r = e.currentTarget.getBoundingClientRect();
    const sx = r.width ? width / r.width : 1;
    const sy = r.height ? height / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block", touchAction: "none" }}
      onPointerDown={(e) => {
        downRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onPointerDown?.(point(e));
      }}
      onPointerMove={(e) => onPointerMove?.({ ...point(e), down: downRef.current })}
      onPointerUp={() => {
        downRef.current = false;
        onPointerUp?.();
      }}
    />
  );
}

/**
 * A ref holding simulation state that is re-initialised whenever any of
 * `deps` change (typically [resetKey, preset] plus params that need a restart).
 */
export function useSim<T>(init: () => T, deps: unknown[]): React.MutableRefObject<T> {
  const ref = useRef<T>(null as T);
  const key = useRef<unknown[] | null>(null);
  if (key.current === null || deps.length !== key.current.length || deps.some((d, i) => !Object.is(d, key.current![i]))) {
    ref.current = init();
    key.current = deps;
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Drawing helpers (all take ctx first; coordinates in CSS px)
// ---------------------------------------------------------------------------

interface StrokeOpts {
  color?: string;
  width?: number;
  dash?: number[];
  alpha?: number;
}

function stroke(ctx: CanvasRenderingContext2D, o: StrokeOpts = {}) {
  ctx.strokeStyle = o.color ?? theme.fg;
  ctx.lineWidth = o.width ?? 1.25;
  ctx.setLineDash(o.dash ?? []);
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export const draw = {
  line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, o?: StrokeOpts) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    stroke(ctx, o);
  },

  polyline(ctx: CanvasRenderingContext2D, pts: [number, number][], o?: StrokeOpts & { close?: boolean }) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (o?.close) ctx.closePath();
    stroke(ctx, o);
  },

  /** Arrow from (x1,y1) to (x2,y2) with an open head at the tip. */
  arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, o?: StrokeOpts & { head?: number }) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.5) return;
    const head = Math.min(o?.head ?? 7, len * 0.5);
    const a = Math.atan2(y2 - y1, x2 - x1);
    draw.line(ctx, x1, y1, x2, y2, o);
    ctx.beginPath();
    ctx.moveTo(x2 - head * Math.cos(a - 0.4), y2 - head * Math.sin(a - 0.4));
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(a + 0.4), y2 - head * Math.sin(a + 0.4));
    stroke(ctx, { ...o, dash: [] });
  },

  /** Circle outline; `fill` defaults to the stage background so it hides lines behind it. */
  circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, o?: StrokeOpts & { fill?: string | null }) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const fill = o?.fill === undefined ? theme.bg : o.fill;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    stroke(ctx, o);
  },

  /** Small solid dot (points on plots, pivots). */
  dot(ctx: CanvasRenderingContext2D, x: number, y: number, r = 2.5, color: string = theme.fg) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  },

  rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o?: StrokeOpts & { fill?: string | null }) {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    if (o?.fill) {
      ctx.fillStyle = o.fill;
      ctx.fill();
    }
    stroke(ctx, o);
  },

  /**
   * Text. kind "symbol" = italic serif for physics symbols (m, F, ds),
   * "label" = small sans annotation, "mono" = numbers.
   */
  text(
    ctx: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    o?: { kind?: "symbol" | "label" | "mono"; color?: string; align?: CanvasTextAlign; baseline?: CanvasTextBaseline; size?: number },
  ) {
    const kind = o?.kind ?? "label";
    let font: string = theme.fonts[kind];
    if (o?.size) font = font.replace(/\d+px/, `${o.size}px`);
    ctx.font = font;
    ctx.fillStyle = o?.color ?? (kind === "symbol" ? theme.fg : theme.muted);
    ctx.textAlign = o?.align ?? "left";
    ctx.textBaseline = o?.baseline ?? "middle";
    ctx.fillText(s, x, y);
  },

  /** Hatched ground line from x1 to x2 at height y (hatches below), like the book's figures. */
  ground(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, o?: StrokeOpts) {
    draw.line(ctx, x1, y, x2, y, o);
    for (let x = x1 + 4; x < x2; x += 9) draw.line(ctx, x, y, x - 7, y + 7, { ...o, width: 1, color: o?.color ?? theme.muted });
  },

  /** Coil spring between two points. */
  spring(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, o?: StrokeOpts & { coils?: number; amp?: number }) {
    const coils = o?.coils ?? 10;
    const amp = o?.amp ?? 6;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const pts: [number, number][] = [[x1, y1]];
    const lead = Math.min(8, len * 0.1);
    pts.push([x1 + ux * lead, y1 + uy * lead]);
    const n = coils * 2;
    for (let i = 1; i < n; i++) {
      const s = lead + ((len - 2 * lead) * i) / n;
      const side = i % 2 ? amp : -amp;
      pts.push([x1 + ux * s - uy * side, y1 + uy * s + ux * side]);
    }
    pts.push([x2 - ux * lead, y2 - uy * lead], [x2, y2]);
    draw.polyline(ctx, pts, o);
  },

  /**
   * Heatmap grid (attention weights, matrices, tables of numbers). `box` is the
   * whole area including labels: row labels take a column on the left, column
   * labels a row on top. Values map to colours through `map` after normalising
   * by `domain` (default: min..max of the values). Returns the cell geometry so
   * you can draw on top (e.g. outline the cell under discussion).
   */
  matrix(ctx: CanvasRenderingContext2D, values: number[][], box: Box, o: MatrixOpts = {}): MatrixLayout {
    const rows = values.length;
    const cols = rows ? values[0].length : 0;
    const labelSize = o.labelSize ?? 11;
    ctx.font = theme.fonts.label.replace(/\d+px/, `${labelSize}px`);
    const rowW = o.rowLabels?.length ? Math.max(...o.rowLabels.map((s) => ctx.measureText(s).width)) + 8 : 0;
    const colH = o.colLabels?.length ? labelSize + 8 : 0;
    const gap = o.gap ?? 1;
    const gw = Math.max(0, box.width - rowW);
    const gh = Math.max(0, box.height - colH);
    const size = o.square === false ? null : Math.min(gw / Math.max(1, cols), gh / Math.max(1, rows));
    const cw = size ?? gw / Math.max(1, cols);
    const chh = size ?? gh / Math.max(1, rows);
    const left = box.left + rowW;
    const top = box.top + colH;
    const flat = values.flat();
    const [d0, d1] = o.domain ?? [Math.min(...flat), Math.max(...flat)];
    const map = o.map ?? sequential;
    const cell = (r: number, c: number) => ({ x: left + c * cw, y: top + r * chh, w: cw, h: chh });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = values[r][c];
        const t = d1 === d0 ? 0.5 : clamp((v - d0) / (d1 - d0), 0, 1);
        const color = map(t);
        const { x, y, w, h } = cell(r, c);
        ctx.fillStyle = color;
        ctx.fillRect(x + gap / 2, y + gap / 2, Math.max(0, w - gap), Math.max(0, h - gap));
        if (o.showValues && w > 22 && h > 12) {
          draw.text(ctx, (o.format ?? ((n: number) => n.toFixed(2)))(v), x + w / 2, y + h / 2, {
            kind: "mono",
            align: "center",
            size: Math.min(11, Math.floor(h * 0.45), Math.floor(w / 3.6)),
            color: luminance(color) > 0.45 ? theme.bg : theme.fg,
          });
        }
      }
    }
    const hl = o.highlight;
    if (hl) {
      const outline = (x: number, y: number, w: number, h: number) => draw.rect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, { color: theme.fg, width: 1.5 });
      if (hl.row !== undefined && hl.row >= 0 && hl.row < rows) outline(left, top + hl.row * chh, cols * cw, chh);
      if (hl.col !== undefined && hl.col >= 0 && hl.col < cols) outline(left + hl.col * cw, top, cw, rows * chh);
      for (const [r, c] of hl.cells ?? []) if (r >= 0 && r < rows && c >= 0 && c < cols) outline(cell(r, c).x, cell(r, c).y, cw, chh);
    }
    o.rowLabels?.forEach((s, r) => draw.text(ctx, s, left - 6, top + r * chh + chh / 2, { align: "right", size: labelSize, color: hl?.row === r ? theme.fg : theme.muted }));
    o.colLabels?.forEach((s, c) => draw.text(ctx, s, left + c * cw + cw / 2, box.top + labelSize / 2 + 1, { align: "center", size: labelSize, color: hl?.col === c ? theme.fg : theme.muted }));
    return { left, top, cellWidth: cw, cellHeight: chh, width: cols * cw, height: rows * chh, cell };
  },

  /**
   * Vertical bar chart inside `box` (labels below the baseline, optional
   * values above the bars). Negative values hang below a zero line. Returns
   * the geometry for overlays.
   */
  bars(ctx: CanvasRenderingContext2D, values: number[], box: Box, o: BarsOpts = {}): BarsLayout {
    const n = values.length;
    const labelH = o.labels?.length ? 16 : 0;
    const valueH = o.showValues ? 14 : 0;
    const lo = Math.min(0, o.min ?? Math.min(0, ...values));
    const hi = Math.max(o.max ?? Math.max(...values, 0), lo + 1e-9);
    const top = box.top + valueH;
    const bottom = box.top + box.height - labelH;
    const y = scale([lo, hi], [bottom, top]);
    const slot = box.width / Math.max(1, n);
    const w = Math.max(1, slot * (o.barWidth ?? 0.62));
    const x = (i: number) => box.left + slot * i + slot / 2;
    draw.line(ctx, box.left, y(0), box.left + box.width, y(0), { color: theme.faint, width: 1 });
    values.forEach((v, i) => {
      const color = typeof o.color === "function" ? o.color(i, v) : (o.color ?? (o.highlight === i ? theme.accent : theme.muted));
      const y0 = y(Math.max(0, v));
      const h = Math.abs(y(v) - y(0));
      ctx.fillStyle = color;
      ctx.fillRect(x(i) - w / 2, y0, w, Math.max(v === 0 ? 0 : 1, h));
      if (o.showValues) draw.text(ctx, (o.format ?? ((n: number) => n.toFixed(2)))(v), x(i), (v >= 0 ? y(v) : y(0)) - 7, { kind: "mono", align: "center", color: o.highlight === i ? theme.fg : theme.faint });
      if (o.labels?.[i] !== undefined) draw.text(ctx, o.labels[i], x(i), bottom + 10, { align: "center", color: o.highlight === i ? theme.fg : theme.muted });
    });
    return { x, y, barWidth: w };
  },

  /**
   * Small rounded box with a label — a token, a node, a memory cell. `active`
   * outlines it in the accent colour. Returns its size so chips can be laid
   * out in a row.
   */
  chip(
    ctx: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    o?: { align?: "left" | "center" | "right"; active?: boolean; color?: string; fill?: string; size?: number; mono?: boolean },
  ): { width: number; height: number } {
    const size = o?.size ?? 12;
    const kind = o?.mono ? "mono" : "label";
    ctx.font = theme.fonts[kind].replace(/\d+px/, `${size}px`);
    const width = ctx.measureText(s).width + 14;
    const height = size + 10;
    const left = o?.align === "left" ? x : o?.align === "right" ? x - width : x - width / 2;
    ctx.beginPath();
    ctx.roundRect(left, y - height / 2, width, height, 5);
    ctx.fillStyle = o?.fill ?? theme.bg;
    ctx.fill();
    ctx.strokeStyle = o?.active ? theme.accent : (o?.color ?? "#2e2e2e");
    ctx.lineWidth = 1;
    ctx.stroke();
    draw.text(ctx, s, left + width / 2, y + 0.5, { kind, align: "center", size, color: o?.active ? theme.fg : (o?.color ?? theme.muted) });
    return { width, height };
  },

  /**
   * A row of cells — an array, a block of memory, a queue. `box` is the whole
   * area including the index labels underneath. Cells are square up to
   * `maxCell` px and centred in the box. `style(i)` picks how cell i looks:
   * "active" (accent outline + tint: the cells the current step touches),
   * "muted" (out of range / discarded), "done" (settled) or "normal".
   * Returns the geometry so pointers and annotations can line up with cells.
   */
  cells(ctx: CanvasRenderingContext2D, values: (string | number)[], box: Box, o: CellsOpts = {}): CellsLayout {
    const n = values.length;
    const indexH = o.indices === false ? 0 : 16;
    const size = Math.min(o.maxCell ?? 44, box.width / Math.max(1, n), box.height - indexH);
    const width = size * n;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - indexH - size) / 2;
    const x = (i: number) => left + i * size + size / 2;
    values.forEach((v, i) => {
      const st = o.style?.(i) ?? "normal";
      const cx = left + i * size;
      if (st === "active") {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = theme.accent;
        ctx.fillRect(cx + 1, top + 1, size - 2, size - 2);
        ctx.globalAlpha = 1;
      }
      draw.rect(ctx, cx + 0.5, top + 0.5, size - 1, size - 1, {
        color: st === "active" ? theme.accent : st === "muted" ? theme.grid : "#2e2e2e",
        width: st === "active" ? 1.5 : 1,
      });
      const text = typeof v === "number" ? (o.format ?? String)(v) : v;
      draw.text(ctx, text, x(i), top + size / 2 + 0.5, {
        kind: "mono",
        align: "center",
        size: Math.min(13, Math.floor(size * 0.36)),
        color: st === "muted" ? theme.faint : st === "done" ? theme.muted : theme.fg,
      });
      if (indexH) {
        const label = Array.isArray(o.indices) ? o.indices[i] : String((o.indexStart ?? 0) + i);
        draw.text(ctx, label ?? "", x(i), top + size + 10, { kind: "mono", align: "center", size: 10, color: theme.faint });
      }
    });
    return { left, top, cellSize: size, width, height: size, x };
  },

  /**
   * A labelled pointer (lo, hi, mid, i, p, head …) aimed at a point, usually
   * the top or bottom edge of a cell. "up" draws the arrow from below pointing
   * up with the label underneath; "down" comes from above. Pointers sharing a
   * cell can be stacked by passing a larger `length`.
   */
  pointer(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, o?: { dir?: "up" | "down"; length?: number; color?: string }) {
    const dir = o?.dir ?? "up";
    const len = o?.length ?? 18;
    const color = o?.color ?? theme.fg;
    const sgn = dir === "up" ? 1 : -1;
    draw.arrow(ctx, x, y + sgn * len, x, y + sgn * 2, { color, width: 1.25, head: 5 });
    draw.text(ctx, label, x, y + sgn * (len + 8), { kind: "mono", align: "center", color, baseline: "middle" });
  },

  /**
   * A syntax-highlighted code listing in the reader's current code theme
   * (see `codeThemes`). Pass `highlight` for the line being executed: it gets
   * a faint band and an accent bar, and with `dim` the other lines fade.
   */
  code(ctx: CanvasRenderingContext2D, source: string | string[], x: number, y: number, o: CodeOpts = {}): CodeLayout {
    return drawCode(ctx, source, x, y, o);
  },
};

export interface CellsOpts {
  /** Index labels under the cells: false to hide, or custom labels (e.g. addresses). Default 0..n-1. */
  indices?: boolean | string[];
  /** First index when numbering (default 0). */
  indexStart?: number;
  style?: (i: number) => "normal" | "active" | "muted" | "done";
  format?: (v: number) => string;
  /** Largest cell size in px (default 44). */
  maxCell?: number;
}

export interface CellsLayout {
  left: number;
  top: number;
  cellSize: number;
  width: number;
  height: number;
  /** Centre x of cell i. */
  x: (i: number) => number;
}

/** A rectangle in CSS px. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MatrixOpts {
  /** t in 0..1 → CSS colour. Default `sequential`; use `diverging` for signed values (with a symmetric domain). */
  map?: (t: number) => string;
  /** Value range mapped to t = 0..1. Default: min..max of the values. */
  domain?: [number, number];
  rowLabels?: string[];
  colLabels?: string[];
  /** Print each value inside its cell (when the cell is big enough). */
  showValues?: boolean;
  format?: (v: number) => string;
  /** Outline a row, a column and/or single cells. */
  highlight?: { row?: number; col?: number; cells?: [number, number][] };
  /** Keep cells square (default true). */
  square?: boolean;
  gap?: number;
  labelSize?: number;
}

export interface MatrixLayout {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
  cell: (r: number, c: number) => { x: number; y: number; w: number; h: number };
}

export interface BarsOpts {
  labels?: string[];
  /** Axis range; default spans 0 and the data. */
  min?: number;
  max?: number;
  /** One colour, or per bar. Default: theme.muted, theme.accent for `highlight`. */
  color?: string | ((i: number, v: number) => string);
  highlight?: number;
  showValues?: boolean;
  format?: (v: number) => string;
  /** Fraction of each slot the bar fills (default 0.62). */
  barWidth?: number;
}

export interface BarsLayout {
  /** Centre x of bar i. */
  x: (i: number) => number;
  /** Value → px. */
  y: (v: number) => number;
  barWidth: number;
}

// ---------------------------------------------------------------------------
// Colour ramps (t in 0..1 → "rgb(…)")
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * clamp(t, 0, 1)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Near-background → accent. For magnitudes and probabilities. */
export function sequential(t: number): string {
  return mix([24, 24, 24], hexRgb(theme.accent), t);
}

/** accent2 (t = 0) → faint (t = 0.5) → accent (t = 1). For signed values. */
export function diverging(t: number): string {
  return t < 0.5 ? mix(hexRgb(theme.accent2), hexRgb(theme.faint), t * 2) : mix(hexRgb(theme.faint), hexRgb(theme.accent), (t - 0.5) * 2);
}

/** Relative luminance (0..1) of "#rrggbb" or "rgb(r, g, b)". */
export function luminance(color: string): number {
  const rgb = color.startsWith("#") ? hexRgb(color) : ((color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number) as Rgb);
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// ---------------------------------------------------------------------------
// Plots
// ---------------------------------------------------------------------------

export interface Axes {
  /** Data → px. */
  x: (v: number) => number;
  y: (v: number) => number;
  box: { left: number; top: number; width: number; height: number };
}

export interface AxesOpts {
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel?: string;
  yLabel?: string;
  xTicks?: number[];
  yTicks?: number[];
  /** Format tick labels. */
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  grid?: boolean;
}

/** Draw axes inside `box` and return the data→px mapping. */
export function axes(
  ctx: CanvasRenderingContext2D,
  box: { left: number; top: number; width: number; height: number },
  o: AxesOpts,
): Axes {
  const x = scale(o.xDomain, [box.left, box.left + box.width]);
  const y = scale(o.yDomain, [box.top + box.height, box.top]);
  const x0 = box.left;
  const y0 = box.top + box.height;
  if (o.grid) {
    for (const t of o.xTicks ?? []) draw.line(ctx, x(t), box.top, x(t), y0, { color: theme.grid, width: 1 });
    for (const t of o.yTicks ?? []) draw.line(ctx, x0, y(t), x0 + box.width, y(t), { color: theme.grid, width: 1 });
  }
  draw.arrow(ctx, x0, y0, x0 + box.width + 8, y0, { color: theme.muted, width: 1, head: 5 });
  draw.arrow(ctx, x0, y0, x0, box.top - 8, { color: theme.muted, width: 1, head: 5 });
  for (const t of o.xTicks ?? []) {
    draw.line(ctx, x(t), y0, x(t), y0 + 4, { color: theme.muted, width: 1 });
    draw.text(ctx, o.xFormat ? o.xFormat(t) : String(t), x(t), y0 + 14, { kind: "mono", align: "center", color: theme.faint });
  }
  for (const t of o.yTicks ?? []) {
    draw.line(ctx, x0 - 4, y(t), x0, y(t), { color: theme.muted, width: 1 });
    draw.text(ctx, o.yFormat ? o.yFormat(t) : String(t), x0 - 8, y(t), { kind: "mono", align: "right", color: theme.faint });
  }
  if (o.xLabel) draw.text(ctx, o.xLabel, x0 + box.width + 14, y0, { kind: "symbol", align: "left" });
  if (o.yLabel) draw.text(ctx, o.yLabel, x0, box.top - 18, { kind: "symbol", align: "center" });
  return { x, y, box };
}

// ---------------------------------------------------------------------------
// Math utilities
// ---------------------------------------------------------------------------

/** Linear map from domain to range. */
export function scale([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  return (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Format a number for a readout: fixed digits, or exponent form when very small/large. */
export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return v.toFixed(digits);
}

/** One RK4 step for a state vector. */
export function rk4(state: number[], dt: number, deriv: (s: number[]) => number[]): number[] {
  const add = (a: number[], b: number[], k: number) => a.map((v, i) => v + b[i] * k);
  const k1 = deriv(state);
  const k2 = deriv(add(state, k1, dt / 2));
  const k3 = deriv(add(state, k2, dt / 2));
  const k4 = deriv(add(state, k3, dt));
  return state.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

// ---------------------------------------------------------------------------
// Seeded randomness and small linear algebra (for ML / CS demos)
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32). `const next = rng(42); next()` → [0, 1).
 * Use instead of Math.random so every render of a demo is identical.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample from a PRNG made by `rng` (Box–Muller). */
export function randn(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** rows × cols matrix of N(0, std²) samples from a PRNG made by `rng`. */
export function randMatrix(rows: number, cols: number, next: () => number, std = 1): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => randn(next) * std));
}

/** Numerically stable softmax; `temperature` divides the logits first. */
export function softmax(xs: number[], temperature = 1): number[] {
  const z = xs.map((x) => x / temperature);
  const m = Math.max(...z);
  const e = z.map((x) => (Number.isFinite(x) ? Math.exp(x - m) : 0));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / s);
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** A (n×k) · B (k×m) → n×m. */
export function matmul(a: number[][], b: number[][]): number[][] {
  const m = b[0]?.length ?? 0;
  return a.map((row) => Array.from({ length: m }, (_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
}

export function transpose(a: number[][]): number[][] {
  return (a[0] ?? []).map((_, j) => a.map((row) => row[j]));
}

// ---------------------------------------------------------------------------
// Code listings: a tiny tokenizer + colour schemes for draw.code
// ---------------------------------------------------------------------------

export type CodeLang = "c" | "cpp" | "java" | "js" | "ts" | "go" | "rust" | "python" | "pseudo";

export type TokenKind = "plain" | "keyword" | "type" | "string" | "number" | "comment" | "function" | "operator" | "punct" | "preproc";

export interface CodeTheme {
  name: string;
  label: string;
  colors: Record<TokenKind, string>;
  /** Band behind the highlighted line. */
  lineHighlight: string;
}

/** Colour schemes for code listings. "vercel" follows the Geist syntax palette. */
export const codeThemes: Record<string, CodeTheme> = {
  vercel: {
    name: "vercel",
    label: "Vercel",
    colors: {
      plain: "#ededed",
      keyword: "#f75f8f",
      type: "#52a8ff",
      string: "#62c073",
      number: "#52a8ff",
      comment: "#8f8f8f",
      function: "#c472fb",
      operator: "#ededed",
      punct: "#a1a1a1",
      preproc: "#f75f8f",
    },
    lineHighlight: "rgba(82, 168, 255, 0.12)",
  },
  github: {
    name: "github",
    label: "GitHub Dark",
    colors: {
      plain: "#e6edf3",
      keyword: "#ff7b72",
      type: "#ffa657",
      string: "#a5d6ff",
      number: "#79c0ff",
      comment: "#8b949e",
      function: "#d2a8ff",
      operator: "#ff7b72",
      punct: "#c9d1d9",
      preproc: "#ff7b72",
    },
    lineHighlight: "rgba(56, 139, 253, 0.15)",
  },
  rosepine: {
    name: "rosepine",
    label: "Rosé Pine",
    colors: {
      plain: "#e0def4",
      keyword: "#31748f",
      type: "#9ccfd8",
      string: "#f6c177",
      number: "#ebbcba",
      comment: "#6e6a86",
      function: "#ebbcba",
      operator: "#908caa",
      punct: "#908caa",
      preproc: "#c4a7e7",
    },
    lineHighlight: "rgba(196, 167, 231, 0.12)",
  },
  mono: {
    name: "mono",
    label: "Monochrome",
    colors: {
      plain: "#ededed",
      keyword: "#ffffff",
      type: "#d4d4d4",
      string: "#a1a1a1",
      number: "#d4d4d4",
      comment: "#5c5c5c",
      function: "#ededed",
      operator: "#a1a1a1",
      punct: "#7c7c7c",
      preproc: "#a1a1a1",
    },
    lineHighlight: "rgba(255, 255, 255, 0.07)",
  },
};

const CODE_THEME_KEY = "yagami.codeTheme";
let currentCodeTheme = "vercel";
try {
  const saved = globalThis.localStorage?.getItem(CODE_THEME_KEY);
  if (saved && codeThemes[saved]) currentCodeTheme = saved;
} catch {
  // storage unavailable (private mode / non-browser): keep the default
}

/** The reader's selected code theme (persisted; demos pick it up on the next frame). */
export function getCodeTheme(): CodeTheme {
  return codeThemes[currentCodeTheme] ?? codeThemes.vercel;
}

export function setCodeTheme(name: string): void {
  if (!codeThemes[name]) return;
  currentCodeTheme = name;
  try {
    globalThis.localStorage?.setItem(CODE_THEME_KEY, name);
  } catch {
    // ignore
  }
}

const KEYWORDS: Record<"c" | "js" | "python" | "go" | "rust" | "pseudo", string[]> = {
  c: "if else while for do return break continue switch case default goto sizeof struct union enum typedef static const extern inline volatile register new delete class public private protected template typename namespace using virtual this nullptr true false NULL".split(" "),
  js: "if else while for do return break continue switch case default function const let var new class extends this typeof instanceof in of await async yield try catch finally throw import export from true false null undefined".split(" "),
  python: "if elif else while for in return break continue def class lambda pass import from as with try except finally raise yield and or not is None True False global nonlocal".split(" "),
  go: "if else for range return break continue switch case default func var const type struct interface map chan go defer package import nil true false".split(" "),
  rust: "if else while for loop in return break continue match fn let mut const struct enum impl trait pub use mod self Self true false as ref move".split(" "),
  pseudo: "if then else elif while do for to downto each in return break continue function procedure end and or not true false nil null".split(" "),
};

const TYPES = new Set(
  "void int char short long float double bool unsigned signed size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t uintptr_t word_t block_t string number boolean i32 i64 u8 u32 u64 usize f32 f64 str".split(" "),
);

function keywordsFor(lang: CodeLang): Set<string> {
  const k =
    lang === "python" ? KEYWORDS.python : lang === "go" ? KEYWORDS.go : lang === "rust" ? KEYWORDS.rust : lang === "js" || lang === "ts" ? KEYWORDS.js : lang === "pseudo" ? KEYWORDS.pseudo : KEYWORDS.c;
  return new Set(k);
}

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Split one line of code into coloured tokens. Good enough for short listings; not a parser. */
export function tokenizeLine(line: string, lang: CodeLang = "c"): Token[] {
  const kw = keywordsFor(lang);
  const lineComment = lang === "python" ? "#" : lang === "pseudo" ? "//" : "//";
  const out: Token[] = [];
  let i = 0;
  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  if ((lang === "c" || lang === "cpp") && /^\s*#/.test(line)) {
    const m = /^(\s*#\s*\w+)(.*)$/.exec(line)!;
    push(m[1], "preproc");
    line = m[2];
    if (!line) return out;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith(lineComment) || (lang !== "python" && rest.startsWith("/*"))) {
      push(rest, "comment");
      break;
    }
    const str = /^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/.exec(rest);
    if (str) {
      push(str[0], "string");
      i += str[0].length;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)[uUlLfF]*/.exec(rest);
    if (num && !/[A-Za-z_]/.test(line[i - 1] ?? "")) {
      push(num[0], "number");
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) {
      const w = id[0];
      const next = rest.slice(w.length).trimStart()[0];
      const kind: TokenKind = kw.has(w) ? "keyword" : TYPES.has(w) ? "type" : next === "(" ? "function" : "plain";
      push(w, kind);
      i += w.length;
      continue;
    }
    const op = /^(<<=?|>>=?|[-+*/%=!<>&|^~?:]=?|&&|\|\||->|\+\+|--)/.exec(rest);
    if (op) {
      push(op[0], "operator");
      i += op[0].length;
      continue;
    }
    const ch = rest[0];
    push(ch, /[()[\]{},;.]/.test(ch) ? "punct" : "plain");
    i += 1;
  }
  return out;
}

export interface CodeOpts {
  lang?: CodeLang;
  /** Font size in px (default 12). */
  size?: number;
  /** Line height in px (default size × 1.6). */
  lineHeight?: number;
  /** 0-based line(s) to highlight (e.g. the line being executed). */
  highlight?: number | number[];
  /** Fade lines that aren't highlighted. */
  dim?: boolean;
  /** Show line numbers in a faint gutter. */
  lineNumbers?: boolean;
  /** Width of the highlight band (default: longest line + padding). */
  width?: number;
  /** Override the reader's selected theme (rarely needed). */
  theme?: string;
}

export interface CodeLayout {
  width: number;
  height: number;
  /** Baseline-centre y of line i. */
  lineY: (i: number) => number;
  /** x where code text starts (after the gutter). */
  textX: number;
}

function drawCode(ctx: CanvasRenderingContext2D, source: string | string[], x: number, y: number, o: CodeOpts): CodeLayout {
  const lines = (Array.isArray(source) ? source : source.replace(/\t/g, "  ").split("\n")).map((l) => l.replace(/\t/g, "  "));
  const t = o.theme ? (codeThemes[o.theme] ?? getCodeTheme()) : getCodeTheme();
  const size = o.size ?? 12;
  const lh = o.lineHeight ?? Math.round(size * 1.6);
  const font = `${size}px "Geist Mono Variable", ui-monospace, monospace`;
  ctx.font = font;
  const charW = ctx.measureText("M").width;
  const gutter = o.lineNumbers ? Math.ceil(String(lines.length).length * charW + 14) : 0;
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const width = o.width ?? gutter + longest * charW + 16;
  const hl = new Set(o.highlight === undefined ? [] : Array.isArray(o.highlight) ? o.highlight : [o.highlight]);
  const lineY = (i: number) => y + i * lh + lh / 2;
  const textX = x + gutter + 8;

  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const i of hl) {
    if (i < 0 || i >= lines.length) continue;
    ctx.fillStyle = t.lineHighlight;
    ctx.fillRect(x, y + i * lh, width, lh);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, y + i * lh, 2, lh);
  }
  lines.forEach((line, i) => {
    const faded = o.dim && hl.size > 0 && !hl.has(i);
    ctx.globalAlpha = faded ? 0.4 : 1;
    ctx.font = font;
    if (o.lineNumbers) {
      ctx.fillStyle = theme.faint;
      ctx.textAlign = "right";
      ctx.fillText(String(i + 1), x + gutter - 6, lineY(i));
      ctx.textAlign = "left";
    }
    let cx = textX;
    for (const tok of tokenizeLine(line, o.lang ?? "c")) {
      ctx.fillStyle = t.colors[tok.kind];
      ctx.font = tok.kind === "comment" ? `italic ${font}` : font;
      ctx.fillText(tok.text, cx, lineY(i));
      cx += ctx.measureText(tok.text).width;
    }
  });
  ctx.restore();
  return { width, height: lines.length * lh, lineY, textX };
}
