// markov-chain engine: the exact distribution step by step, the stationary (or limiting) distribution,
// absorption probabilities and expected duration, and seeded walkers that actually play the chain.
// Pure TypeScript (no DOM): the validator runs it to know a config's final values.

export interface MarkovSetup {
  names: string[];
  P: number[][];
  start: number;
  horizon: number;
  walkers: number;
  next: () => number;
}

export interface MarkovRun {
  names: string[];
  P: number[][];
  absorbing: boolean[];
  /** dist[t][s]: exact probability of being in s after t steps. */
  dist: number[][];
  /** emp[t][s]: share of the walkers in s after t steps. */
  emp: number[][];
  /** absorbedAt[t]: share of the walkers absorbed by step t. */
  absorbedAt: number[];
  /** Stationary distribution when unique, else the long-run average from the start. */
  limit: number[];
  /** Probability of ending in each absorbing state from the start (0 elsewhere). */
  absorb: number[];
  /** Expected steps until absorption from the start (NaN when there is no certain absorption). */
  expDuration: number;
  /** Share of the walkers that ended in each state (played to absorption, or the horizon without absorbing states). */
  hit: number[];
  /** Mean number of steps the walkers took to be absorbed (NaN without absorbing states). */
  duration: number;
  /** Walker 0's state after each step. */
  sample: number[];
  walkers: number;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (null when singular). */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const step = (d: number[], P: number[][]) => {
  const out = new Array<number>(d.length).fill(0);
  for (let i = 0; i < d.length; i++) if (d[i]) for (let j = 0; j < d.length; j++) out[j] += d[i] * P[i][j];
  return out;
};

const WALK_BUDGET = 2_000_000;

export function runMarkov(s: MarkovSetup): MarkovRun {
  const n = s.names.length;
  const P = s.P;
  const absorbing = P.map((r, i) => r[i] >= 1 - 1e-12);
  const d0 = new Array<number>(n).fill(0);
  d0[s.start] = 1;
  const dist = [d0];
  for (let t = 1; t <= s.horizon; t++) dist.push(step(dist[t - 1], P));

  // Stationary: solve π(P − I) = 0 with Σπ = 1; when that isn't unique, average the distribution over a long run.
  let limit: number[] | null = null;
  {
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => P[j][i] - (i === j ? 1 : 0)));
    A[n - 1] = new Array<number>(n).fill(1);
    const b = new Array<number>(n).fill(0);
    b[n - 1] = 1;
    const x = solve(A, b);
    if (x && x.every((v) => v > -1e-9)) limit = x.map((v) => Math.max(0, v));
  }
  if (!limit) {
    // Not unique (several closed classes): the long-run average from the start (exact limit when it converges).
    let d = d0;
    for (let t = 0; t < 2000; t++) d = step(d, P);
    const acc = new Array<number>(n).fill(0);
    const N = 2000;
    for (let t = 0; t < N; t++) {
      for (let i = 0; i < n; i++) acc[i] += d[i] / N;
      d = step(d, P);
    }
    limit = acc;
  }

  // Absorption: h_a(x) = P(end in a | start x) and E(x) = expected steps, over the transient states.
  const absorb = new Array<number>(n).fill(0);
  let expDuration = NaN;
  if (absorbing.some(Boolean)) {
    const T = Array.from({ length: n }, (_, i) => i).filter((i) => !absorbing[i]);
    if (absorbing[s.start]) {
      absorb[s.start] = 1;
      expDuration = 0;
    } else {
      const idx = new Map(T.map((s2, k) => [s2, k]));
      const A = T.map((i) => T.map((j) => (i === j ? 1 : 0) - P[i][j]));
      const E = solve(A, T.map(() => 1));
      if (E) expDuration = E[idx.get(s.start)!];
      for (let a = 0; a < n; a++) {
        if (!absorbing[a]) continue;
        const h = solve(A, T.map((i) => P[i][a]));
        absorb[a] = h ? h[idx.get(s.start)!] : limit[a];
      }
    }
  }

  // Walkers: each one plays the chain with the seeded generator.
  const W = Math.max(0, Math.min(5000, Math.floor(s.walkers)));
  const counts = Array.from({ length: s.horizon + 1 }, () => new Array<number>(n).fill(0));
  const absorbedAt = new Array<number>(s.horizon + 1).fill(0);
  const hit = new Array<number>(n).fill(0);
  const sample: number[] = [];
  let durSum = 0;
  let durN = 0;
  let budget = WALK_BUDGET;
  const anyAbsorbing = absorbing.some(Boolean);
  const cum = P.map((r) => {
    let c = 0;
    return r.map((p) => (c += p));
  });
  for (let w = 0; w < W; w++) {
    let x = s.start;
    let done = absorbing[x];
    let doneAt = done ? 0 : -1;
    for (let t = 0; ; t++) {
      if (t <= s.horizon) {
        counts[t][x]++;
        if (done) absorbedAt[t]++;
        if (w === 0) sample.push(x);
      }
      if (t >= s.horizon && (done || !anyAbsorbing || budget <= 0 || t >= s.horizon + 100000)) break;
      if (done) continue;
      budget--;
      const u = s.next();
      const y = cum[x].findIndex((c) => u < c);
      x = y < 0 ? n - 1 : y;
      if (absorbing[x]) {
        done = true;
        doneAt = t + 1;
      }
    }
    hit[x]++;
    if (doneAt >= 0) {
      durSum += doneAt;
      durN++;
    }
  }
  const emp = counts.map((r) => r.map((c) => (W ? c / W : 0)));
  return {
    names: s.names,
    P,
    absorbing,
    dist,
    emp,
    absorbedAt: absorbedAt.map((c) => (W ? c / W : 0)),
    limit,
    absorb,
    expDuration,
    hit: hit.map((c) => (W ? c / W : 0)),
    duration: durN ? durSum / durN : NaN,
    sample,
    walkers: W,
  };
}

export const MARKOV_VARS = ["step", "steps", "done", "t", "absorbed", "walkers", "expDuration", "duration"];
export const MARKOV_FNS = ["dist", "emp", "stat", "absorb", "hit", "prob"];
