// state-machine engine: a finite automaton reading its input, or a Turing machine stepping over a tape,
// from a transition table. Pure TypeScript (no DOM): the validator runs it to know a config's final values.

import type { Value } from "./expr";

export interface Transition {
  from: string;
  /** Symbol read: a character, "_" blank, "*" any (an exact row wins over "*"). */
  read: string;
  to: string;
  /** Turing: operations "P0, R" (P<sym> print, E erase, L, R, N), or write/move. */
  ops?: string;
  write?: string;
  move?: "L" | "R" | "N";
}

export interface MachineSetup {
  kind: "dfa" | "turing";
  start: string;
  accept: string[];
  transitions: Transition[];
  input: string;
  head: number;
  maxSteps: number;
}

export interface MachineStep {
  state: string;
  tape: Record<number, string>;
  head: number;
  /** Transition row applied to reach this step (−1: none). */
  row: number;
  /** Row about to apply from this step (−1: halts). */
  nextRow: number;
  halted: boolean;
  msg: string;
  vars: Record<string, Value>;
}

export const BLANK = "_";

/** Parse "P0, R, R" / "E, L" into operations. */
export function parseOps(t: Transition): string[] {
  if (t.ops !== undefined)
    return t.ops
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const out: string[] = [];
  if (t.write !== undefined) out.push(t.write === BLANK ? "E" : `P${t.write}`);
  if (t.move && t.move !== "N") out.push(t.move);
  return out;
}

export function opsProblem(t: Transition): string | null {
  for (const op of parseOps(t)) if (!/^(P.+|E|L|R|N)$/.test(op)) return `"${op}" is not an operation (P<symbol>, E, L, R, N)`;
  return null;
}

function find(rows: Transition[], state: string, sym: string): number {
  const exact = rows.findIndex((r) => r.from === state && r.read === sym);
  if (exact >= 0) return exact;
  return rows.findIndex((r) => r.from === state && r.read === "*");
}

const show = (s: string) => (s === BLANK ? "blank" : s);

export function runMachine(m: MachineSetup): MachineStep[] {
  const tape: Record<number, string> = {};
  [...m.input].forEach((ch, i) => {
    if (ch !== BLANK && ch !== " ") tape[i] = ch;
  });
  let state = m.start;
  let head = m.kind === "dfa" ? 0 : m.head;
  const steps: MachineStep[] = [];
  const tapeStr = () => {
    const ks = Object.keys(tape).map(Number);
    if (!ks.length) return "";
    const lo = Math.min(...ks);
    const hi = Math.max(...ks);
    return Array.from({ length: hi - lo + 1 }, (_, i) => tape[lo + i] ?? BLANK).join("");
  };
  const accepting = () => (m.accept.length ? (m.accept.includes(state) ? 1 : 0) : 0);
  const symAt = (i: number) => tape[i] ?? BLANK;
  const next = (): number => {
    if (m.kind === "dfa" && head >= m.input.length) return -1;
    return find(m.transitions, state, symAt(head));
  };
  const push = (row: number, msg: string, halted: boolean) => {
    steps.push({
      state,
      tape: { ...tape },
      head,
      row,
      nextRow: halted ? -1 : next(),
      halted,
      msg,
      vars: { state, head, halted: halted ? 1 : 0, accepted: halted ? accepting() : 0, tape: tapeStr(), moves: steps.length, symbols: Object.keys(tape).length },
    });
  };
  push(-1, m.kind === "dfa" ? `start in ${state}, reading "${m.input}"` : `start in ${state} on a ${m.input.replace(/_/g, "").length ? "tape" : "blank tape"}`, false);
  for (let k = 0; k < m.maxSteps; k++) {
    const r = next();
    if (r < 0) {
      if (m.kind === "dfa" && head >= m.input.length) {
        push(-1, `input read: ends in ${state} — ${accepting() ? "accepted" : "rejected"}`, true);
      } else push(-1, `no row for (${state}, ${show(symAt(head))}): the machine ${m.kind === "dfa" ? "rejects" : "halts"}`, true);
      return steps;
    }
    const t = m.transitions[r];
    const sym = symAt(head);
    if (m.kind === "dfa") {
      head++;
      state = t.to;
      push(r, `${t.from} reads ${sym} → ${t.to}`, false);
      continue;
    }
    const ops = parseOps(t);
    for (const op of ops) {
      if (op === "E") delete tape[head];
      else if (op === "L") head--;
      else if (op === "R") head++;
      else if (op[0] === "P") {
        const ch = op.slice(1);
        if (ch === BLANK) delete tape[head];
        else tape[head] = ch;
      }
    }
    state = t.to;
    push(r, `${t.from}, ${show(sym)}: ${ops.length ? ops.join(", ") : "no operation"} → ${t.to}`, false);
  }
  const last = steps[steps.length - 1];
  last.msg += ` (stopped after ${m.maxSteps} steps)`;
  return steps;
}

/** Symbol count on a step's tape. */
export function countOn(tape: Record<number, string>, sym: string): number {
  return Object.values(tape).filter((x) => x === sym).length;
}

export const MACHINE_VARS = ["step", "steps", "done", "state", "head", "halted", "accepted", "tape", "moves", "symbols"];
