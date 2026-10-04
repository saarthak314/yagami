// data-structure: a stack, queue, sorted linked list, binary search tree, min-heap or chained hash table
// under a list of operations, stepped through one comparison or move at a time with the structure drawn,
// the step explained, the operation's pseudocode highlighted and counters as readouts.

import { useMemo, useRef } from "react";
import { Stage, draw, theme } from "../kit";
import { compile, compileField, type Env } from "./expr";
import type { DataStructureConfig, Structure, StructureOp } from "./configs";
import { applyDefs, compileDefs, compileReadouts, opt, paramEnv, readoutValues, stepIndex, textWidth, val, type TemplateProps } from "./runtime";
import { LABEL_FONT } from "./ui";

interface Node {
  v: number;
  l: number | null;
  r: number | null;
}
interface Snap {
  list: number[]; // stack (bottom→top), queue (front→back), linked list, heap array
  nodes: Node[]; // bst
  root: number | null;
  buckets: number[][];
}
interface DStep {
  snap: Snap;
  /** Highlighted: list indices / bst node ids / [bucket, position] for hash tables. */
  hot: number[];
  path: number[];
  code: string[];
  line: number;
  msg: string;
  vars: Record<string, number>;
}

const CODE: Record<string, string[]> = {
  "stack.push": ["top = top + 1", "a[top] = x"],
  "stack.pop": ["if (top < 0) error", "x = a[top]", "top = top - 1", "return x"],
  "stack.search": ["for (i = top; i >= 0; i--)", "  if (a[i] == x) return i", "return -1"],
  "queue.enqueue": ["a[rear] = x", "rear = rear + 1"],
  "queue.dequeue": ["if (front == rear) error", "x = a[front]", "front = front + 1", "return x"],
  "queue.search": ["for (i = front; i < rear; i++)", "  if (a[i] == x) return i", "return -1"],
  "linked-list.insert": ["p = head", "while (p.next && p.next.v < x)", "  p = p.next", "node.next = p.next; p.next = node"],
  "linked-list.delete": ["p = head", "while (p.next && p.next.v != x)", "  p = p.next", "if (p.next) p.next = p.next.next"],
  "linked-list.search": ["p = head", "while (p && p.v != x)", "  p = p.next", "return p"],
  "bst.insert": ["p = root", "while (p)", "  p = x < p.v ? p.left : p.right", "attach new node at p"],
  "bst.search": ["p = root", "while (p && p.v != x)", "  p = x < p.v ? p.left : p.right", "return p"],
  "bst.delete": ["find p with p.v == x", "if (p has two children)", "  p.v = min(p.right); delete it", "else replace p by its child"],
  "min-heap.insert": ["a[n] = x; i = n; n++", "while (i > 0 && a[parent(i)] > a[i])", "  swap(a[i], a[parent(i)])", "  i = parent(i)"],
  "min-heap.pop": ["x = a[0]; a[0] = a[n-1]; n--", "while (a[i] > a smaller child)", "  swap with the smaller child", "return x"],
  "hash-table.insert": ["b = hash(x)", "for (y in table[b])", "  if (y == x) return", "table[b].append(x)"],
  "hash-table.search": ["b = hash(x)", "for (y in table[b])", "  if (y == x) return true", "return false"],
  "hash-table.delete": ["b = hash(x)", "for (y in table[b])", "  if (y == x) remove y", "return"],
};

function bstHeight(nodes: Node[], id: number | null): number {
  return id === null ? 0 : 1 + Math.max(bstHeight(nodes, nodes[id].l), bstHeight(nodes, nodes[id].r));
}

function simulate(kind: Structure, ops: { op: StructureOp; value: number }[], bucketCount: number, hashOf: (key: number) => number): DStep[] {
  const snap: Snap = { list: [], nodes: [], root: null, buckets: Array.from({ length: bucketCount }, () => []) };
  const steps: DStep[] = [];
  const vars = { size: 0, comparisons: 0, height: 0, collisions: 0, maxChain: 0, found: -1, top: NaN, done: 0 };
  const clone = (): Snap => ({ list: [...snap.list], nodes: snap.nodes.map((n) => ({ ...n })), root: snap.root, buckets: snap.buckets.map((b) => [...b]) });
  const update = () => {
    vars.size = kind === "bst" ? countBst(snap) : kind === "hash-table" ? snap.buckets.reduce((s, b) => s + b.length, 0) : snap.list.length;
    vars.height = kind === "bst" ? bstHeight(snap.nodes, snap.root) : kind === "min-heap" ? (snap.list.length ? Math.floor(Math.log2(snap.list.length)) + 1 : 0) : 0;
    vars.maxChain = Math.max(0, ...snap.buckets.map((b) => b.length));
    vars.top = kind === "stack" ? (snap.list.at(-1) ?? NaN) : kind === "queue" || kind === "min-heap" || kind === "linked-list" ? (snap.list[0] ?? NaN) : kind === "bst" && snap.root !== null ? snap.nodes[snap.root].v : NaN;
  };
  const push = (codeKey: string, line: number, msg: string, hot: number[] = [], path: number[] = []) => {
    update();
    steps.push({ snap: clone(), hot, path, code: CODE[codeKey] ?? [], line, msg, vars: { ...vars } });
  };
  push(`${kind}.${ops[0]?.op ?? "insert"}`, -1, "start");

  for (const { op, value: x } of ops) {
    const key = `${kind}.${op}`;
    if (kind === "stack") {
      if (op === "push") {
        snap.list.push(x);
        push(key, 1, `push ${x}`, [snap.list.length - 1]);
      } else if (op === "pop") {
        if (!snap.list.length) push(key, 0, "pop: the stack is empty");
        else {
          push(key, 1, `pop: the top is ${snap.list.at(-1)}`, [snap.list.length - 1]);
          const v = snap.list.pop();
          push(key, 3, `popped ${v}`, []);
        }
      } else {
        vars.found = 0;
        for (let i = snap.list.length - 1; i >= 0; i--) {
          vars.comparisons++;
          const hit = snap.list[i] === x;
          push(key, 1, `${snap.list[i]} ${hit ? "=" : "≠"} ${x}`, [i]);
          if (hit) {
            vars.found = 1;
            break;
          }
        }
        if (!vars.found) push(key, 2, `${x} is not in the stack`);
      }
    } else if (kind === "queue") {
      if (op === "enqueue") {
        snap.list.push(x);
        push(key, 0, `enqueue ${x} at the rear`, [snap.list.length - 1]);
      } else if (op === "dequeue") {
        if (!snap.list.length) push(key, 0, "dequeue: the queue is empty");
        else {
          push(key, 1, `dequeue: the front is ${snap.list[0]}`, [0]);
          snap.list.shift();
          push(key, 3, "dequeued");
        }
      } else {
        vars.found = 0;
        for (let i = 0; i < snap.list.length; i++) {
          vars.comparisons++;
          const hit = snap.list[i] === x;
          push(key, 1, `${snap.list[i]} ${hit ? "=" : "≠"} ${x}`, [i]);
          if (hit) {
            vars.found = 1;
            break;
          }
        }
        if (!vars.found) push(key, 2, `${x} is not in the queue`);
      }
    } else if (kind === "linked-list") {
      // A sorted list: insert keeps order; delete and search walk from the head.
      let i = 0;
      while (i < snap.list.length && (op === "insert" ? snap.list[i] < x : snap.list[i] !== x)) {
        vars.comparisons++;
        push(key, 2, `${snap.list[i]} ${op === "insert" ? "<" : "≠"} ${x}: move on`, [i]);
        i++;
      }
      if (op === "insert") {
        snap.list.splice(i, 0, x);
        push(key, 3, `link ${x} in at position ${i}`, [i]);
      } else if (op === "delete") {
        if (i < snap.list.length) {
          vars.comparisons++;
          push(key, 3, `found ${x}: unlink it`, [i]);
          snap.list.splice(i, 1);
          push(key, 3, `deleted ${x}`);
        } else push(key, 3, `${x} is not in the list`);
      } else {
        vars.found = i < snap.list.length ? 1 : 0;
        if (vars.found) vars.comparisons++;
        push(key, 3, vars.found ? `found ${x} at position ${i}` : `${x} is not in the list`, vars.found ? [i] : []);
      }
    } else if (kind === "bst") {
      const path: number[] = [];
      let p = snap.root;
      let parent: number | null = null;
      while (p !== null && snap.nodes[p].v !== x) {
        vars.comparisons++;
        path.push(p);
        const goLeft = x < snap.nodes[p].v;
        push(key, 2, `${x} ${goLeft ? "<" : ">"} ${snap.nodes[p].v}: go ${goLeft ? "left" : "right"}`, [p], [...path]);
        parent = p;
        p = goLeft ? snap.nodes[p].l : snap.nodes[p].r;
      }
      if (p !== null) vars.comparisons++;
      if (op === "insert") {
        if (p !== null) push(key, 3, `${x} is already in the tree`, [p], path);
        else {
          const id = snap.nodes.push({ v: x, l: null, r: null }) - 1;
          if (parent === null) snap.root = id;
          else if (x < snap.nodes[parent].v) snap.nodes[parent].l = id;
          else snap.nodes[parent].r = id;
          push(key, 3, `attach ${x}`, [id], [...path, id]);
        }
      } else if (op === "search") {
        vars.found = p !== null ? 1 : 0;
        push(key, 3, p !== null ? `found ${x}` : `${x} is not in the tree`, p !== null ? [p] : [], p !== null ? [...path, p] : path);
      } else if (p === null) push(key, 0, `${x} is not in the tree`, [], path);
      else {
        const nd = snap.nodes[p];
        if (nd.l !== null && nd.r !== null) {
          let s = nd.r;
          let sp = p;
          while (snap.nodes[s].l !== null) {
            sp = s;
            s = snap.nodes[s].l!;
          }
          push(key, 2, `two children: replace ${x} by its successor ${snap.nodes[s].v}`, [p, s], [...path, p]);
          nd.v = snap.nodes[s].v;
          if (sp === p) snap.nodes[sp].r = snap.nodes[s].r;
          else snap.nodes[sp].l = snap.nodes[s].r;
        } else {
          const child = nd.l ?? nd.r;
          if (parent === null) snap.root = child;
          else if (snap.nodes[parent].l === p) snap.nodes[parent].l = child;
          else snap.nodes[parent].r = child;
        }
        push(key, 3, `deleted ${x}`, [], path);
      }
    } else if (kind === "min-heap") {
      const a = snap.list;
      const swap = (i: number, j: number) => ([a[i], a[j]] = [a[j], a[i]]);
      if (op === "insert") {
        a.push(x);
        let i = a.length - 1;
        push(key, 0, `add ${x} at the end`, [i]);
        while (i > 0) {
          const pi = Math.floor((i - 1) / 2);
          vars.comparisons++;
          if (a[pi] <= a[i]) {
            push(key, 1, `${a[pi]} ≤ ${a[i]}: heap order holds`, [i, pi]);
            break;
          }
          swap(i, pi);
          push(key, 2, `${a[i]} > ${a[pi]}: swap up`, [pi, i]);
          i = pi;
        }
      } else if (!a.length) push(key, 0, "pop: the heap is empty");
      else {
        push(key, 0, `the minimum is ${a[0]}`, [0]);
        const lastV = a.pop()!;
        if (a.length) {
          a[0] = lastV;
          push(key, 0, `move ${lastV} to the root`, [0]);
          let i = 0;
          for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let s = i;
            if (l < a.length) (vars.comparisons++, a[l] < a[s] && (s = l));
            if (r < a.length) (vars.comparisons++, a[r] < a[s] && (s = r));
            if (s === i) {
              push(key, 1, "heap order holds", [i]);
              break;
            }
            swap(i, s);
            push(key, 2, `swap ${a[s]} down with ${a[i]}`, [i, s]);
            i = s;
          }
        } else push(key, 3, "the heap is empty again");
      }
    } else {
      const b = ((hashOf(x) % bucketCount) + bucketCount) % bucketCount;
      const chain = snap.buckets[b];
      push(key, 0, `hash(${x}) = ${b}`, [b, -1]);
      let pos = -1;
      for (let j = 0; j < chain.length; j++) {
        vars.comparisons++;
        const hit = chain[j] === x;
        push(key, 2, `${chain[j]} ${hit ? "=" : "≠"} ${x}`, [b, j]);
        if (hit) {
          pos = j;
          break;
        }
      }
      if (op === "insert") {
        if (pos >= 0) push(key, 2, `${x} is already stored`, [b, pos]);
        else {
          if (chain.length) vars.collisions++;
          chain.push(x);
          push(key, 3, chain.length > 1 ? `collision: chain ${x} in bucket ${b}` : `store ${x} in bucket ${b}`, [b, chain.length - 1]);
        }
      } else if (op === "search") {
        vars.found = pos >= 0 ? 1 : 0;
        push(key, 3, pos >= 0 ? `found ${x} in bucket ${b}` : `${x} is not stored`, [b, pos]);
      } else if (pos >= 0) {
        chain.splice(pos, 1);
        push(key, 2, `removed ${x} from bucket ${b}`, [b, -1]);
      } else push(key, 3, `${x} is not stored`, [b, -1]);
    }
  }
  vars.done = 1;
  const last = steps[steps.length - 1];
  steps.push({ ...last, hot: [], path: [], line: -1, msg: `done: ${ops.length} operation${ops.length === 1 ? "" : "s"}`, vars: { ...last.vars, done: 1 } });
  return steps;
}

function countBst(s: Snap): number {
  let n = 0;
  const walk = (id: number | null) => {
    if (id === null) return;
    n++;
    walk(s.nodes[id].l);
    walk(s.nodes[id].r);
  };
  walk(s.root);
  return n;
}

export default function DataStructure({ config, params, playing, resetKey, width, height, setReadouts }: TemplateProps<DataStructureConfig>) {
  const c = useMemo(
    () => ({
      defs: compileDefs(config.defs),
      ops: config.ops.map((o) => ({ op: o.op, value: o.value !== undefined ? compileField(o.value) : undefined })),
      buckets: opt(config.buckets),
      hash: config.hash ? compile(config.hash) : null,
      speed: opt(config.speed),
      readouts: compileReadouts(config.readouts),
    }),
    [config],
  );
  const paramsKey = JSON.stringify(params);
  const run = useMemo(() => {
    const env: Env = applyDefs(paramEnv(params), c.defs);
    const m = Math.max(1, Math.min(16, Math.round(c.buckets !== undefined ? val(c.buckets, env) || 7 : 7)));
    const hashOf = (key: number) => {
      const h = c.hash ? Math.round(val(c.hash, { ...env, key, m })) : key;
      return Number.isFinite(h) ? h : 0;
    };
    const ops = c.ops.map((o) => ({ op: o.op, value: o.value !== undefined ? Math.round(val(o.value, env)) : NaN }));
    return { env, m, steps: simulate(config.kind, ops, m, hashOf) };
  }, [c, paramsKey, config.kind]); // params enter through paramsKey
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
        const speed = Math.max(0.2, c.speed !== undefined ? val(c.speed, run.env) || 1 : 1);
        const steps = run.steps;
        const k = stepIndex(clk.t, steps.length, speed);
        const st = steps[k];
        const s = st.snap;

        const m = 22;
        const showCode = config.code !== false && height >= 340 && st.code.length > 0;
        const codeH = showCode ? st.code.length * 17 + 10 : 0;
        const msgY = height - m - codeH - 12;
        const area = { left: m, top: m, width: width - 2 * m, height: msgY - m - 18 };
        const fmt = (v: number) => String(v);

        if (config.kind === "stack" || config.kind === "queue" || config.kind === "linked-list") {
          const n = s.list.length;
          if (config.kind === "stack") {
            const size = Math.min(40, (area.height - 30) / Math.max(1, Math.max(n, 4)));
            const w = Math.min(120, area.width * 0.5);
            const x = width / 2 - w / 2;
            const bottom = area.top + area.height;
            draw.line(ctx, x - 10, bottom, x + w + 10, bottom, { color: theme.muted, width: 1.25 });
            s.list.forEach((v, i) => {
              const y = bottom - (i + 1) * size;
              const hot = st.hot.includes(i);
              if (hot) {
                ctx.save();
                ctx.globalAlpha = 0.16;
                ctx.fillStyle = theme.accent;
                ctx.fillRect(x, y, w, size);
                ctx.restore();
              }
              draw.rect(ctx, x + 0.5, y + 0.5, w - 1, size - 1, { color: hot ? theme.accent : theme.line, width: hot ? 1.5 : 1 });
              draw.text(ctx, fmt(v), x + w / 2, y + size / 2, { kind: "mono", align: "center", color: theme.fg, size: Math.min(13, Math.floor(size * 0.4)) });
            });
            if (n) draw.text(ctx, "top →", x - 8, bottom - (n - 0.5) * size, { kind: "mono", align: "right", color: theme.accent });
            else draw.text(ctx, "empty", width / 2, bottom - 14, { align: "center", color: theme.faint });
          } else if (config.kind === "queue") {
            if (n) {
              const row = draw.cells(ctx, s.list.map(fmt), { left: area.left, top: area.top + area.height / 2 - 40, width: area.width, height: 60 }, { style: (i) => (st.hot.includes(i) ? "active" : "normal") });
              draw.pointer(ctx, row.x(0), row.top - 2, "front", { dir: "down", color: theme.accent });
              draw.pointer(ctx, row.x(n - 1), row.top + row.height + 18, "rear", { color: theme.muted });
            } else draw.text(ctx, "empty", width / 2, area.top + area.height / 2, { align: "center", color: theme.faint });
          } else {
            const boxW = Math.min(52, (area.width - 40) / Math.max(1, n) - 22);
            const gap = 22;
            const total = n * boxW + Math.max(0, n - 1) * gap;
            const x0 = width / 2 - total / 2;
            const y = area.top + area.height / 2 - 14;
            s.list.forEach((v, i) => {
              const x = x0 + i * (boxW + gap);
              const hot = st.hot.includes(i);
              draw.rect(ctx, x + 0.5, y + 0.5, boxW - 1, 28, { color: hot ? theme.accent : theme.line, width: hot ? 1.75 : 1, fill: hot ? undefined : null });
              draw.text(ctx, fmt(v), x + boxW / 2, y + 14, { kind: "mono", align: "center", color: theme.fg });
              if (i < n - 1) draw.arrow(ctx, x + boxW + 2, y + 14, x + boxW + gap - 2, y + 14, { color: theme.muted, width: 1.25, head: 5 });
            });
            if (n) draw.pointer(ctx, x0 + boxW / 2, y - 2, "head", { dir: "down", color: theme.muted });
            else draw.text(ctx, "empty", width / 2, y + 14, { align: "center", color: theme.faint });
          }
        } else if (config.kind === "bst") {
          // In-order position for x, depth for y.
          const order: number[] = [];
          const depth = new Map<number, number>();
          const walk = (id: number | null, d: number) => {
            if (id === null) return;
            walk(s.nodes[id].l, d + 1);
            order.push(id);
            depth.set(id, d);
            walk(s.nodes[id].r, d + 1);
          };
          walk(s.root, 0);
          const levels = Math.max(1, ...[...depth.values()].map((d) => d + 1));
          const dx = area.width / Math.max(1, order.length);
          const dy = Math.min(64, (area.height - 30) / Math.max(1, levels - 1 || 1));
          const R = Math.max(10, Math.min(17, dx / 2 - 3));
          const pos = new Map(order.map((id, i) => [id, [area.left + dx * (i + 0.5), area.top + R + 4 + (depth.get(id) ?? 0) * dy] as const]));
          for (const id of order) {
            const [x, y] = pos.get(id)!;
            for (const ch of [s.nodes[id].l, s.nodes[id].r]) {
              if (ch === null || !pos.has(ch)) continue;
              const [x2, y2] = pos.get(ch)!;
              const on = st.path.includes(id) && st.path.includes(ch);
              draw.line(ctx, x, y, x2, y2, { color: on ? theme.accent2 : theme.line, width: on ? 2 : 1.25 });
            }
          }
          for (const id of order) {
            const [x, y] = pos.get(id)!;
            const hot = st.hot.includes(id);
            const onPath = st.path.includes(id);
            draw.circle(ctx, x, y, R, { color: hot ? theme.accent : onPath ? theme.accent2 : theme.muted, width: hot ? 2.25 : 1.5, fill: theme.bg });
            draw.text(ctx, fmt(s.nodes[id].v), x, y, { kind: "mono", align: "center", color: theme.fg, size: Math.min(12, Math.floor(R * 0.8)) });
          }
          if (!order.length) draw.text(ctx, "empty tree", width / 2, area.top + 30, { align: "center", color: theme.faint });
        } else if (config.kind === "min-heap") {
          const a = s.list;
          const treeH = area.height - 70;
          const levels = a.length ? Math.floor(Math.log2(a.length)) + 1 : 1;
          const dy = Math.min(56, treeH / Math.max(1, levels));
          const R = Math.max(10, Math.min(16, area.width / Math.max(1, 2 ** (levels - 1)) / 2 - 3));
          const posOf = (i: number): [number, number] => {
            const lv = Math.floor(Math.log2(i + 1));
            const idx = i - (2 ** lv - 1);
            const w = area.width / 2 ** lv;
            return [area.left + w * (idx + 0.5), area.top + R + 2 + lv * dy];
          };
          for (let i = 1; i < a.length; i++) {
            const [x, y] = posOf(i);
            const [px, py] = posOf(Math.floor((i - 1) / 2));
            draw.line(ctx, px, py, x, y, { color: theme.line, width: 1.25 });
          }
          a.forEach((v, i) => {
            const [x, y] = posOf(i);
            const hot = st.hot.includes(i);
            draw.circle(ctx, x, y, R, { color: hot ? theme.accent : theme.muted, width: hot ? 2.25 : 1.5, fill: theme.bg });
            draw.text(ctx, fmt(v), x, y, { kind: "mono", align: "center", color: theme.fg, size: Math.min(12, Math.floor(R * 0.8)) });
          });
          if (a.length) draw.cells(ctx, a.map(fmt), { left: area.left, top: area.top + area.height - 56, width: area.width, height: 50 }, { style: (i) => (st.hot.includes(i) ? "active" : "normal"), maxCell: 32 });
          else draw.text(ctx, "empty heap", width / 2, area.top + 30, { align: "center", color: theme.faint });
        } else {
          const rows = run.m;
          const rowH = Math.min(30, area.height / rows);
          const cellW = Math.min(46, Math.max(28, (area.width - 50) / Math.max(4, Math.max(...s.buckets.map((b) => b.length)) + 1)));
          s.buckets.forEach((chain, b) => {
            const y = area.top + b * rowH;
            const hotBucket = st.hot[0] === b;
            draw.text(ctx, String(b), area.left + 14, y + rowH / 2, { kind: "mono", align: "right", color: hotBucket ? theme.accent : theme.faint });
            draw.rect(ctx, area.left + 22.5, y + 3.5, 14, rowH - 7, { color: hotBucket ? theme.accent : theme.line, width: 1 });
            chain.forEach((v, j) => {
              const x = area.left + 46 + j * (cellW + 10);
              const hot = hotBucket && st.hot[1] === j;
              draw.arrow(ctx, x - 9, y + rowH / 2, x - 1, y + rowH / 2, { color: theme.faint, width: 1, head: 4 });
              draw.rect(ctx, x + 0.5, y + 3.5, cellW, rowH - 7, { color: hot ? theme.accent : theme.muted, width: hot ? 1.75 : 1 });
              draw.text(ctx, fmt(v), x + cellW / 2, y + rowH / 2, { kind: "mono", align: "center", color: theme.fg, size: Math.min(12, Math.floor(rowH * 0.45)) });
            });
          });
        }

        // The step in words, and the operation's code.
        let msg = st.msg;
        while (msg.length > 4 && textWidth(ctx, msg, LABEL_FONT.replace("11px", "12px")) > width - 2 * m) msg = `${msg.slice(0, -2)}…`;
        draw.text(ctx, msg, width / 2, msgY, { align: "center", color: theme.fg, size: 12 });
        if (showCode) {
          const w = Math.min(width - 2 * m, Math.max(220, ...st.code.map((l) => textWidth(ctx, l) + 60)));
          draw.code(ctx, st.code, (width - w) / 2, msgY + 14, { lang: "pseudo", highlight: st.line >= 0 ? st.line : undefined, lineNumbers: true, width: w, lineHeight: 17 });
        }

        setReadouts(readoutValues(c.readouts, { ...run.env, ...st.vars, step: k, steps: steps.length }));
      }}
    />
  );
}
