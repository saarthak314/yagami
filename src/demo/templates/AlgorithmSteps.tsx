// algorithm-steps: classic algorithms stepped through on a small input — array cells with pointers,
// or a small graph — with the code line being executed and counters as readouts.

import { useMemo } from "react";
import { Stage, draw, rng, theme, useSim } from "../kit";
import type { Algorithm, AlgorithmStepsConfig } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

const HOLD = 1.6; // seconds the last step stays up before the run repeats

interface Vars {
  comparisons: number;
  swaps: number;
  done: number;
  found: number;
  lo: number;
  hi: number;
  mid: number;
  i: number;
  j: number;
  visited: number;
  frontier: number;
}
type Style = "normal" | "active" | "muted" | "done";
interface ArrayStep {
  a: number[];
  style: Record<number, Style>;
  pointers: { label: string; at: number; dir: "up" | "down" }[];
  line: number;
  msg: string;
  vars: Vars;
}
interface GraphStep {
  current: string | null;
  visited: string[];
  frontier: string[];
  tree: [string, string][];
  line: number;
  msg: string;
  vars: Vars;
}

const CODE: Record<Algorithm, string[]> = {
  "binary-search": ["lo = 0; hi = n - 1;", "while (lo <= hi) {", "  mid = (lo + hi) / 2;", "  if (a[mid] == x) return mid;", "  if (a[mid] < x) lo = mid + 1;", "  else hi = mid - 1;", "}", "return -1;"],
  "linear-search": ["for (i = 0; i < n; i++)", "  if (a[i] == x) return i;", "return -1;"],
  "insertion-sort": ["for (i = 1; i < n; i++) {", "  key = a[i]; j = i - 1;", "  while (j >= 0 && a[j] > key) {", "    a[j + 1] = a[j]; j--;", "  }", "  a[j + 1] = key;", "}"],
  "bubble-sort": ["for (i = 0; i < n - 1; i++)", "  for (j = 0; j < n - 1 - i; j++)", "    if (a[j] > a[j + 1])", "      swap(a[j], a[j + 1]);"],
  "selection-sort": ["for (i = 0; i < n - 1; i++) {", "  m = i;", "  for (j = i + 1; j < n; j++)", "    if (a[j] < a[m]) m = j;", "  swap(a[i], a[m]);", "}"],
  "merge-sort": ["for (w = 1; w < n; w *= 2)", "  for (lo = 0; lo < n - w; lo += 2 * w)", "    merge(a, lo, lo + w, min(lo + 2 * w, n));"],
  "two-pointers": ["i = 0; j = n - 1;", "while (i < j) {", "  s = a[i] + a[j];", "  if (s == x) return (i, j);", "  if (s < x) i++; else j--;", "}", "return none;"],
  bfs: ["queue = [start]; seen = {start};", "while (queue not empty) {", "  u = queue.popFront();", "  for (v in adj[u])", "    if (v not in seen) {", "      seen.add(v); queue.push(v);", "    }", "}"],
  dfs: ["stack = [start];", "while (stack not empty) {", "  u = stack.pop();", "  if (u in seen) continue;", "  seen.add(u);", "  for (v in adj[u]) stack.push(v);", "}"],
};

const blank = (): Vars => ({ comparisons: 0, swaps: 0, done: 0, found: -1, lo: -1, hi: -1, mid: -1, i: -1, j: -1, visited: 0, frontier: 0 });

function makeArray(spec: AlgorithmStepsConfig["array"], env: Record<string, unknown>, sorted: boolean): number[] {
  if (Array.isArray(spec)) return sorted ? [...spec].sort((a, b) => a - b) : [...spec];
  const n = Math.max(2, Math.min(16, Math.round(val(opt(spec?.n ?? 10), env as never))));
  const next = rng(spec?.seed ?? 3);
  const max = spec?.max ?? 99;
  const out: number[] = [];
  const seen = new Set<number>();
  while (out.length < n) {
    const v = 1 + Math.floor(next() * max);
    if (seen.has(v) && seen.size < max) continue;
    seen.add(v);
    out.push(v);
  }
  return (spec?.sorted ?? sorted) ? out.sort((a, b) => a - b) : out;
}

function arraySteps(alg: Algorithm, a0: number[], x: number): ArrayStep[] {
  const steps: ArrayStep[] = [];
  const v = blank();
  const a = [...a0];
  const n = a.length;
  const push = (line: number, msg: string, style: Record<number, Style> = {}, pointers: ArrayStep["pointers"] = []) =>
    steps.push({ a: [...a], style, pointers, line, msg, vars: { ...v } });
  const range = (lo: number, hi: number) => Object.fromEntries(Array.from({ length: n }, (_, k) => [k, (k < lo || k > hi ? "muted" : "normal") as Style]));

  switch (alg) {
    case "binary-search": {
      let lo = 0;
      let hi = n - 1;
      Object.assign(v, { lo, hi });
      push(0, `search for ${x}: the whole array is live`, range(lo, hi), [{ label: "lo", at: lo, dir: "up" }, { label: "hi", at: hi, dir: "up" }]);
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        v.comparisons++;
        Object.assign(v, { lo, hi, mid });
        const st = { ...range(lo, hi), [mid]: "active" as Style };
        const ptr: ArrayStep["pointers"] = [{ label: "mid", at: mid, dir: "down" }, { label: "lo", at: lo, dir: "up" }, { label: "hi", at: hi, dir: "up" }];
        if (a[mid] === x) {
          Object.assign(v, { found: mid, done: 1 });
          push(3, `a[${mid}] = ${a[mid]} = ${x}: found after ${v.comparisons} comparisons`, { ...st, [mid]: "done" }, ptr);
          return steps;
        }
        if (a[mid] < x) {
          push(4, `a[${mid}] = ${a[mid]} < ${x}: keep the right half`, st, ptr);
          lo = mid + 1;
        } else {
          push(5, `a[${mid}] = ${a[mid]} > ${x}: keep the left half`, st, ptr);
          hi = mid - 1;
        }
      }
      Object.assign(v, { lo, hi, done: 1, found: -1 });
      push(7, `lo > hi: ${x} is not in the array`, range(1, 0), []);
      return steps;
    }
    case "linear-search": {
      for (let i = 0; i < n; i++) {
        v.comparisons++;
        v.i = i;
        if (a[i] === x) {
          Object.assign(v, { found: i, done: 1 });
          push(1, `a[${i}] = ${x}: found after ${v.comparisons} comparisons`, { [i]: "done" }, [{ label: "i", at: i, dir: "down" }]);
          return steps;
        }
        push(1, `a[${i}] = ${a[i]} ≠ ${x}`, { ...Object.fromEntries(Array.from({ length: i }, (_, k) => [k, "muted" as Style])), [i]: "active" }, [{ label: "i", at: i, dir: "down" }]);
      }
      Object.assign(v, { done: 1, found: -1 });
      push(2, `${x} is not in the array (${v.comparisons} comparisons)`, range(1, 0));
      return steps;
    }
    case "insertion-sort": {
      push(0, "the first element alone is sorted", { 0: "done" });
      for (let i = 1; i < n; i++) {
        const key = a[i];
        let j = i - 1;
        v.i = i;
        v.j = j;
        push(1, `take key = ${key}`, { ...sortedUpTo(i - 1), [i]: "active" }, [{ label: "i", at: i, dir: "down" }]);
        while (j >= 0) {
          v.comparisons++;
          v.j = j;
          if (a[j] <= key) {
            push(2, `a[${j}] = ${a[j]} ≤ ${key}: stop`, { ...sortedUpTo(i), [j]: "active" }, [{ label: "j", at: j, dir: "up" }]);
            break;
          }
          a[j + 1] = a[j];
          v.swaps++;
          push(3, `a[${j}] = ${a[j]} > ${key}: shift it right`, { ...sortedUpTo(i), [j + 1]: "active" }, [{ label: "j", at: j, dir: "up" }]);
          j--;
        }
        a[j + 1] = key;
        push(5, `insert ${key} at ${j + 1}`, { ...sortedUpTo(i), [j + 1]: "active" });
      }
      Object.assign(v, { done: 1 });
      push(6, `sorted with ${v.comparisons} comparisons and ${v.swaps} shifts`, sortedUpTo(n - 1));
      return steps;
    }
    case "bubble-sort": {
      for (let i = 0; i < n - 1; i++) {
        v.i = i;
        for (let j = 0; j < n - 1 - i; j++) {
          v.j = j;
          v.comparisons++;
          const settled = Object.fromEntries(Array.from({ length: i }, (_, k) => [n - 1 - k, "done" as Style]));
          if (a[j] > a[j + 1]) {
            [a[j], a[j + 1]] = [a[j + 1], a[j]];
            v.swaps++;
            push(3, `${a[j + 1]} > ${a[j]}: swap`, { ...settled, [j]: "active", [j + 1]: "active" }, [{ label: "j", at: j, dir: "down" }]);
          } else push(2, `${a[j]} ≤ ${a[j + 1]}: leave`, { ...settled, [j]: "active", [j + 1]: "active" }, [{ label: "j", at: j, dir: "down" }]);
        }
      }
      Object.assign(v, { done: 1 });
      push(0, `sorted: ${v.comparisons} comparisons, ${v.swaps} swaps`, sortedUpTo(n - 1));
      return steps;
    }
    case "selection-sort": {
      for (let i = 0; i < n - 1; i++) {
        let m = i;
        v.i = i;
        push(1, `find the smallest of a[${i}..${n - 1}]`, { ...sortedUpTo(i - 1), [i]: "active" }, [{ label: "i", at: i, dir: "down" }]);
        for (let j = i + 1; j < n; j++) {
          v.j = j;
          v.comparisons++;
          if (a[j] < a[m]) m = j;
          push(3, `smallest so far: ${a[m]}`, { ...sortedUpTo(i - 1), [j]: "active", [m]: "active" }, [{ label: "j", at: j, dir: "down" }, { label: "min", at: m, dir: "up" }]);
        }
        if (m !== i) {
          [a[i], a[m]] = [a[m], a[i]];
          v.swaps++;
        }
        push(4, `swap it into place ${i}`, { ...sortedUpTo(i) });
      }
      Object.assign(v, { done: 1 });
      push(5, `sorted: ${v.comparisons} comparisons, ${v.swaps} swaps`, sortedUpTo(n - 1));
      return steps;
    }
    case "merge-sort": {
      for (let w = 1; w < n; w *= 2) {
        for (let lo = 0; lo < n - w; lo += 2 * w) {
          const mid = lo + w;
          const hi = Math.min(lo + 2 * w, n);
          const left = a.slice(lo, mid);
          const right = a.slice(mid, hi);
          let i = 0;
          let j = 0;
          let k = lo;
          Object.assign(v, { lo, hi: hi - 1, mid });
          push(2, `merge a[${lo}..${mid - 1}] and a[${mid}..${hi - 1}]`, runStyle(n, lo, hi - 1), [{ label: "lo", at: lo, dir: "up" }, { label: "mid", at: mid, dir: "up" }]);
          while (i < left.length || j < right.length) {
            if (j >= right.length || (i < left.length && left[i] <= right[j])) a[k++] = left[i++];
            else a[k++] = right[j++];
            if (i <= left.length && j <= right.length) v.comparisons++;
          }
          push(2, `merged run of ${hi - lo}`, runStyle(n, lo, hi - 1, true));
        }
      }
      Object.assign(v, { done: 1 });
      push(0, `sorted with ${v.comparisons} comparisons`, sortedUpTo(n - 1));
      return steps;
    }
    case "two-pointers": {
      let i = 0;
      let j = n - 1;
      Object.assign(v, { i, j });
      push(0, `find two values that add to ${x}`, {}, [{ label: "i", at: i, dir: "down" }, { label: "j", at: j, dir: "down" }]);
      while (i < j) {
        const s = a[i] + a[j];
        v.comparisons++;
        Object.assign(v, { i, j });
        const st: Record<number, Style> = { ...Object.fromEntries(Array.from({ length: n }, (_, k) => [k, (k < i || k > j ? "muted" : "normal") as Style])), [i]: "active", [j]: "active" };
        const ptr: ArrayStep["pointers"] = [{ label: "i", at: i, dir: "down" }, { label: "j", at: j, dir: "down" }];
        if (s === x) {
          Object.assign(v, { found: i, done: 1 });
          push(3, `${a[i]} + ${a[j]} = ${x}: found`, { ...st, [i]: "done", [j]: "done" }, ptr);
          return steps;
        }
        if (s < x) {
          push(4, `${a[i]} + ${a[j]} = ${s} < ${x}: move i right`, st, ptr);
          i++;
        } else {
          push(4, `${a[i]} + ${a[j]} = ${s} > ${x}: move j left`, st, ptr);
          j--;
        }
      }
      Object.assign(v, { done: 1, found: -1 });
      push(6, `no pair adds to ${x}`, {});
      return steps;
    }
  }
  return steps;

  function sortedUpTo(k: number): Record<number, Style> {
    return Object.fromEntries(Array.from({ length: k + 1 }, (_, i) => [i, "done" as Style]));
  }
}

function runStyle(n: number, lo: number, hi: number, done = false): Record<number, Style> {
  return Object.fromEntries(Array.from({ length: n }, (_, k) => [k, (k >= lo && k <= hi ? (done ? "done" : "active") : "normal") as Style]));
}

function graphSteps(alg: "bfs" | "dfs", g: NonNullable<AlgorithmStepsConfig["graph"]>): GraphStep[] {
  const adj = new Map<string, string[]>(g.nodes.map((n) => [n, []]));
  for (const [a, b] of g.edges) {
    adj.get(a)?.push(b);
    if (!g.directed) adj.get(b)?.push(a);
  }
  for (const list of adj.values()) list.sort();
  const steps: GraphStep[] = [];
  const v = blank();
  const seen: string[] = [];
  const tree: [string, string][] = [];
  const push = (line: number, msg: string, current: string | null, frontier: string[]) =>
    steps.push({ current, visited: [...seen], frontier: [...frontier], tree: [...tree], line, msg, vars: { ...v, visited: seen.length, frontier: frontier.length } });
  if (alg === "bfs") {
    const q = [g.start];
    seen.push(g.start);
    push(0, `start at ${g.start}`, null, q);
    while (q.length) {
      const u = q.shift()!;
      push(2, `visit ${u}`, u, q);
      for (const w of adj.get(u) ?? []) {
        v.comparisons++;
        if (!seen.includes(w)) {
          seen.push(w);
          tree.push([u, w]);
          q.push(w);
          push(5, `discover ${w} from ${u}`, u, q);
        }
      }
    }
  } else {
    const st = [g.start];
    push(0, `start at ${g.start}`, null, st);
    while (st.length) {
      const u = st.pop()!;
      v.comparisons++;
      if (seen.includes(u)) {
        push(3, `${u} already seen`, u, st);
        continue;
      }
      seen.push(u);
      const from = steps.length ? [...(adj.entries())].find(([k, l]) => seen.includes(k) && k !== u && l.includes(u))?.[0] : undefined;
      if (from) tree.push([from, u]);
      push(4, `visit ${u}`, u, st);
      for (const w of [...(adj.get(u) ?? [])].reverse()) if (!seen.includes(w)) st.push(w);
      if (st.length) push(5, `push the neighbours of ${u}`, u, st);
    }
  }
  v.done = 1;
  push(alg === "bfs" ? 7 : 6, `done: visited ${seen.length} of ${g.nodes.length}`, null, []);
  return steps;
}

export default function AlgorithmSteps({ config, params, preset, playing, resetKey, width, height, setReadouts }: TemplateProps<AlgorithmStepsConfig>) {
  const c = useMemo(() => ({ defs: compileDefs(config.defs), target: opt(config.target), speed: opt(config.speed), readouts: compileReadouts(config.readouts) }), [config]);
  const paramsKey = JSON.stringify(params);
  const graphAlg = config.algorithm === "bfs" || config.algorithm === "dfs";
  const run = useMemo(() => {
    const env = applyDefs(paramEnv(params), c.defs);
    if (graphAlg) return { env, graph: graphSteps(config.algorithm as "bfs" | "dfs", config.graph!), arr: null, n: config.graph!.nodes.length };
    const sorted = config.algorithm === "binary-search" || config.algorithm === "two-pointers";
    const a = makeArray(config.array, env, sorted);
    const x = c.target !== undefined ? Math.round(val(c.target, env)) : a[0];
    return { env, graph: null, arr: arraySteps(config.algorithm, a, x), n: a.length };
  }, [c, paramsKey, config.algorithm, config.array, config.graph, graphAlg]); // params enter through paramsKey

  const sim = useSim(() => ({ t: 0 }), [resetKey, preset, paramsKey]);
  const steps = run.graph ?? run.arr ?? [];

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const speed = Math.max(0.1, c.speed !== undefined ? val(c.speed, run.env) || 1 : 1);
        const s = sim.current;
        s.t += dt * speed;
        const cycle = steps.length - 1 + HOLD * speed;
        if (s.t >= cycle) s.t -= cycle;
        const k = Math.min(steps.length - 1, Math.floor(s.t));
        const step = steps[k];
        if (!step) return;

        const showCode = config.code !== false && height >= 300;
        const code = CODE[config.algorithm];
        const codeH = showCode ? code.length * 17 + 8 : 0;
        const m = 22;

        if (run.arr) {
          const st = step as ArrayStep;
          const n = st.a.length;
          const cell = Math.min(44, (width - 2 * m) / n);
          const blockH = 34 + cell + 16 + 34 + 26 + codeH;
          const top = Math.max(m, (height - blockH) / 2);
          const row = draw.cells(ctx, st.a, { left: m, top: top + 34, width: width - 2 * m, height: cell + 16 }, { style: (i) => st.style[i] ?? "normal" });
          const downs = st.pointers.filter((p) => p.dir === "down");
          const ups = st.pointers.filter((p) => p.dir === "up");
          for (const p of downs) draw.pointer(ctx, row.x(p.at), row.top - 2, p.label, { dir: "down", color: theme.accent });
          // Pointers sharing a cell below are merged into one label ("lo = hi").
          const byCell = new Map<number, string[]>();
          for (const p of ups) byCell.set(p.at, [...(byCell.get(p.at) ?? []), p.label]);
          for (const [at, labels] of byCell) if (at >= 0 && at < n) draw.pointer(ctx, row.x(at), row.top + row.height + 18, labels.join(" = "), { color: theme.muted });
          const msgY = row.top + row.height + 18 + 44;
          drawMessage(ctx, st.msg, width, msgY);
          if (showCode) draw.code(ctx, code, (width - 290) / 2, msgY + 18, { lang: "c", highlight: st.line, lineNumbers: true, width: 290, lineHeight: 17 });
        } else {
          const st = step as GraphStep;
          const g = config.graph!;
          const R = Math.max(40, Math.min((width - 2 * m) / 2, (height - 2 * m - codeH - 40) / 2) - 24);
          const cx = width / 2;
          const cy = m + 20 + R;
          const pos = new Map(g.nodes.map((nd, i) => [nd, [cx + R * Math.cos((2 * Math.PI * i) / g.nodes.length - Math.PI / 2), cy + R * Math.sin((2 * Math.PI * i) / g.nodes.length - Math.PI / 2)] as const]));
          const inTree = (a: string, b: string) => st.tree.some(([x, y]) => (x === a && y === b) || (!g.directed && x === b && y === a));
          for (const [a, b] of g.edges) {
            const [x1, y1] = pos.get(a)!;
            const [x2, y2] = pos.get(b)!;
            const on = inTree(a, b);
            if (g.directed) {
              const d = Math.hypot(x2 - x1, y2 - y1) || 1;
              draw.arrow(ctx, x1 + ((x2 - x1) / d) * 16, y1 + ((y2 - y1) / d) * 16, x2 - ((x2 - x1) / d) * 17, y2 - ((y2 - y1) / d) * 17, { color: on ? theme.accent : theme.line, width: on ? 2 : 1.25 });
            } else draw.line(ctx, x1, y1, x2, y2, { color: on ? theme.accent : theme.line, width: on ? 2 : 1.25 });
          }
          for (const nd of g.nodes) {
            const [x, y] = pos.get(nd)!;
            const visited = st.visited.includes(nd);
            const current = st.current === nd;
            const waiting = st.frontier.includes(nd);
            draw.circle(ctx, x, y, 14, { color: current ? theme.accent : visited ? theme.fg : waiting ? theme.accent2 : theme.muted, width: current ? 2.5 : 1.5, fill: theme.bg });
            draw.text(ctx, nd, x, y, { kind: "mono", align: "center", color: visited || current ? theme.fg : theme.muted });
          }
          const listY = cy + R + 34;
          const name = config.algorithm === "bfs" ? "queue" : "stack";
          draw.text(ctx, `${name}: ${st.frontier.length ? st.frontier.join(" ") : "empty"}`, m, listY, { kind: "mono", color: theme.accent2 });
          drawMessage(ctx, st.msg, width, listY + 22);
          if (showCode) draw.code(ctx, code, (width - 290) / 2, listY + 40, { lang: "c", highlight: st.line, lineNumbers: true, width: 290, lineHeight: 17 });
        }

        setReadouts(readoutValues(c.readouts, { ...run.env, ...step.vars, step: k, steps: steps.length, n: run.n }));
      }}
    />
  );
}

function drawMessage(ctx: CanvasRenderingContext2D, msg: string, width: number, y: number) {
  let s = msg;
  while (s.length > 4 && textWidth(ctx, s, LABEL_FONT.replace("11px", "12px")) > width - 40) s = `${s.slice(0, -2)}…`;
  draw.text(ctx, s, width / 2, y, { align: "center", color: theme.fg, size: 12 });
}
