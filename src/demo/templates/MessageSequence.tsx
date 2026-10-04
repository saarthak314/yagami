// message-sequence: nodes exchanging messages over rounds, drawn as a sequence diagram (one lifeline per
// node, time running down), with each node's state under its name and logs/chains in a panel below.
// Paxos, Raft and block flooding apply the real rules to every delivered message (see protocol.ts).

import { useMemo, useRef } from "react";
import { draw, theme } from "../kit";
import { Stage } from "./stage";
import { seqSetup, type MessageSequenceConfig } from "./configs";
import { runProtocol, type SeqStep } from "./protocol";
import type { Value } from "./expr";
import { END_HOLD, applyDefs, autoPace, compileDefs, compileReadouts, drawNote, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT, MONO_FONT } from "./ui";

const roleColor = (role: string, up: boolean) => (!up ? theme.faint : role === "leader" ? theme.accent : role === "candidate" ? theme.accent2 : role === "proposer" ? theme.accent2 : theme.muted);

function fit(ctx: CanvasRenderingContext2D, s: string, w: number, font = MONO_FONT) {
  let t = s;
  while (t.length > 2 && textWidth(ctx, t, font) > w) t = `${t.slice(0, -2)}…`;
  return t;
}

export default function MessageSequence({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<MessageSequenceConfig>) {
  const c = useMemo(() => ({ defs: compileDefs(config.defs), speed: opt(config.speed), readouts: compileReadouts(config.readouts) }), [config]);
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env = applyDefs(paramEnv(params), c.defs);
    const steps = runProtocol(seqSetup(config, env));
    const last = steps[steps.length - 1];
    const finals = Object.fromEntries(Object.entries({ ...last.vars, steps: steps.length }).map(([k, v]) => [`final_${k}`, v]));
    return { env, steps, finals };
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
        const nodes = config.nodes;
        const N = nodes.length;
        const st0 = (node: unknown, key: unknown): Value => st.state[String(node)]?.[String(key)] ?? NaN;
        setReadouts(readoutValues(c.readouts, { ...run.env, ...run.finals, ...st.vars, step: k, steps: steps.length, done: k === steps.length - 1 ? 1 : 0, st: st0 }));
        if (width < 80 || height < 80) return;

        const m = 14;
        const colW = (width - 2 * m) / N;
        const xOf = (n: string) => m + colW * (nodes.indexOf(n) + 0.5);
        const proto = config.protocol;
        const hasPanel = proto === "raft" || proto === "flood";
        const noteH = 38;
        const panelRow = hasPanel ? Math.max(13, Math.min(22, (height * 0.3) / N)) : 0;
        const panelH = hasPanel ? panelRow * N + 8 : 0;
        const showLines = height >= 300;
        const seqTop = showLines ? 70 : 38;
        const panelTop = height - noteH - panelH;
        const seqBottom = panelTop - (hasPanel ? 10 : 4);
        const R = Math.max(2, Math.min(8, Math.floor((seqBottom - seqTop) / 30)));
        const rowH = Math.max(12, (seqBottom - seqTop) / R);
        const first = Math.max(1, k - R + 1);

        // Headers: name, role colour, state lines.
        nodes.forEach((n) => {
          const v = st.nodes[n];
          const x = xOf(n);
          draw.chip(ctx, fit(ctx, n, colW - 18, LABEL_FONT), x, 16, { active: v.role === "leader" && v.up, color: roleColor(v.role, v.up), size: 11 });
          if (showLines) {
            const lines = v.up ? v.lines : ["crashed", ...v.lines.slice(0, 1)];
            lines.slice(0, 2).forEach((l, i) => draw.text(ctx, fit(ctx, l, colW - 6), x, 38 + i * 13, { kind: "mono", align: "center", size: 10, color: v.up ? theme.muted : theme.faint }));
          }
        });

        // Lifelines (dashed where the node is down), then the visible rounds.
        const yTop = (j: number) => seqTop + (j - first) * rowH;
        for (const n of nodes) {
          const x = xOf(n);
          for (let j = first; j <= Math.max(first, k); j++) {
            const down = !steps[j].nodes[n].up;
            draw.line(ctx, x, yTop(j), x, yTop(j) + rowH, { color: down ? theme.faint : theme.line, width: 1, dash: down ? [3, 4] : undefined });
          }
        }
        for (let j = first; j <= k; j++) {
          const s: SeqStep = steps[j];
          const cur = j === k;
          const y1 = yTop(j) + 3;
          const y2 = yTop(j) + rowH - 3;
          const fanOut = new Set(s.msgs.map((mm) => mm.from)).size < s.msgs.length;
          for (const mm of s.msgs) {
            const x1 = xOf(mm.from);
            const x2 = xOf(mm.to);
            const color = cur ? (mm.ok ? theme.accent : theme.accent2) : mm.ok ? theme.muted : theme.faint;
            const alpha = cur ? 1 : j === k - 1 ? 0.8 : 0.5;
            if (mm.from === mm.to) {
              draw.polyline(ctx, [[x1, y1], [x1 + 14, y1], [x1 + 14, y2]], { color, width: 1.25, alpha });
              draw.arrow(ctx, x1 + 14, y2, x1 + 2, y2, { color, width: 1.25, head: 5, alpha });
            } else if (mm.lost) {
              const xm = x1 + (x2 - x1) * 0.55;
              const ym = y1 + (y2 - y1) * 0.55;
              draw.line(ctx, x1, y1, xm, ym, { color, width: 1.25, dash: [4, 3], alpha });
              draw.text(ctx, "✕", xm, ym, { align: "center", color: cur ? theme.accent2 : theme.faint, size: 12 });
            } else draw.arrow(ctx, x1, y1, x2, y2, { color, width: cur ? 1.6 : 1.1, head: 6, alpha });
            if (mm.from !== mm.to) {
              // Anchor the label at the end the round's arrows don't share (receivers of a broadcast,
              // senders of replies), extending toward the other end, so neighbouring labels sit side by side.
              const text = fit(ctx, mm.label, Math.max(40, colW - 2));
              const w = textWidth(ctx, text, MONO_FONT.replace("11px", "10px")) + 6;
              const atTo = fanOut;
              const ax = atTo ? x2 : x1;
              const dir = Math.sign((atTo ? x1 : x2) - ax);
              const span = Math.abs(x2 - x1);
              let lx = w + 8 < span ? ax + dir * (w / 2 + 6) : (x1 + x2) / 2;
              if (mm.lost) lx = x1 + (x2 - x1) * 0.3;
              const tt = span ? (lx - x1) / (x2 - x1) : 0.5;
              const ly = y1 + (y2 - y1) * tt - 7;
              draw.text(ctx, text, lx, ly, { kind: "mono", align: "center", size: 10, color: cur ? theme.fg : j >= k - 2 ? theme.muted : theme.faint });
            }
          }
          for (const [n, mark] of Object.entries(s.marks)) {
            if (!nodes.includes(n)) continue;
            draw.text(ctx, fit(ctx, mark, colW - 10, LABEL_FONT), xOf(n) + 5, yTop(j) + rowH / 2, { size: 10, color: cur ? theme.accent2 : theme.faint });
          }
        }
        if (k === 0) draw.text(ctx, "press play: rounds run downward", width / 2, (seqTop + seqBottom) / 2, { align: "center", color: theme.faint });

        // Logs (raft) or chains (flood).
        if (hasPanel) {
          const left = m + 34;
          const maxLen = Math.max(4, ...nodes.map((n) => (proto === "raft" ? (st.nodes[n].log?.length ?? 0) : (st.nodes[n].chain?.length ?? 0))));
          const cw = Math.max(14, Math.min(proto === "raft" ? 28 : 46, (width - left - m) / maxLen));
          const ch = panelRow - 3;
          nodes.forEach((n, r) => {
            const v = st.nodes[n];
            const y = panelTop + r * panelRow;
            draw.text(ctx, n, m, y + ch / 2, { kind: "mono", size: 10, color: v.up ? theme.muted : theme.faint });
            if (proto === "raft") {
              (v.log ?? []).forEach((e, i) => {
                const committed = i < (v.commit ?? 0);
                const x = left + i * cw;
                if (committed) {
                  ctx.save();
                  ctx.globalAlpha = 0.18;
                  ctx.fillStyle = theme.accent;
                  ctx.fillRect(x + 1, y + 1, cw - 2, ch - 1);
                  ctx.restore();
                }
                draw.rect(ctx, x + 1, y + 1, cw - 2, ch - 1, { color: committed ? theme.accent : theme.line, width: 1 });
                const label = e.cmd && cw >= 26 ? `${e.term}${e.cmd.slice(0, 2)}` : String(e.term);
                draw.text(ctx, label, x + cw / 2, y + ch / 2 + 0.5, { kind: "mono", align: "center", size: Math.min(10, Math.floor(ch * 0.6)), color: v.up ? theme.fg : theme.faint });
              });
              if (!(v.log ?? []).length) draw.text(ctx, "empty", left, y + ch / 2, { size: 10, color: theme.faint });
            } else {
              (v.chain ?? []).forEach((b, i) => {
                const x = left + i * cw;
                draw.rect(ctx, x + 2, y + 1, cw - 8, ch - 1, { color: i === (v.chain?.length ?? 0) - 1 ? theme.accent : theme.line, width: 1 });
                draw.text(ctx, fit(ctx, b, cw - 10), x + 2 + (cw - 8) / 2, y + ch / 2 + 0.5, { kind: "mono", align: "center", size: Math.min(10, Math.floor(ch * 0.6)), color: theme.fg });
                if (i > 0) draw.line(ctx, x - 6, y + ch / 2, x + 2, y + ch / 2, { color: theme.faint, width: 1 });
              });
              if (!(v.chain ?? []).length) draw.text(ctx, "no blocks", left, y + ch / 2, { size: 10, color: theme.faint });
            }
          });
        }

        drawNote(ctx, `${k}/${steps.length - 1} · ${st.note}`, width, height - noteH + 10);
      }}
    />
  );
}
