// hash-chain engine: blocks linked by hashes (with an optional toy proof-of-work), or a Merkle tree with a
// proof path, tampering and pruning. The hash is a deterministic toy (FNV-1a, shown as a few hex digits).
// Pure TypeScript (no DOM): the validator runs it to know a config's final values.

import type { Value } from "./expr";

/** FNV-1a (32-bit) of a string, as `len` hex digits. */
export function toyHash(s: string, len = 4): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, Math.max(2, Math.min(8, len)));
}

export interface HashSetup {
  mode: "chain" | "merkle";
  records: string[];
  hashLen: number;
  difficulty: number;
  /** Record index changed after the chain/tree was built (−1: none) and its new value. */
  tamper: number;
  tamperValue?: string;
  /** chain: the attacker recomputes every block from the tampered one on (redoing the work). */
  redo: boolean;
  /** merkle: leaf whose proof path is checked (−1: none). */
  proof: number;
  /** merkle: leaves kept when the tree is pruned (null: no pruning step). */
  keep: number[] | null;
}

export interface Block {
  prev: string;
  data: string;
  nonce: number;
  hash: string;
  /** Meets the difficulty (leading zero digits). */
  work: boolean;
  /** Its stored prev equals the actual hash of the previous block. */
  link: boolean;
}
export interface MNode {
  name: string;
  hash: string;
}
export interface HashStep {
  blocks: Block[];
  shown: number;
  /** chain: highlighted block; merkle: highlighted level (or −1). */
  hot: number;
  tree: MNode[][];
  levels: number;
  /** merkle node keys "level:index": the path being recomputed, its siblings, changed nodes. */
  path: string[];
  sib: string[];
  changed: string[];
  /** merkle pruning: key → "stub" (hash kept, children dropped) | "gone"; empty = no pruning. */
  prune: Record<string, "stub" | "gone">;
  records: string[];
  msg: string;
  vars: Record<string, Value>;
}

const key = (l: number, i: number) => `${l}:${i}`;

function leafName(i: number) {
  return `Hash${i}`;
}

function buildTree(records: string[], len: number): MNode[][] {
  const levels: MNode[][] = [records.map((r, i) => ({ name: leafName(i), hash: toyHash(r, len) }))];
  const spans: [number, number][][] = [records.map((_, i) => [i, i])];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const sp = spans[spans.length - 1];
    const up: MNode[] = [];
    const upSp: [number, number][] = [];
    for (let i = 0; i < below.length; i += 2) {
      const a = below[i];
      const b = below[i + 1] ?? below[i]; // an odd node is paired with itself (as in Bitcoin)
      const span: [number, number] = [sp[i][0], (sp[i + 1] ?? sp[i])[1]];
      const digits = Array.from({ length: span[1] - span[0] + 1 }, (_, k) => span[0] + k).join("");
      up.push({ name: digits.length <= 4 ? `Hash${digits}` : `H${span[0]}–${span[1]}`, hash: toyHash(a.hash + b.hash, len) });
      upSp.push(span);
    }
    levels.push(up);
    spans.push(upSp);
  }
  const top = levels[levels.length - 1];
  if (levels.length > 1) top[0] = { ...top[0], name: "Root" };
  return levels;
}

function mine(prev: string, data: string, s: HashSetup): { nonce: number; hash: string; tries: number } {
  const zeros = "0".repeat(s.difficulty);
  for (let nonce = 0; nonce < 200000; nonce++) {
    const hash = toyHash(`${prev}|${data}|${nonce}`, s.hashLen);
    if (!s.difficulty || hash.startsWith(zeros)) return { nonce, hash, tries: nonce + 1 };
  }
  return { nonce: 0, hash: toyHash(`${prev}|${data}|0`, s.hashLen), tries: 200000 };
}

export function runHashChain(s: HashSetup): HashStep[] {
  const steps: HashStep[] = [];
  const records = [...s.records];
  const zeros = "0".repeat(s.difficulty);
  const meets = (h: string) => !s.difficulty || h.startsWith(zeros);

  if (s.mode === "chain") {
    const blocks: Block[] = [];
    let work = 0;
    let redoWork = 0;
    const check = () => {
      blocks.forEach((b, i) => {
        b.work = meets(b.hash);
        b.link = i === 0 ? b.prev === "0".repeat(b.prev.length) : b.prev === blocks[i - 1].hash;
      });
      const broken = blocks.findIndex((b, i) => i > 0 && !b.link);
      const weak = blocks.findIndex((b) => !b.work);
      return { broken, weak };
    };
    const push = (shown: number, hot: number, msg: string) => {
      const { broken, weak } = check();
      const vis = blocks.slice(0, shown);
      const valid = broken < 0 || broken >= shown ? (weak < 0 || weak >= shown ? 1 : 0) : 0;
      steps.push({
        blocks: blocks.map((b) => ({ ...b })),
        shown,
        hot,
        tree: [],
        levels: 0,
        path: [],
        sib: [],
        changed: [],
        prune: {},
        records: [...records],
        msg,
        vars: { blocks: vis.length, valid, brokenAt: broken >= 0 && broken < shown ? broken : -1, work, redoWork, tip: vis.at(-1)?.hash ?? "none", n: records.length },
      });
    };
    push(0, -1, `${records.length} records to chain`);
    records.forEach((data, i) => {
      const prev = i === 0 ? "0".repeat(s.hashLen) : blocks[i - 1].hash;
      const m = mine(prev, data, s);
      work += m.tries;
      blocks.push({ prev, data, nonce: m.nonce, hash: m.hash, work: true, link: true });
      push(i + 1, i, s.difficulty ? `block ${i}: tried ${m.tries} nonce${m.tries === 1 ? "" : "s"} until hash(prev, data, nonce) = ${m.hash} starts with ${zeros}` : `block ${i}: hash(prev ${prev}, data) = ${m.hash}`);
    });
    const t = s.tamper;
    if (t >= 0 && t < blocks.length) {
      const b = blocks[t];
      const value = s.tamperValue ?? `${b.data}*`;
      b.data = value;
      records[t] = value;
      b.hash = toyHash(`${b.prev}|${b.data}|${b.nonce}`, s.hashLen);
      const { broken } = check();
      push(blocks.length, t, `block ${t}'s data is changed to "${value}": its hash is now ${b.hash}${s.difficulty && !meets(b.hash) ? ` — no longer starts with ${zeros}` : ""}`);
      push(blocks.length, broken >= 0 ? broken : t, broken >= 0 ? `block ${broken} still stores prev = ${blocks[broken].prev} ≠ ${blocks[broken - 1].hash}: the chain is broken` : s.difficulty ? "the last block's work no longer checks out" : "the tip hash no longer matches the one others hold");
      if (s.redo) {
        for (let i = t; i < blocks.length; i++) {
          const prev = i === 0 ? "0".repeat(s.hashLen) : blocks[i - 1].hash;
          const m = mine(prev, blocks[i].data, s);
          redoWork += m.tries;
          Object.assign(blocks[i], { prev, nonce: m.nonce, hash: m.hash });
          push(blocks.length, i, `the attacker redoes block ${i}${s.difficulty ? `: ${m.tries} more tries` : ""} → ${m.hash}`);
        }
        push(blocks.length, -1, `consistent again, after redoing ${blocks.length - t} block${blocks.length - t === 1 ? "" : "s"} of work (${redoWork} tries)`);
      }
    }
    return steps;
  }

  // Merkle tree
  let tree = buildTree(records, s.hashLen);
  const rootHash = tree[tree.length - 1][0].hash;
  const empty = { blocks: [] as Block[], shown: 0 };
  const carry: Record<string, Value> = { proofLen: 0, verified: 0, pruned: 0, stubs: 0, kept: records.length };
  const push = (levels: number, hot: number, msg: string, extra: Partial<HashStep> = {}, more: Record<string, Value> = {}) => {
    const root = levels >= tree.length ? tree[tree.length - 1][0].hash : "none";
    Object.assign(carry, more);
    steps.push({
      ...empty,
      hot,
      tree: tree.map((l) => l.map((n) => ({ ...n }))),
      levels,
      path: [],
      sib: [],
      changed: [],
      prune: {},
      records: [...records],
      msg,
      ...extra,
      vars: { n: records.length, root, valid: root === rootHash ? 1 : 0, depth: tree.length - 1, ...carry },
    });
  };
  push(0, -1, `${records.length} transactions`);
  for (let l = 0; l < tree.length; l++) push(l + 1, l, l === 0 ? "hash each transaction" : l === tree.length - 1 ? `hash the last pair: Root = ${rootHash}` : `hash pairs into level ${l}${tree[l - 1].length % 2 ? " (an odd node is paired with itself)" : ""}`);

  const pathOf = (leaf: number) => {
    const path: string[] = [];
    const sib: string[] = [];
    let i = leaf;
    for (let l = 0; l < tree.length; l++) {
      path.push(key(l, i));
      if (l < tree.length - 1) sib.push(key(l, Math.min(i ^ 1, tree[l].length - 1)));
      i = Math.floor(i / 2);
    }
    return { path, sib };
  };

  if (s.proof >= 0 && s.proof < records.length) {
    const { path, sib } = pathOf(s.proof);
    const proofLen = tree.length - 1;
    push(tree.length, 0, `prove Tx${s.proof} is in the tree: its hash plus ${proofLen} sibling hash${proofLen === 1 ? "" : "es"}`, { path: path.slice(0, 1), sib }, { proofLen });
    for (let l = 1; l < tree.length; l++) {
      const [, si] = sib[l - 1].split(":").map(Number);
      push(tree.length, l, `combine with ${tree[l - 1][si].name} → ${tree[l][Number(path[l].split(":")[1])].name} = ${tree[l][Number(path[l].split(":")[1])].hash}`, { path: path.slice(0, l + 1), sib }, { proofLen });
    }
    push(tree.length, -1, `recomputed root ${rootHash} = the root in the block header: Tx${s.proof} is included`, { path, sib }, { proofLen, verified: 1 });
  }

  if (s.tamper >= 0 && s.tamper < records.length) {
    const old = tree.map((l) => l.map((n) => n.hash));
    records[s.tamper] = s.tamperValue ?? `${records[s.tamper]}*`;
    tree = buildTree(records, s.hashLen);
    const changed = tree.flatMap((l, li) => l.flatMap((n, i) => (n.hash !== old[li][i] ? [key(li, i)] : [])));
    const newRoot = tree[tree.length - 1][0].hash;
    push(tree.length, -1, `Tx${s.tamper} is altered: ${changed.length} hashes change up to the root (${newRoot} ≠ ${rootHash} in the header)`, { changed }, { verified: 0 });
  }

  if (s.keep) {
    const keep = s.keep.filter((k) => k >= 0 && k < records.length);
    const needed = new Set<string>();
    for (const k of keep) for (const p of pathOf(k).path) needed.add(p);
    const prune: Record<string, "stub" | "gone"> = {};
    for (let l = tree.length - 1; l >= 0; l--)
      tree[l].forEach((_, i) => {
        const k = key(l, i);
        if (needed.has(k)) return;
        const parent = key(l + 1, Math.floor(i / 2));
        prune[k] = l < tree.length - 1 && needed.has(parent) ? "stub" : "gone";
      });
    const stubs = Object.values(prune).filter((v) => v === "stub").length;
    push(tree.length, -1, `keep ${keep.map((k) => `Tx${k}`).join(", ") || "nothing"}: the other transactions and the hashes below the stubs are discarded${s.tamper >= 0 && s.tamper < records.length ? "" : "; the root still checks"}`, { prune }, { pruned: records.length - keep.length, stubs, kept: keep.length });
  }
  return steps;
}

export const HASH_VARS = ["step", "steps", "done", "n", "blocks", "valid", "brokenAt", "work", "redoWork", "tip", "root", "proofLen", "verified", "pruned", "stubs", "kept", "depth"];
