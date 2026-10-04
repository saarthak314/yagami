// Binary search (reference demo for computer-science texts).
// A sorted array of n keys and a target. Each step compares the target with
// the middle of the live range a[lo..hi] and discards the half that cannot
// hold it, so the range at least halves and the search ends after at most
// ⌈log₂(n+1)⌉ comparisons. The full list of steps is computed up front from
// the inputs; the animation only picks which step to show from elapsed time.

import { useMemo } from "react";
import { Stage, draw, rng, theme, useSim } from "../../kit";
import type { DemoProps } from "../../../types";

interface Step {
  lo: number;
  hi: number;
  /** Index compared in this step (-1 before the first comparison). */
  mid: number;
  /** a[mid] relative to the target. */
  cmp: "<" | ">" | "=" | null;
  comparisons: number;
  done: boolean;
}

const HOLD = 1.6; // seconds the final state stays up before the run loops

// The code being traced; the line for the current step is highlighted.
const CODE = [
  "int lo = 0, hi = n - 1;",
  "while (lo <= hi) {",
  "  int mid = (lo + hi) / 2;",
  "  if (a[mid] == x) return mid;",
  "  if (a[mid] < x) lo = mid + 1;",
  "  else hi = mid - 1;",
  "}",
  "return -1; // not present",
];

/** Sorted, distinct keys with gaps of at least 2, so "target + 1" is never present. */
function makeKeys(n: number, seed: number): number[] {
  const next = rng(seed);
  const keys: number[] = [];
  let v = 2 + Math.floor(next() * 5);
  for (let i = 0; i < n; i++) {
    keys.push(v);
    v += 2 + Math.floor(next() * 7);
  }
  return keys;
}

/** Every state of the search, in order: start, one per comparison, then the outcome. */
function search(a: number[], target: number): Step[] {
  const steps: Step[] = [];
  let lo = 0;
  let hi = a.length - 1;
  let comparisons = 0;
  steps.push({ lo, hi, mid: -1, cmp: null, comparisons, done: false });
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    comparisons++;
    const cmp = a[mid] === target ? "=" : a[mid] < target ? "<" : ">";
    steps.push({ lo, hi, mid, cmp, comparisons, done: cmp === "=" });
    if (cmp === "=") return steps;
    if (cmp === "<") lo = mid + 1;
    else hi = mid - 1;
  }
  steps.push({ lo, hi, mid: -1, cmp: null, comparisons, done: true });
  return steps;
}

export default function BinarySearch({ params, preset, playing, resetKey, width, height, setReadouts }: DemoProps) {
  const n = Math.round(Number(params.n ?? 15));
  const seed = Math.round(Number(params.seed ?? 3));
  const absent = Boolean(params.absent);
  const k = Math.min(n - 1, Math.max(0, Math.round(Number(params.targetIndex ?? 0))));
  const speed = Number(params.speed ?? 1); // steps per second

  const keys = useMemo(() => makeKeys(n, seed), [n, seed]);
  const target = absent ? keys[k] + 1 : keys[k];
  const steps = useMemo(() => search(keys, target), [keys, target]);
  const bound = Math.ceil(Math.log2(n + 1));

  const sim = useSim(() => ({ t: 0 }), [resetKey, preset, n, seed, absent, k]);

  return (
    <Stage
      width={width}
      height={height}
      playing={playing}
      resetKey={resetKey}
      onFrame={(ctx, { dt }) => {
        const s = sim.current;
        s.t += dt * speed;
        const cycle = steps.length - 1 + HOLD * speed;
        if (s.t >= cycle) s.t -= cycle;
        const step = steps[Math.min(steps.length - 1, Math.floor(s.t))];
        const { lo, hi, mid, cmp } = step;
        const found = step.done && cmp === "=";

        // Layout: question on top, the array in the middle, the comparison
        // and the invariant underneath, all centred vertically as one block.
        const m = 24;
        const cellBox = { left: m, top: 0, width: width - 2 * m, height: 0 };
        const cell = Math.min(44, cellBox.width / n);
        const codeLh = 18;
        const blockH = 30 + 34 + cell + 16 + 34 + 30 + CODE.length * codeLh;
        const top = Math.max(m, (height - blockH) / 2);

        draw.text(ctx, "search for", m, top + 8, { color: theme.muted });
        const chip = draw.chip(ctx, String(target), m + 66, top + 8, { align: "left", mono: true, active: true });
        draw.text(ctx, `in a sorted array of ${n} keys`, m + 66 + chip.width + 8, top + 8, { color: theme.muted });

        const row = draw.cells(ctx, keys, { ...cellBox, top: top + 30 + 34, height: cell + 16 }, {
          style: (i) => (i === mid ? "active" : i < lo || i > hi ? "muted" : found ? "done" : "normal"),
        });

        // Pointers: mid from above, lo and hi from below (one label when they coincide).
        if (mid >= 0) draw.pointer(ctx, row.x(mid), row.top - 2, "mid", { dir: "down", color: theme.accent });
        const below = row.top + row.height + 18;
        if (lo === hi) draw.pointer(ctx, row.x(lo), below, "lo = hi", { color: theme.muted });
        else {
          if (lo < n) draw.pointer(ctx, row.x(lo), below, "lo", { color: theme.muted });
          if (hi >= 0) draw.pointer(ctx, row.x(hi), below, "hi", { color: theme.muted });
        }

        // What this step did, in words, then the code with the current line highlighted.
        const ty = below + 46;
        let line: string;
        let codeLine: number;
        if (mid < 0 && !step.done) {
          line = "start: the whole array is live, lo = 0, hi = n − 1";
          codeLine = 0;
        } else if (cmp === "=") {
          line = `a[${mid}] = ${keys[mid]} = target: found after ${step.comparisons} comparisons`;
          codeLine = 3;
        } else if (cmp === "<") {
          line = `a[${mid}] = ${keys[mid]} < ${target}: discard the left half, lo = ${mid + 1}`;
          codeLine = 4;
        } else if (cmp === ">") {
          line = `a[${mid}] = ${keys[mid]} > ${target}: discard the right half, hi = ${mid - 1}`;
          codeLine = 5;
        } else {
          line = `lo > hi: the range is empty, ${target} is not present (it would go at index ${lo})`;
          codeLine = 7;
        }
        draw.text(ctx, line, width / 2, ty, { align: "center", color: theme.fg, size: 12 });
        const codeW = 250;
        draw.code(ctx, CODE, (width - codeW) / 2, ty + 22, { lang: "c", lineHeight: codeLh, highlight: codeLine, lineNumbers: true, width: codeW });

        setReadouts({
          comparisons: step.comparisons,
          bound,
          live: Math.max(0, hi - lo + 1),
          result: found ? `found at ${mid}` : step.done ? `absent (insert at ${lo})` : "searching",
        });
      }}
    />
  );
}
