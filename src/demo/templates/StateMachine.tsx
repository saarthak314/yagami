// state-machine: a finite automaton reading its input (state graph) or a Turing machine stepping over its
// tape (transition table with the active row) — the tape, the head and the state at every step.

import { useMemo, useRef } from "react";
import { draw, theme } from "../kit";
import { Stage } from "./stage";
import { machineSetup, type StateMachineConfig } from "./configs";
import { BLANK, countOn, parseOps, runMachine, type MachineStep } from "./machine";
import { END_HOLD, applyDefs, autoPace, compileDefs, compileReadouts, drawNote, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { MONO_FONT } from "./ui";

const symText = (s: string) => (s === BLANK ? "none" : s === "*" ? "any" : s);

function fit(ctx: CanvasRenderingContext2D, s: string, w: number) {
  let t = s;
  while (t.length > 2 && textWidth(ctx, t, MONO_FONT) > w) t = `${t.slice(0, -2)}…`;
  return t;
}

export default function StateMachine({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<StateMachineConfig>) {
  const c = useMemo(() => ({ defs: compileDefs(config.defs), speed: opt(config.speed), readouts: compileReadouts(config.readouts) }), [config]);
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env = applyDefs(paramEnv(params), c.defs);
    const setup = machineSetup(config, env);
    const steps = runMachine(setup);
    const finals = Object.fromEntries(Object.entries({ ...steps[steps.length - 1].vars, steps: steps.length }).map(([k, v]) => [`final_${k}`, v]));
    // A fixed tape window when everything visited fits (so the tape doesn't jump).
    const idx = steps.flatMap((s) => [s.head, ...Object.keys(s.tape).map(Number)]);
    const lo = Math.min(0, ...idx);
    const hi = Math.max(setup.input.length - 1, ...idx);
    const states: string[] = [];
    for (const t of setup.transitions) for (const s of [t.from, t.to]) if (!states.includes(s)) states.push(s);
    return { env, setup, steps, finals, lo, hi, states };
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
        setReadouts(
          readoutValues(c.readouts, {
            ...run.env,
            ...run.finals,
            ...st.vars,
            step: k,
            steps: steps.length,
            done: k === steps.length - 1 ? 1 : 0,
            cell: (i) => st.tape[Math.round(Number(i))] ?? BLANK,
            count: (s) => countOn(st.tape, String(s)),
          }),
        );
        if (width < 80 || height < 80) return;
        const m = 14;
        const noteH = 40;

        // Tape.
        const maxCells = Math.max(5, Math.floor((width - 2 * m) / 26));
        const dfa = config.kind === "dfa";
        let a = dfa ? 0 : run.lo - 1;
        let b = dfa ? Math.max(0, run.setup.input.length) : run.hi + 1;
        if (b - a + 1 > maxCells) {
          a = Math.round(st.head - maxCells / 2);
          b = a + maxCells - 1;
        }
        const pos = Array.from({ length: b - a + 1 }, (_, i) => a + i);
        const vals = pos.map((p) => {
          const s = st.tape[p] ?? BLANK;
          return s === BLANK ? "" : s;
        });
        const tapeBox = { left: m, top: 10, width: width - 2 * m, height: 56 };
        const row = draw.cells(ctx, vals, tapeBox, {
          indices: pos.map(String),
          maxCell: 34,
          style: (i) => (pos[i] === st.head && !(dfa && st.halted) ? "active" : dfa && pos[i] < st.head ? "muted" : "normal"),
        });
        const hx = pos.indexOf(st.head);
        const headX = hx >= 0 ? row.x(hx) : st.head < a ? row.left - 6 : row.left + row.width + 6;
        draw.pointer(ctx, headX, row.top + row.height + 16, `${st.state}${st.halted ? (dfa ? (st.vars.accepted ? " ✓" : " ✗") : " halt") : ""}`, { color: st.halted ? theme.accent2 : theme.accent });

        const top = row.top + row.height + 54;
        const bottom = height - noteH;
        if (dfa) drawGraph(ctx, run.states, config.accept ?? [], config.start, run.setup.transitions, st, { left: m, top, width: width - 2 * m, height: bottom - top });
        else drawTable(ctx, run.setup.transitions, st, { left: m, top, width: width - 2 * m, height: bottom - top });
        drawNote(ctx, `${k}/${steps.length - 1} · ${st.msg}`, width, height - noteH + 12);
      }}
    />
  );
}

type Box = { left: number; top: number; width: number; height: number };

function drawTable(ctx: CanvasRenderingContext2D, rows: StateMachineConfig["transitions"], st: MachineStep, box: Box) {
  const rh = 19;
  const fit1 = Math.floor((box.height - rh) / rh);
  if (fit1 < 1) return;
  const w = Math.min(box.width, 440);
  const x0 = box.left + (box.width - w) / 2;
  const cols = [0.22, 0.18, 0.38, 0.22].map((f) => f * w);
  const head = ["m-config", "symbol", "operations", "final m-config"];
  const cx = (i: number) => x0 + cols.slice(0, i).reduce((s, v) => s + v, 0);
  head.forEach((h, i) => draw.text(ctx, h, cx(i) + 6, box.top + rh / 2, { size: 10, color: theme.faint }));
  draw.line(ctx, x0, box.top + rh, x0 + w, box.top + rh, { color: theme.line, width: 1 });
  const active = st.row;
  let first = 0;
  if (rows.length > fit1) first = Math.max(0, Math.min(rows.length - fit1, (active >= 0 ? active : Math.max(0, st.nextRow)) - Math.floor(fit1 / 2)));
  rows.slice(first, first + fit1).forEach((r, j) => {
    const i = first + j;
    const y = box.top + rh * (j + 1);
    const on = i === active;
    const next = i === st.nextRow && !on;
    if (on) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x0, y + 1, w, rh - 2);
      ctx.restore();
      draw.line(ctx, x0, y + 1, x0, y + rh - 1, { color: theme.accent, width: 2.5 });
    }
    const ops = parseOps(r).join(", ") || "—";
    [r.from, symText(r.read), ops, r.to].forEach((v, ci) =>
      draw.text(ctx, fit(ctx, v, cols[ci] - 10), cx(ci) + 6, y + rh / 2, { kind: "mono", size: 11, color: on ? theme.fg : next ? theme.muted : theme.faint }),
    );
  });
}

function drawGraph(ctx: CanvasRenderingContext2D, states: string[], accept: string[], start: string, rows: StateMachineConfig["transitions"], st: MachineStep, box: Box) {
  const n = states.length;
  if (box.height < 50) return;
  ctx.font = MONO_FONT;
  const R = Math.max(17, Math.min(28, Math.max(...states.map((s) => ctx.measureText(s).width)) / 2 + 9));
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2 + 6;
  const line = n <= 4;
  const rad = Math.max(30, Math.min(box.width / 2 - R - 28, box.height / 2 - R - 14));
  const pos = new Map(
    states.map((s, i) => [
      s,
      line
        ? ([box.left + 36 + ((box.width - 72) * (i + 0.5)) / n, cy] as [number, number])
        : ([cx + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), cy + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)] as [number, number]),
    ]),
  );
  const groups = new Map<string, { from: string; to: string; syms: string[]; rows: number[] }>();
  rows.forEach((r, i) => {
    const key = `${r.from}→${r.to}`;
    const g = groups.get(key) ?? { from: r.from, to: r.to, syms: [], rows: [] };
    g.syms.push(symText(r.read));
    g.rows.push(i);
    groups.set(key, g);
  });
  for (const g of groups.values()) {
    const on = g.rows.includes(st.row);
    const color = on ? theme.accent : theme.muted;
    const [x1, y1] = pos.get(g.from)!;
    const [x2, y2] = pos.get(g.to)!;
    const label = g.syms.join(",");
    if (g.from === g.to) {
      ctx.beginPath();
      ctx.arc(x1, y1 - R - 9, 10, 0.75 * Math.PI, 2.25 * Math.PI);
      ctx.strokeStyle = color;
      ctx.lineWidth = on ? 2 : 1.25;
      ctx.stroke();
      draw.arrow(ctx, x1 + 9, y1 - R - 3, x1 + 6, y1 - R + 1, { color, width: on ? 2 : 1.25, head: 5 });
      draw.text(ctx, label, x1, y1 - R - 26, { kind: "mono", align: "center", size: 10, color: on ? theme.fg : theme.muted });
      continue;
    }
    const both = groups.has(`${g.to}→${g.from}`);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const bend = both || (line && Math.abs(states.indexOf(g.to) - states.indexOf(g.from)) > 1) ? 22 : 0;
    const qx = (x1 + x2) / 2 + nx * bend;
    const qy = (y1 + y2) / 2 + ny * bend;
    const sx = x1 + ((qx - x1) / Math.hypot(qx - x1, qy - y1)) * R;
    const sy = y1 + ((qy - y1) / Math.hypot(qx - x1, qy - y1)) * R;
    const ex = x2 + ((qx - x2) / Math.hypot(qx - x2, qy - y2)) * (R + 2);
    const ey = y2 + ((qy - y2) / Math.hypot(qx - x2, qy - y2)) * (R + 2);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(qx, qy, ex, ey);
    ctx.strokeStyle = color;
    ctx.lineWidth = on ? 2 : 1.25;
    ctx.stroke();
    const tx = ex - qx;
    const ty = ey - qy;
    const tl = Math.hypot(tx, ty) || 1;
    draw.arrow(ctx, ex - (tx / tl) * 6, ey - (ty / tl) * 6, ex, ey, { color, width: on ? 2 : 1.25, head: 6 });
    draw.text(ctx, label, qx + nx * 8 * (bend ? 1 : 0.8), qy + ny * 8 * (bend ? 1 : 0.8) - (bend ? 0 : 4), { kind: "mono", align: "center", size: 10, color: on ? theme.fg : theme.muted });
  }
  for (const s of states) {
    const [x, y] = pos.get(s)!;
    const cur = s === st.state;
    const color = cur ? (st.halted ? theme.accent2 : theme.accent) : theme.muted;
    draw.circle(ctx, x, y, R, { color, width: cur ? 2.25 : 1.25, fill: theme.bg });
    if (accept.includes(s)) draw.circle(ctx, x, y, R - 4, { color, width: 1, fill: null });
    draw.text(ctx, s, x, y, { kind: "mono", align: "center", size: 11, color: cur ? theme.fg : theme.muted });
    if (s === start) draw.arrow(ctx, x - R - 20, y + (line ? 0 : 0), x - R - 2, y, { color: theme.faint, width: 1.25, head: 5 });
  }
}
