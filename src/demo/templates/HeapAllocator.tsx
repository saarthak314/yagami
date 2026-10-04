// heap-allocator: a malloc-style allocator over a request trace. Blocks are drawn to scale along the heap;
// the fit policy (first/next/best), the free list (implicit/explicit, LIFO/address order), splitting and
// coalescing are simulated step by step. With `compare`, several policies run the same trace side by side.

import { useMemo, useRef } from "react";
import { draw, rng, theme } from "../kit";
import { Stage } from "./stage";
import { compile, compileField, type Compiled, type Env, type Value } from "./expr";
import type { FitPolicy, HeapAllocatorConfig, HeapRequest } from "./configs";
import { applyDefs, compileDefs, compileReadouts, fmtTick, niceTicks, opt, paramEnv, randomFns, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

interface Block {
  addr: number;
  size: number;
  alloc: boolean;
  id?: string;
  payload: number;
}
interface Snap {
  blocks: Block[];
  heap: number;
  rover: number;
  list: number[]; // explicit free list: block addresses in list order
}
interface HStep {
  snap: Snap;
  hot: number; // address being examined (−1 none)
  chosen: number; // address placed in / freed (−1 none)
  line: number;
  code: "malloc" | "free" | "none";
  msg: string;
  request: number;
  vars: Record<string, number>;
}
interface Opts {
  heap: number;
  max: number;
  align: number;
  header: number;
  footer: number;
  policy: FitPolicy;
  explicit: boolean;
  lifo: boolean;
  coalesce: boolean;
  split: boolean;
}
type Req = { op: "malloc"; size: number; id: string } | { op: "free"; id: string };

const MAX_STEPS = 1500;
const POLICY_CODE: Record<FitPolicy, string[]> = {
  first: ["asize = align(size + overhead)", "for (p = start; p != end; p = next(p))", "  if (free(p) && size(p) >= asize)", "    place(p, asize); return", "extend heap; place at the end"],
  next: ["asize = align(size + overhead)", "for (p = rover; …wraps…; p = next(p))", "  if (free(p) && size(p) >= asize)", "    place(p, asize); rover = p; return", "extend heap; place at the end"],
  best: ["asize = align(size + overhead)", "for (each block p)", "  if (free(p) && size(p) >= asize && smaller)", "    best = p", "place(best) or extend heap"],
};
const FREE_CODE = ["mark the block free", "coalesce with free neighbours", "insert into the free list"];

const alignUp = (x: number, a: number) => Math.ceil(x / a) * a;
const asPolicy = (v: Value): FitPolicy => {
  if (typeof v === "string" && (v === "first" || v === "next" || v === "best")) return v;
  const n = Math.round(Number(v));
  return n === 1 ? "next" : n === 2 ? "best" : "first";
};
const truthy = (v: number, dflt: boolean) => (Number.isFinite(v) ? v !== 0 : dflt);

/** Run one policy over the trace; every examined block, placement and free is a step. */
function simulate(trace: Req[], o: Opts, fine: boolean) {
  const minBlock = alignUp(o.header + o.footer + o.align, o.align);
  const s: Snap = { blocks: [{ addr: 0, size: o.heap, alloc: false, payload: 0 }], heap: o.heap, rover: 0, list: [0] };
  const steps: HStep[] = [];
  const perRequest: HStep[] = [];
  const v = { request: 0, requests: trace.length, examined: 0, last: 0, heap: o.heap, live: 0, peak: 0, util: 0, internal: 0, freeBlocks: 1, largestFree: o.heap, failed: 0 };
  const clone = (): Snap => ({ blocks: s.blocks.map((b) => ({ ...b })), heap: s.heap, rover: s.rover, list: [...s.list] });
  const update = () => {
    v.heap = s.heap;
    v.live = s.blocks.reduce((a, b) => a + (b.alloc ? b.payload : 0), 0);
    v.peak = Math.max(v.peak, v.live);
    v.util = s.heap > 0 ? v.peak / s.heap : 0;
    v.internal = s.blocks.reduce((a, b) => a + (b.alloc ? b.size - b.payload : 0), 0);
    const free = s.blocks.filter((b) => !b.alloc);
    v.freeBlocks = free.length;
    v.largestFree = free.reduce((a, b) => Math.max(a, b.size), 0);
  };
  const push = (code: HStep["code"], line: number, msg: string, hot = -1, chosen = -1, always = false) => {
    if (!fine && !always) return;
    if (steps.length >= MAX_STEPS) return;
    update();
    steps.push({ snap: clone(), hot, chosen, line, code, msg, request: v.request, vars: { ...v } });
  };
  const idx = (addr: number) => s.blocks.findIndex((b) => b.addr === addr);
  const listRemove = (addr: number) => {
    const i = s.list.indexOf(addr);
    if (i >= 0) s.list.splice(i, 1);
  };
  const listInsert = (addr: number) => {
    if (s.list.includes(addr)) return;
    if (o.lifo) s.list.unshift(addr);
    else {
      const i = s.list.findIndex((a) => a > addr);
      if (i < 0) s.list.push(addr);
      else s.list.splice(i, 0, addr);
    }
  };

  push("none", -1, `heap of ${o.heap} bytes · ${o.policy} fit · ${o.explicit ? `explicit ${o.lifo ? "LIFO" : "address-ordered"} list` : "implicit list"}`, -1, -1, true);
  perRequest.push(steps[steps.length - 1]);

  trace.forEach((r, ri) => {
    v.request = ri + 1;
    if (r.op === "malloc") {
      const asize = alignUp(Math.max(1, r.size) + o.header + o.footer, o.align);
      v.last = 0;
      push("malloc", 0, `malloc(${r.size}) → block of ${asize} bytes`);
      // Search order: every block (implicit) or the free list (explicit); next fit starts at the rover.
      let order: number[] = o.explicit ? [...s.list] : s.blocks.map((b) => b.addr);
      if (o.policy === "next") {
        const at = order.indexOf(s.rover);
        const start = at >= 0 ? at : Math.max(0, order.findIndex((a) => a >= s.rover));
        order = [...order.slice(start), ...order.slice(0, start)];
      }
      let pick = -1;
      for (const addr of order) {
        const b = s.blocks[idx(addr)];
        if (!b) continue;
        v.examined++;
        v.last++;
        const fits = !b.alloc && b.size >= asize;
        if (o.policy === "best") {
          const better = fits && (pick < 0 || b.size < s.blocks[idx(pick)].size);
          if (better) pick = addr;
          push("malloc", better ? 3 : 2, `@${addr}: ${b.alloc ? "allocated" : `free ${b.size}`}${b.alloc ? "" : fits ? (better ? " — best so far" : " — fits, not smaller") : " — too small"}`, addr);
          if (fits && b.size === asize) break; // exact fit: nothing can be better
        } else {
          push("malloc", fits ? 3 : 2, `@${addr}: ${b.alloc ? "allocated, skip" : fits ? `free ${b.size} ≥ ${asize}: fits` : `free ${b.size} < ${asize}: too small`}`, addr);
          if (fits) {
            pick = addr;
            break;
          }
        }
      }
      if (pick < 0) {
        // Extend the heap: grow a trailing free block, or add a new one.
        const last = s.blocks[s.blocks.length - 1];
        const grow = last && !last.alloc && o.coalesce ? asize - last.size : asize;
        if (s.heap + grow > o.max) {
          v.failed++;
          push("malloc", 4, `no fit and the heap can't grow past ${o.max}: malloc(${r.size}) fails`, -1, -1, true);
          perRequest.push(steps[steps.length - 1]);
          return;
        }
        if (last && !last.alloc && o.coalesce) {
          last.size += grow;
          pick = last.addr;
        } else {
          s.blocks.push({ addr: s.heap, size: asize, alloc: false, payload: 0 });
          listInsert(s.heap);
          pick = s.heap;
        }
        s.heap += grow;
        push("malloc", 4, `no fit: extend the heap by ${grow} to ${s.heap}`, pick);
      }
      const b = s.blocks[idx(pick)];
      const rest = b.size - asize;
      if (o.split && rest >= minBlock) {
        b.size = asize;
        const rem = { addr: b.addr + asize, size: rest, alloc: false, payload: 0 };
        s.blocks.splice(idx(b.addr) + 1, 0, rem);
        const li = s.list.indexOf(b.addr);
        if (li >= 0) s.list[li] = rem.addr;
        else listInsert(rem.addr);
      } else listRemove(b.addr);
      b.alloc = true;
      b.id = r.id;
      b.payload = Math.max(1, r.size);
      s.rover = o.policy === "next" ? (o.split && rest >= minBlock ? b.addr + asize : b.addr) : s.rover;
      push("malloc", 3, `${r.id} = malloc(${r.size}) at @${b.addr}${o.split && rest >= minBlock ? `, split off ${rest}` : rest > 0 ? `, ${rest} bytes of padding` : ""} · examined ${v.last}`, -1, b.addr, true);
      perRequest.push(steps[steps.length - 1]);
    } else {
      const i = s.blocks.findIndex((b) => b.alloc && b.id === r.id);
      if (i < 0) {
        push("free", 0, `free(${r.id}): not allocated`, -1, -1, true);
        perRequest.push(steps[steps.length - 1]);
        return;
      }
      const b = s.blocks[i];
      b.alloc = false;
      b.payload = 0;
      b.id = undefined;
      push("free", 0, `free(${r.id}) at @${b.addr}`, -1, b.addr);
      let cur = b;
      if (o.coalesce) {
        const nx = s.blocks[idx(cur.addr) + 1];
        if (nx && !nx.alloc) {
          cur.size += nx.size;
          listRemove(nx.addr);
          s.blocks.splice(idx(nx.addr), 1);
          if (s.rover === nx.addr) s.rover = cur.addr;
          push("free", 1, `coalesce with the next block → ${cur.size}`, -1, cur.addr);
        }
        const pv = s.blocks[idx(cur.addr) - 1];
        if (pv && !pv.alloc) {
          pv.size += cur.size;
          listRemove(cur.addr);
          s.blocks.splice(idx(cur.addr), 1);
          if (s.rover === cur.addr) s.rover = pv.addr;
          cur = pv;
          push("free", 1, `coalesce with the previous block → ${cur.size}`, -1, cur.addr);
        }
      }
      if (o.explicit) {
        listRemove(cur.addr);
        listInsert(cur.addr);
      } else listInsert(cur.addr);
      push("free", 2, o.explicit ? `insert @${cur.addr} ${o.lifo ? "at the front (LIFO)" : "in address order"}` : `block @${cur.addr} is free again`, -1, cur.addr, true);
      perRequest.push(steps[steps.length - 1]);
    }
  });
  update();
  const finals = { total_examined: v.examined, final_heap: s.heap, final_util: s.heap > 0 ? v.peak / s.heap : 0, final_peak: v.peak, total_failed: v.failed };
  const last = steps[steps.length - 1];
  steps.push({ ...last, hot: -1, chosen: -1, line: -1, code: "none", msg: `done: ${trace.length} requests · examined ${v.examined} blocks · utilization ${(finals.final_util * 100).toFixed(0)}%`, vars: { ...last.vars, ...v } });
  perRequest.push(steps[steps.length - 1]);
  return { steps, perRequest, finals };
}

export default function HeapAllocator({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<HeapAllocatorConfig>) {
  const c = useMemo(() => {
    const field = (v: unknown) => (v === undefined ? undefined : compileField(v));
    const genTrace = !Array.isArray(config.trace) ? config.trace : null;
    return {
      defs: compileDefs(config.defs),
      heap: opt(config.heap),
      max: opt(config.max),
      align: opt(config.align),
      header: opt(config.header),
      footer: opt(config.footer),
      policy: field(config.policy),
      list: field(config.list),
      insert: field(config.insert),
      coalesce: opt(config.coalesce),
      split: opt(config.split),
      speed: opt(config.speed),
      trace: Array.isArray(config.trace) ? (config.trace as HeapRequest[]).map((r) => (r.op === "malloc" ? { op: r.op, size: compileField(r.size), id: r.id } : { op: r.op, id: r.id })) : null,
      gen: genTrace ? { requests: compileField(genTrace.requests), size: compile(genTrace.size), free: genTrace.free !== undefined ? compileField(genTrace.free) : undefined, seed: genTrace.seed ?? 1 } : null,
      readouts: compileReadouts(config.readouts),
    };
  }, [config]);

  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env: Env = applyDefs(paramEnv(params), c.defs);
    const num = (f: Compiled | number | undefined, d: number, lo: number, hi: number) => {
      const x = f === undefined ? d : val(f, env);
      return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : d)));
    };
    const str = (f: Compiled | number | undefined): Value | undefined => (f === undefined ? undefined : typeof f === "number" ? f : (() => { try { return f(env); } catch { return undefined; } })());
    const align = Math.max(1, num(c.align, 8, 1, 64));
    const heap = alignUp(num(c.heap, 128, 16, 1 << 20), align);
    const base = {
      heap,
      max: Math.max(heap, num(c.max, heap * 8, heap, 1 << 22)),
      align,
      header: num(c.header, 8, 0, 64),
      footer: num(c.footer, 0, 0, 64),
      explicit: str(c.list) === "explicit" || Number(str(c.list)) === 1,
      lifo: str(c.insert) !== "address" && Number(str(c.insert)) !== 1,
      coalesce: truthy(c.coalesce === undefined ? 1 : val(c.coalesce, env), true),
      split: truthy(c.split === undefined ? 1 : val(c.split, env), true),
    };

    // The trace: given, or generated from a seeded random workload (shared by every policy).
    let trace: Req[] = [];
    if (c.trace) {
      let auto = 0;
      trace = c.trace.map((r) => (r.op === "malloc" ? { op: "malloc" as const, size: num(r.size, 8, 1, base.max), id: r.id ?? String.fromCharCode(97 + (auto++ % 26)) } : { op: "free" as const, id: r.id! }));
    } else if (c.gen) {
      const next = rng(c.gen.seed);
      const fns = randomFns(next);
      const n = num(c.gen.requests, 20, 1, 200);
      const pFree = c.gen.free !== undefined ? Math.max(0, Math.min(0.95, val(c.gen.free, env))) : 0.4;
      const live: string[] = [];
      for (let i = 0; i < n; i++) {
        if (live.length && next() < pFree) {
          const j = Math.floor(next() * live.length);
          trace.push({ op: "free", id: live[j] });
          live.splice(j, 1);
        } else {
          const sz = val(c.gen.size, { ...env, ...fns });
          const id = `r${i}`;
          trace.push({ op: "malloc", size: Math.round(Math.max(1, Math.min(base.max / 2, Number.isFinite(sz) ? sz : 8))), id });
          live.push(id);
        }
      }
    }
    const policies: FitPolicy[] = config.compare?.length ? config.compare : [asPolicy(str(c.policy) ?? "first")];
    const compare = !!config.compare?.length;
    const runs = policies.map((p) => ({ policy: p, ...simulate(trace, { ...base, policy: p }, !compare) }));
    const scaleMax = Math.max(...runs.flatMap((r) => r.steps.map((s) => s.snap.heap)));
    return { env, trace, policies, compare, runs, scaleMax, base };
  }, [c, paramsKey, config.compare]); // params enter through paramsKey
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
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 1 : run.compare ? 1 : 2);
        const count = run.compare ? run.runs[0].perRequest.length : run.runs[0].steps.length;
        const k = stepIndex(clk.t, count, speed);
        const cur = run.runs.map((r) => (run.compare ? r.perRequest[Math.min(k, r.perRequest.length - 1)] : r.steps[Math.min(k, r.steps.length - 1)]));

        const m = 22;
        const showCode = !run.compare && config.code !== false && height >= 360 && cur[0].code !== "none";
        const codeLines = showCode ? (cur[0].code === "free" ? FREE_CODE : POLICY_CODE[run.policies[0]]) : [];
        const codeH = showCode ? codeLines.length * 16 + 12 : 0;
        const chartH = config.chart ? Math.min(130, Math.max(80, height * 0.28)) : 0;
        const msgY = height - m - codeH - 8;
        const labelW = run.compare ? Math.max(...run.policies.map((p) => textWidth(ctx, `${p} fit`, LABEL_FONT))) + 14 : 0;
        const bandLeft = m + labelW;
        const bandW = width - m - bandLeft;
        const px = (addr: number) => bandLeft + (addr / Math.max(1, run.scaleMax)) * bandW;
        const bandsTop = m + 22;
        const bandsBottom = msgY - 24 - chartH - (chartH ? 12 : 0);
        const bandSpace = Math.max(40, bandsBottom - bandsTop);
        const bandH = Math.min(run.compare ? 42 : 56, (bandSpace - (run.compare ? (run.runs.length - 1) * 40 : 0)) / run.runs.length);

        run.runs.forEach((r, ri) => {
          const st = cur[ri];
          const top = bandsTop + ri * (bandH + (run.compare ? 40 : 0)) + (run.base.explicit ? 18 : 0);
          if (run.compare) {
            draw.text(ctx, `${r.policy} fit`, m, top + bandH / 2, { color: theme.fg });
            draw.text(ctx, `examined ${st.vars.examined} · heap ${st.vars.heap}`, width - m, top - 9, { kind: "mono", align: "right", color: theme.muted });
          }
          // The heap past its current end (room to grow up to the largest heap in the run).
          if (st.snap.heap < run.scaleMax) draw.rect(ctx, px(st.snap.heap) + 0.5, top + 0.5, px(run.scaleMax) - px(st.snap.heap) - 1, bandH - 1, { color: theme.grid, width: 1, dash: [3, 4] });
          for (const b of st.snap.blocks) {
            const x = px(b.addr);
            const w = Math.max(1, px(b.addr + b.size) - x);
            const hot = st.hot === b.addr;
            const chosen = st.chosen === b.addr;
            if (b.alloc) {
              ctx.save();
              ctx.globalAlpha = 0.28;
              ctx.fillStyle = chosen ? theme.accent : theme.muted;
              ctx.fillRect(x, top, w, bandH);
              ctx.restore();
              // Header (and footer) overhead as darker slivers.
              const hw = (run.base.header / Math.max(1, run.scaleMax)) * bandW;
              if (hw >= 1) {
                ctx.save();
                ctx.globalAlpha = 0.5;
                ctx.fillStyle = theme.faint;
                ctx.fillRect(x, top, Math.min(w, hw), bandH);
                const fw = (run.base.footer / Math.max(1, run.scaleMax)) * bandW;
                if (fw >= 1) ctx.fillRect(x + w - Math.min(w, fw), top, Math.min(w, fw), bandH);
                ctx.restore();
              }
            } else if (chosen) {
              ctx.save();
              ctx.globalAlpha = 0.14;
              ctx.fillStyle = theme.accent;
              ctx.fillRect(x, top, w, bandH);
              ctx.restore();
            }
            draw.rect(ctx, x + 0.5, top + 0.5, Math.max(0, w - 1), bandH - 1, { color: hot || chosen ? theme.accent : b.alloc ? theme.line : theme.muted, width: hot ? 2 : chosen ? 1.5 : 1 });
            const label = b.alloc ? `${b.id ?? ""}${b.id ? " " : ""}${b.size}` : `${b.size}`;
            if (textWidth(ctx, label) + 8 < w) draw.text(ctx, label, x + w / 2, top + bandH / 2, { kind: "mono", align: "center", color: b.alloc ? theme.fg : theme.muted });
            else if (textWidth(ctx, `${b.size}`) + 6 < w) draw.text(ctx, `${b.size}`, x + w / 2, top + bandH / 2, { kind: "mono", align: "center", color: b.alloc ? theme.fg : theme.muted });
          }
          // Explicit free list: arcs above the band in list order.
          if (run.base.explicit && st.snap.list.length) {
            const centers = st.snap.list.map((a) => {
              const b = st.snap.blocks.find((x) => x.addr === a);
              return b ? px(b.addr) + (px(b.addr + b.size) - px(b.addr)) / 2 : NaN;
            }).filter(Number.isFinite);
            for (let i = 0; i + 1 < centers.length; i++) {
              const [x1, x2] = [centers[i], centers[i + 1]];
              const h = Math.min(16, 6 + Math.abs(x2 - x1) * 0.08);
              const pts: [number, number][] = [];
              for (let q = 0; q <= 16; q++) {
                const u = q / 16;
                pts.push([x1 + (x2 - x1) * u, top - 2 - h * 4 * u * (1 - u)]);
              }
              draw.polyline(ctx, pts, { color: theme.accent2, width: 1.25 });
              draw.dot(ctx, x2, top - 2, 2, theme.accent2);
            }
            if (centers.length) draw.text(ctx, "free list →", Math.max(bandLeft, Math.min(centers[0] - 4, width - m - 60)), top - 26 < m ? m : top - 24, { color: theme.accent2, align: centers[0] - 70 > bandLeft ? "right" : "left" });
          }
          // Next fit's rover.
          if (r.policy === "next" && !run.compare) draw.pointer(ctx, px(st.snap.rover) + 3, top + bandH + 2, "rover", { color: theme.accent2, length: 14 });
        });

        // Address axis under the last band.
        const lastTop = bandsTop + (run.runs.length - 1) * (bandH + (run.compare ? 40 : 0)) + (run.base.explicit ? 18 : 0);
        const axisY = lastTop + bandH + (run.runs.some((r) => r.policy === "next") && !run.compare ? 34 : 10);
        const ticks = niceTicks(0, run.scaleMax, Math.max(2, Math.floor(bandW / 80)));
        for (const t of ticks) draw.text(ctx, fmtTick(t, ticks), px(t), axisY, { kind: "mono", align: t === 0 ? "left" : t >= run.scaleMax * 0.98 ? "right" : "center", color: theme.faint });

        // Chart of a metric over requests (one series per policy).
        if (config.chart) {
          const metric = config.chart === "examined" ? "examined" : config.chart === "heap" ? "heap" : "util";
          const box = { left: bandLeft, top: msgY - 20 - chartH, width: bandW, height: chartH - 16 };
          const series = run.runs.map((r) => r.perRequest.map((s) => s.vars[metric]));
          const hi = Math.max(1e-9, ...series.flat().filter(Number.isFinite));
          const reqN = Math.max(1, run.runs[0].perRequest.length - 1);
          const sx = (i: number) => box.left + (i / reqN) * box.width;
          const sy = (y: number) => box.top + box.height - (y / hi) * box.height;
          draw.line(ctx, box.left, box.top + box.height, box.left + box.width, box.top + box.height, { color: theme.line, width: 1 });
          const colors = [theme.accent, theme.accent2, theme.fg];
          series.forEach((ys, si) => {
            draw.polyline(ctx, ys.map((y, i) => [sx(i), sy(Number.isFinite(y) ? y : 0)] as [number, number]), { color: colors[si % 3], width: 1.5 });
            const at = run.compare ? k : run.runs[si].steps[Math.min(k, run.runs[si].steps.length - 1)].request;
            const yv = ys[Math.min(at, ys.length - 1)];
            if (Number.isFinite(yv)) draw.dot(ctx, sx(Math.min(at, ys.length - 1)), sy(yv), 3, colors[si % 3]);
          });
          const name = metric === "util" ? "utilization (peak live / heap)" : metric === "heap" ? "heap size (bytes)" : "blocks examined (cumulative)";
          draw.text(ctx, name, box.left, box.top - 4, { color: theme.muted });
          // Which line is which policy.
          if (run.runs.length > 1) {
            let lx = box.left + textWidth(ctx, name, LABEL_FONT) + 16;
            run.runs.forEach((r, si) => {
              draw.line(ctx, lx, box.top - 4, lx + 12, box.top - 4, { color: colors[si % 3], width: 2 });
              draw.text(ctx, r.policy, lx + 16, box.top - 4, { color: theme.muted });
              lx += 28 + textWidth(ctx, r.policy, LABEL_FONT);
            });
          }
          draw.text(ctx, fmtTick(hi, [0, hi]), box.left + box.width, box.top - 4, { kind: "mono", align: "right", color: theme.faint });
        }

        // The step in words, and the search code.
        let msg = run.compare ? `request ${cur[0].request}/${run.trace.length}: ${describe(run.trace[cur[0].request - 1])}` : cur[0].msg;
        if (k >= count - 1) msg = cur[0].msg;
        while (msg.length > 4 && textWidth(ctx, msg, LABEL_FONT.replace("11px", "12px")) > width - 2 * m) msg = `${msg.slice(0, -2)}…`;
        draw.text(ctx, msg, width / 2, msgY, { align: "center", color: theme.fg, size: 12 });
        if (showCode) {
          const w = Math.min(width - 2 * m, Math.max(240, ...codeLines.map((l) => textWidth(ctx, l) + 60)));
          draw.code(ctx, codeLines, (width - w) / 2, msgY + 12, { lang: "pseudo", highlight: cur[0].line >= 0 ? cur[0].line : undefined, lineNumbers: true, width: w, lineHeight: 16 });
        }

        // Readouts: the first policy's variables bare, every policy's with a suffix; finals are constants.
        const vars: Env = { ...run.env, step: k, steps: count, done: k >= count - 1 ? 1 : 0, requests: run.trace.length };
        run.runs.forEach((r, ri) => {
          const vs = { ...cur[ri].vars, ...r.finals };
          for (const [key, x] of Object.entries(vs)) {
            vars[`${key}_${r.policy}`] = x;
            if (ri === 0) vars[key] = x;
          }
        });
        setReadouts(readoutValues(c.readouts, vars));
      }}
    />
  );
}

function describe(r: Req | undefined): string {
  if (!r) return "start";
  return r.op === "malloc" ? `${r.id} = malloc(${r.size})` : `free(${r.id})`;
}
