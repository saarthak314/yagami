// hash-chain: blocks linked by the hash of the previous block (with an optional toy proof-of-work), or a
// Merkle tree hashed pairwise up to the root — a proof path, tampering and pruning step by step.

import { useMemo, useRef } from "react";
import { draw, theme } from "../kit";
import { Stage } from "./stage";
import { hashSetup, type HashChainConfig } from "./configs";
import { runHashChain, type HashStep } from "./hashing";
import { END_HOLD, applyDefs, autoPace, compileDefs, compileReadouts, drawNote, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { MONO_FONT } from "./ui";

function fit(ctx: CanvasRenderingContext2D, s: string, w: number) {
  let t = s;
  while (t.length > 2 && textWidth(ctx, t, MONO_FONT) > w) t = `${t.slice(0, -2)}…`;
  return t;
}

export default function HashChain({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<HashChainConfig>) {
  const c = useMemo(() => ({ defs: compileDefs(config.defs), speed: opt(config.speed), readouts: compileReadouts(config.readouts) }), [config]);
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env = applyDefs(paramEnv(params), c.defs);
    const setup = hashSetup(config, env);
    const steps = runHashChain(setup);
    const finals = Object.fromEntries(Object.entries({ ...steps[steps.length - 1].vars, steps: steps.length }).map(([k, v]) => [`final_${k}`, v]));
    return { env, setup, steps, finals };
  }, [c, paramsKey, config]); // params enter through paramsKey
  const clock = useRef({ t: 0, key: resetKey, run });

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const clk = clock.current;
        if (clk.key !== resetKey || clk.run !== run) Object.assign(clk, { t: 0, key: resetKey, run });
        clk.t += dt;
        const steps = run.steps;
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 1 : autoPace(steps.length));
        const k = stepIndex(clk.t, steps.length, speed, END_HOLD);
        const st = steps[k];
        setReadouts(readoutValues(c.readouts, { ...run.env, ...run.finals, ...st.vars, step: k, steps: steps.length, done: k === steps.length - 1 ? 1 : 0 }));
        if (width < 80 || height < 80) return;
        const m = 14;
        const noteH = 40;
        if (config.mode === "chain") drawChain(ctx, st, run.setup.difficulty, width, height - noteH, m);
        else drawMerkle(ctx, st, width, height - noteH, m);
        drawNote(ctx, st.msg, width, height - noteH + 12);
      }}
    />
  );
}

function drawChain(ctx: CanvasRenderingContext2D, st: HashStep, difficulty: number, W: number, H: number, m: number) {
  const n = st.blocks.length;
  const gap = 24;
  // As many columns as fit at a readable width (≥ 150 px), balanced over the rows.
  const fitCols = Math.max(1, Math.min(n, Math.floor((W - 2 * m + gap) / (150 + gap))));
  const rows = Math.ceil(n / fitCols);
  const cols = Math.ceil(n / rows);
  const bw = Math.max(84, Math.min(210, (W - 2 * m - gap * (cols - 1)) / cols));
  const lineH = 14;
  const lines = difficulty ? 5 : 4;
  const bh = lines * lineH + 10;
  const rowGap = 26;
  const totalH = rows * bh + (rows - 1) * rowGap;
  const top = Math.max(m, (H - totalH) / 2);
  const left0 = (W - (cols * bw + (cols - 1) * gap)) / 2;
  const pos = (i: number) => ({ x: left0 + (i % cols) * (bw + gap), y: top + Math.floor(i / cols) * (bh + rowGap) });
  const lineY = (i: number, l: number) => pos(i).y + 6 + lineH * (l + 0.5);
  for (let i = 0; i < Math.min(n, st.shown); i++) {
    const b = st.blocks[i];
    const { x, y } = pos(i);
    const hot = st.hot === i;
    draw.rect(ctx, x + 0.5, y + 0.5, bw - 1, bh - 1, { color: hot ? theme.accent : theme.line, width: hot ? 1.75 : 1 });
    const prevBad = i > 0 && !b.link;
    const rowsTxt: [string, string, string][] = [
      [`block ${i}`, "", theme.fg],
      ["prev", b.prev, prevBad ? theme.accent2 : theme.muted],
      ["data", b.data, theme.fg],
      ...(difficulty ? ([["nonce", String(b.nonce), theme.muted]] as [string, string, string][]) : []),
      ["hash", b.hash, !b.work ? theme.accent2 : hot ? theme.accent : theme.fg],
    ];
    rowsTxt.forEach(([k, v, col], l) => {
      if (l === 0) draw.text(ctx, k, x + 8, lineY(i, l), { size: 11, color: theme.fg });
      else {
        draw.text(ctx, k, x + 8, lineY(i, l), { kind: "mono", size: 10, color: theme.faint });
        draw.text(ctx, fit(ctx, v, bw - 52), x + 46, lineY(i, l), { kind: "mono", size: 10, color: col });
      }
    });
    if (i === 0) continue;
    // Link: this block's prev → the previous block's hash.
    const p = pos(i - 1);
    const color = prevBad ? theme.accent2 : theme.muted;
    const dash = prevBad ? [4, 3] : undefined;
    const yFrom = lineY(i, 1);
    const yTo = lineY(i - 1, lines - 1);
    if (p.y === pos(i).y) {
      draw.arrow(ctx, x - 2, yFrom, p.x + bw + 2, yTo, { color, width: 1.25, head: 5, dash });
      if (prevBad) draw.text(ctx, "✕", (x + p.x + bw) / 2, (yFrom + yTo) / 2 - 8, { align: "center", color: theme.accent2, size: 12 });
    } else {
      const xl = x - 8;
      const yg = y - rowGap / 2;
      const xr = p.x + bw + 8;
      draw.polyline(ctx, [[x - 2, yFrom], [xl, yFrom], [xl, yg], [xr, yg], [xr, yTo]], { color, width: 1.25, dash });
      draw.arrow(ctx, xr, yTo, p.x + bw + 2, yTo, { color, width: 1.25, head: 5 });
      if (prevBad) draw.text(ctx, "✕", (xl + xr) / 2, yg, { align: "center", color: theme.accent2, size: 12 });
    }
  }
  if (st.shown === 0) draw.text(ctx, `${st.records.length} records: ${st.records.join(", ")}`, W / 2, H / 2, { align: "center", color: theme.muted });
}

function drawMerkle(ctx: CanvasRenderingContext2D, st: HashStep, W: number, H: number, m: number) {
  const tree = st.tree;
  const L = tree.length;
  const n = tree[0]?.length ?? 0;
  if (!n) return;
  const rowH = Math.max(34, Math.min(84, (H - m) / (L + 1)));
  const top0 = m + Math.max(0, (H - m - rowH * (L + 1)) / 2);
  const sw = (W - 2 * m) / n;
  const bw = Math.max(36, Math.min(86, sw - 8));
  const bh = Math.min(32, rowH - 12);
  const xs: number[][] = [tree[0].map((_, i) => m + sw * (i + 0.5))];
  for (let l = 1; l < L; l++) xs.push(tree[l].map((_, i) => (xs[l - 1][2 * i] + (xs[l - 1][2 * i + 1] ?? xs[l - 1][2 * i])) / 2));
  const yOf = (l: number) => top0 + (L - 1 - l) * rowH + bh / 2;
  const txY = yOf(0) + rowH;
  const pruned = (key: string) => st.prune[key];
  const has = (arr: string[], key: string) => arr.includes(key);

  // Edges first.
  for (let l = 1; l < Math.min(L, st.levels); l++)
    tree[l].forEach((_, i) => {
      const key = `${l}:${i}`;
      if (pruned(key)) return; // a stub's children are discarded; a discarded node has none
      for (const ci of [2 * i, 2 * i + 1]) {
        if (ci >= tree[l - 1].length) continue;
        const ck = `${l - 1}:${ci}`;
        if (pruned(ck) === "gone") continue;
        const on = has(st.path, key) && has(st.path, ck);
        draw.line(ctx, xs[l][i], yOf(l) + bh / 2, xs[l - 1][ci], yOf(l - 1) - bh / 2, { color: on ? theme.accent : theme.line, width: on ? 2 : 1.25 });
      }
    });
  // Transactions under the leaves.
  st.records.forEach((r, i) => {
    const leafKey = `0:${i}`;
    if (pruned(leafKey)) return;
    const x = xs[0][i];
    if (st.levels > 0) draw.line(ctx, x, yOf(0) + bh / 2, x, txY - 11, { color: has(st.path, leafKey) ? theme.accent : theme.line, width: 1.25 });
    const changed = has(st.changed, leafKey);
    draw.rect(ctx, x - bw / 2 + 0.5, txY - 10.5, bw - 1, 21, { color: changed ? theme.accent2 : theme.muted, width: 1 });
    draw.text(ctx, fit(ctx, r, bw - 8), x, txY, { kind: "mono", align: "center", size: 10, color: theme.fg });
  });
  // Nodes.
  for (let l = 0; l < Math.min(L, st.levels); l++)
    tree[l].forEach((nd, i) => {
      const key = `${l}:${i}`;
      if (pruned(key) === "gone") return;
      const x = xs[l][i];
      const y = yOf(l);
      const onPath = has(st.path, key);
      const sib = has(st.sib, key);
      const changed = has(st.changed, key);
      const stub = pruned(key) === "stub";
      const color = onPath ? theme.accent : changed || sib ? theme.accent2 : theme.muted;
      if (onPath) {
        ctx.save();
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = theme.accent;
        ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
        ctx.restore();
      }
      draw.rect(ctx, x - bw / 2 + 0.5, y - bh / 2 + 0.5, bw - 1, bh - 1, { color, width: onPath || sib || changed ? 1.75 : 1, dash: stub ? [4, 3] : undefined });
      const two = bh >= 26;
      if (two) {
        draw.text(ctx, fit(ctx, nd.name, bw - 6), x, y - 7, { align: "center", size: 10, color: theme.muted });
        draw.text(ctx, nd.hash, x, y + 7, { kind: "mono", align: "center", size: 10, color: changed ? theme.accent2 : theme.fg });
      } else draw.text(ctx, nd.hash, x, y, { kind: "mono", align: "center", size: 10, color: changed ? theme.accent2 : theme.fg });
    });
}
