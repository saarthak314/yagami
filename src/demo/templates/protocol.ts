// message-sequence engine: nodes exchanging messages over rounds, played from a scripted scenario.
// Built-in protocols (paxos, raft, flood) apply the real rules to each delivered message, so a scenario
// only says who acts when (and what is lost or crashes); "script" plays messages and state changes as given.
// Pure TypeScript (no DOM): the validator runs it to know a scenario's final values.

import type { Value } from "./expr";

export const PROTOCOLS = ["paxos", "raft", "flood", "script"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export interface MsgEvent {
  do: string;
  by?: string | string[];
  node?: string;
  to?: string | string[];
  n?: number;
  value?: string | string[];
  lose?: string[];
  loseReply?: string[];
  msg?: string;
  reply?: string;
  set?: Record<string, Record<string, string | number>>;
  note?: string;
}

export const PROTOCOL_EVENTS: Record<Protocol, string[]> = {
  paxos: ["prepare", "accept", "crash", "recover", "note"],
  raft: ["timeout", "client", "replicate", "crash", "recover", "note"],
  flood: ["mine", "crash", "recover", "note"],
  script: ["send", "set", "crash", "recover", "note"],
};

export interface SeqSetup {
  protocol: Protocol;
  nodes: string[];
  acceptors?: string[];
  logs?: Record<string, number[]>;
  terms?: Record<string, number>;
  links?: [string, string][];
  state?: Record<string, Record<string, string | number>>;
  events: MsgEvent[];
}

export interface SeqMsg {
  from: string;
  to: string;
  label: string;
  lost: boolean;
  /** false: a refusal (nack, vote no, ignored block). */
  ok: boolean;
}
export interface LogEntry {
  term: number;
  cmd: string;
}
export interface NodeView {
  up: boolean;
  role: string;
  lines: string[];
  log?: LogEntry[];
  commit?: number;
  chain?: string[];
}
export interface SeqStep {
  msgs: SeqMsg[];
  note: string;
  /** Node → a short marker drawn on its lifeline this step ("crash", "leader", "chosen" …). */
  marks: Record<string, string>;
  nodes: Record<string, NodeView>;
  state: Record<string, Record<string, Value>>;
  vars: Record<string, Value>;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const MAX_STEPS = 160;

/** Play a scenario: one step per message round (requests, then replies), plus state-only steps. */
export function runProtocol(s: SeqSetup): SeqStep[] {
  const nodes = s.nodes;
  const up: Record<string, boolean> = Object.fromEntries(nodes.map((n) => [n, true]));
  const steps: SeqStep[] = [];
  let messages = 0;
  let lost = 0;
  const live = (n: string) => !!up[n];

  // Protocol state
  const proposers = [...new Set(s.events.flatMap((e) => (e.do === "prepare" || e.do === "accept" ? list(e.by) : [])))];
  const acceptors = s.acceptors?.length ? s.acceptors : nodes.filter((n) => !proposers.includes(n));
  const pax = {
    acc: Object.fromEntries(acceptors.map((a) => [a, { promised: 0, accN: 0, accV: "none" }])),
    prop: Object.fromEntries(proposers.map((p) => [p, { n: 0, value: "none", promises: [] as { from: string; accN: number; accV: string }[], accepts: 0, proposed: "none" }])),
    chosen: "none",
    chosenN: 0,
    last: proposers[0] ?? "",
  };
  const majority = (k: number) => Math.floor(k / 2) + 1;

  interface RS {
    term: number;
    role: "follower" | "candidate" | "leader";
    votedFor: string | null;
    log: LogEntry[];
    commit: number;
    votes: number;
    next: Record<string, number>;
    match: Record<string, number>;
  }
  const raft: Record<string, RS> = Object.fromEntries(
    nodes.map((n) => {
      const log = (s.logs?.[n] ?? []).map((t) => ({ term: t, cmd: "" }));
      return [n, { term: s.terms?.[n] ?? (log.at(-1)?.term ?? 0), role: "follower", votedFor: null, log, commit: 0, votes: 0, next: {}, match: {} } as RS];
    }),
  );
  let candidate = "";

  const links = s.links?.length ? s.links : nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => [a, b] as [string, string]));
  const adj: Record<string, string[]> = Object.fromEntries(nodes.map((n) => [n, [] as string[]]));
  for (const [a, b] of links) {
    adj[a]?.push(b);
    adj[b]?.push(a);
  }
  const chains: Record<string, string[]> = Object.fromEntries(nodes.map((n) => [n, [] as string[]]));
  let lastMined = "none";

  const script: Record<string, Record<string, Value>> = Object.fromEntries(nodes.map((n) => [n, { ...(s.state?.[n] ?? {}) }]));

  // Views and variables
  const raftLeader = () => {
    const ls = nodes.filter((n) => live(n) && raft[n].role === "leader").sort((a, b) => raft[b].term - raft[a].term);
    return ls[0] ?? "";
  };
  const stateOf = (): Record<string, Record<string, Value>> => {
    const out: Record<string, Record<string, Value>> = {};
    for (const n of nodes) {
      const base: Record<string, Value> = { up: live(n) ? 1 : 0 };
      if (s.protocol === "paxos") {
        const a = pax.acc[n];
        const p = pax.prop[n];
        if (a) Object.assign(base, { promised: a.promised, acceptedN: a.accN, acceptedV: a.accV });
        if (p) Object.assign(base, { n: p.n, value: p.proposed !== "none" ? p.proposed : p.value, promises: p.promises.length, accepts: p.accepts });
      } else if (s.protocol === "raft") {
        const r = raft[n];
        Object.assign(base, { term: r.term, role: live(n) ? r.role : "down", votedFor: r.votedFor ?? "none", commit: r.commit, log: r.log.length, lastTerm: r.log.at(-1)?.term ?? 0, votes: r.votes });
      } else if (s.protocol === "flood") Object.assign(base, { height: chains[n].length, tip: chains[n].at(-1) ?? "none" });
      else Object.assign(base, script[n]);
      out[n] = base;
    }
    return out;
  };
  const views = (): Record<string, NodeView> => {
    const out: Record<string, NodeView> = {};
    for (const n of nodes) {
      const v: NodeView = { up: live(n), role: "", lines: [] };
      if (s.protocol === "paxos") {
        const a = pax.acc[n];
        const p = pax.prop[n];
        if (p) {
          v.role = "proposer";
          v.lines = [p.n ? `n = ${p.n}` : "idle", p.proposed !== "none" ? `proposes ${p.proposed}` : `${p.promises.length} promise${p.promises.length === 1 ? "" : "s"}`];
        } else if (a) {
          v.role = "acceptor";
          v.lines = [`promised ${a.promised || "–"}`, a.accN ? `acc ${a.accN}: ${a.accV}` : "acc –"];
        }
      } else if (s.protocol === "raft") {
        const r = raft[n];
        v.role = r.role;
        v.lines = [`term ${r.term}`, `voted ${r.votedFor ?? "–"}`];
        v.log = r.log.map((e) => ({ ...e }));
        v.commit = r.commit;
      } else if (s.protocol === "flood") {
        v.role = "node";
        v.lines = [`height ${chains[n].length}`];
        v.chain = [...chains[n]];
      } else {
        v.role = String(script[n].role ?? "");
        v.lines = Object.entries(script[n])
          .filter(([k]) => k !== "role")
          .slice(0, 2)
          .map(([k, x]) => `${k} ${x}`);
      }
      out[n] = v;
    }
    return out;
  };
  const vars = (): Record<string, Value> => {
    const v: Record<string, Value> = { messages, lost, up: nodes.filter(live).length, nodes: nodes.length };
    if (s.protocol === "paxos") {
      const p = pax.prop[pax.last];
      Object.assign(v, {
        chosen: pax.chosen,
        chosenN: pax.chosenN,
        quorum: majority(acceptors.length),
        acceptors: acceptors.length,
        n: p?.n ?? 0,
        value: p ? (p.proposed !== "none" ? p.proposed : p.value) : "none",
        promises: p?.promises.length ?? 0,
        accepts: p?.accepts ?? 0,
        promised: Math.max(0, ...acceptors.map((a) => pax.acc[a].promised)),
      });
    } else if (s.protocol === "raft") {
      const l = raftLeader();
      Object.assign(v, {
        term: l ? raft[l].term : Math.max(0, ...nodes.map((n) => raft[n].term)),
        leader: l || "none",
        leaders: nodes.filter((n) => live(n) && raft[n].role === "leader").length,
        committed: Math.max(0, ...nodes.map((n) => raft[n].commit)),
        lastIndex: l ? raft[l].log.length : Math.max(0, ...nodes.map((n) => raft[n].log.length)),
        votes: candidate ? raft[candidate].votes : 0,
        quorum: majority(nodes.length),
      });
    } else if (s.protocol === "flood") {
      const tips = new Set(nodes.filter(live).map((n) => chains[n].at(-1) ?? "none"));
      Object.assign(v, {
        height: Math.max(0, ...nodes.map((n) => chains[n].length)),
        reached: nodes.filter((n) => chains[n].includes(lastMined)).length,
        forks: tips.size,
        agree: tips.size === 1 ? 1 : 0,
        tip: lastMined,
      });
    }
    return v;
  };
  const push = (msgs: SeqMsg[], note: string, marks: Record<string, string> = {}) => {
    for (const m of msgs) {
      messages++;
      if (m.lost) lost++;
    }
    if (steps.length < MAX_STEPS) steps.push({ msgs, note, marks, nodes: views(), state: stateOf(), vars: vars() });
  };
  const msg = (from: string, to: string, label: string, lostIf: boolean, ok = true): SeqMsg => ({ from, to, label, lost: lostIf || !live(to) || !live(from), ok });

  push([], "start");

  for (const ev of s.events) {
    let noted = false;
    const say = (auto: string) => {
      if (ev.note && !noted) {
        noted = true;
        return ev.note;
      }
      return auto;
    };
    const lose = new Set(ev.lose ?? []);
    const loseReply = new Set(ev.loseReply ?? []);
    if (ev.do === "crash" || ev.do === "recover") {
      const n = ev.node ?? list(ev.by)[0];
      if (!n || !(n in up)) continue;
      up[n] = ev.do === "recover";
      if (s.protocol === "raft" && ev.do === "recover") {
        raft[n].role = "follower";
        raft[n].commit = 0; // volatile state is lost; term, vote and log are on stable storage
      }
      if (s.protocol === "raft" && ev.do === "crash") raft[n].role = "follower";
      push([], say(ev.do === "crash" ? `${n} crashes` : `${n} recovers${s.protocol === "raft" ? " as a follower (term, vote and log survive)" : s.protocol === "paxos" ? " (its promises and accepts survive on stable storage)" : ""}`), { [n]: ev.do === "crash" ? "✕ crash" : "recover" });
      continue;
    }
    if (ev.do === "note") {
      push([], ev.note ?? "");
      continue;
    }

    if (s.protocol === "paxos") {
      const P = list(ev.by)[0];
      const p = pax.prop[P];
      if (!p) continue;
      pax.last = P;
      const targets = (ev.to ? list(ev.to) : acceptors).filter((a) => pax.acc[a]);
      if (!live(P)) {
        push([], say(`${P} is down: nothing is sent`));
        continue;
      }
      if (ev.do === "prepare") {
        const n = ev.n ?? p.n + 1;
        p.n = n;
        p.promises = [];
        p.accepts = 0;
        p.proposed = "none";
        if (ev.value !== undefined) p.value = list(ev.value)[0];
        const req = targets.map((a) => msg(P, a, `prepare ${n}`, lose.has(a)));
        push(req, say(`${P} sends prepare(${n}) to ${targets.length === acceptors.length ? "all acceptors" : targets.join(", ")}`));
        const reps: SeqMsg[] = [];
        for (const r of req) {
          if (r.lost) continue;
          const a = pax.acc[r.to];
          if (n > a.promised) {
            a.promised = n;
            const m = msg(r.to, P, a.accN ? `promise ${n} (${a.accN},${a.accV})` : `promise ${n}`, loseReply.has(r.to));
            if (!m.lost) p.promises.push({ from: r.to, accN: a.accN, accV: a.accV });
            reps.push(m);
          } else reps.push(msg(r.to, P, `nack ${a.promised}`, loseReply.has(r.to), false));
        }
        const k = p.promises.length;
        const q = majority(acceptors.length);
        const prior = p.promises.filter((x) => x.accN).sort((a, b) => b.accN - a.accN)[0];
        push(
          reps,
          say(
            `${P} has ${k} of ${acceptors.length} promises for ${n}${k >= q ? ` — a majority${prior ? `; the highest accepted proposal is ${prior.accN} with value ${prior.accV}` : "; none has accepted anything"}` : ` — needs ${q}`}`,
          ),
        );
      } else if (ev.do === "accept") {
        const q = majority(acceptors.length);
        if (p.promises.length < q) {
          push([], say(`${P} has only ${p.promises.length} promise${p.promises.length === 1 ? "" : "s"} for ${p.n} (needs ${q}): it cannot send accept requests`));
          continue;
        }
        const prior = p.promises.filter((x) => x.accN).sort((a, b) => b.accN - a.accN)[0];
        if (ev.value !== undefined) p.value = list(ev.value)[0];
        const v = prior ? prior.accV : p.value;
        p.proposed = v;
        p.accepts = 0;
        const dest = ev.to ? targets : p.promises.map((x) => x.from);
        const req = dest.map((a) => msg(P, a, `accept ${p.n}: ${v}`, lose.has(a)));
        push(
          req,
          say(prior ? `P2c: ${P} must propose ${v}, the value of the highest-numbered accepted proposal (${prior.accN}) among its promises` : `${P} proposes its own value ${v} (no promise reported an accepted value)`),
        );
        const reps: SeqMsg[] = [];
        for (const r of req) {
          if (r.lost) continue;
          const a = pax.acc[r.to];
          if (p.n >= a.promised) {
            a.promised = p.n;
            a.accN = p.n;
            a.accV = v;
            const m = msg(r.to, P, `accepted ${p.n}`, loseReply.has(r.to));
            if (!m.lost) p.accepts++;
            reps.push(m);
          } else reps.push(msg(r.to, P, `nack ${a.promised}`, loseReply.has(r.to), false));
        }
        const count = acceptors.filter((a) => pax.acc[a].accN === p.n).length;
        const marks: Record<string, string> = {};
        if (count >= q && pax.chosen === "none") {
          pax.chosen = v;
          pax.chosenN = p.n;
          marks[P] = `chosen: ${v}`;
        }
        push(
          reps,
          say(count >= q ? `${count} of ${acceptors.length} acceptors accepted proposal ${p.n}: value ${v} is chosen` : `only ${count} of ${acceptors.length} acceptors accepted proposal ${p.n} (needs ${q}): nothing chosen by it`),
          marks,
        );
      }
    } else if (s.protocol === "raft") {
      const others = (n: string) => nodes.filter((x) => x !== n);
      const q = majority(nodes.length);
      if (ev.do === "timeout") {
        const S = ev.node ?? list(ev.by)[0];
        const c = raft[S];
        if (!c) continue;
        if (!live(S)) {
          push([], say(`${S} is down`));
          continue;
        }
        c.term++;
        c.role = "candidate";
        c.votedFor = S;
        c.votes = 1;
        candidate = S;
        const lastIdx = c.log.length;
        const lastTerm = c.log.at(-1)?.term ?? 0;
        const req = (ev.to ? list(ev.to) : others(S)).map((r) => msg(S, r, `RequestVote ${c.term}`, lose.has(r)));
        push(req, say(`${S} times out: candidate for term ${c.term}, votes for itself`), { [S]: "timeout" });
        const reps: SeqMsg[] = [];
        const refused: string[] = [];
        for (const r of req) {
          if (r.lost) continue;
          const f = raft[r.to];
          if (c.term > f.term) {
            f.term = c.term;
            f.role = "follower";
            f.votedFor = null;
          }
          const fLastTerm = f.log.at(-1)?.term ?? 0;
          const upToDate = lastTerm > fLastTerm || (lastTerm === fLastTerm && lastIdx >= f.log.length);
          const grant = c.term === f.term && (f.votedFor === null || f.votedFor === S) && upToDate;
          if (grant) f.votedFor = S;
          else if (!upToDate) refused.push(r.to);
          reps.push(msg(r.to, S, grant ? `yes ${f.term}` : `no ${f.term}`, loseReply.has(r.to), grant));
        }
        for (const m of reps) {
          if (m.lost) continue;
          const t = Number(m.label.split(" ")[1]);
          if (t > c.term) {
            c.term = t;
            c.role = "follower";
            c.votedFor = null;
          } else if (m.ok && c.role === "candidate") c.votes++;
        }
        let note: string;
        const marks: Record<string, string> = {};
        if (c.role === "candidate" && c.votes >= q) {
          c.role = "leader";
          for (const f of others(S)) {
            c.next[f] = c.log.length + 1;
            c.match[f] = 0;
          }
          marks[S] = "leader";
          note = `${S} has ${c.votes} of ${nodes.length} votes: leader for term ${c.term}`;
        } else if (c.role === "follower") note = `${S} saw a higher term and steps down`;
        else note = `${S} has ${c.votes} of ${nodes.length} votes (needs ${q}): no leader this term${refused.length ? ` — ${refused.join(", ")} refused: their logs are more up-to-date` : ""}`;
        push(reps, say(note), marks);
      } else if (ev.do === "client") {
        const L = ev.node ?? raftLeader();
        if (!L || !live(L) || raft[L].role !== "leader") {
          push([], say("no leader to take the client's command"));
          continue;
        }
        const vals = list(ev.value).length ? list(ev.value) : ["x"];
        for (const v of vals) raft[L].log.push({ term: raft[L].term, cmd: v });
        push([], say(`client → ${L}: ${vals.join(", ")} appended at index ${raft[L].log.length - vals.length + 1}${vals.length > 1 ? `–${raft[L].log.length}` : ""} (term ${raft[L].term}), not yet committed`), { [L]: `+${vals.join(",")}` });
      } else if (ev.do === "replicate") {
        const L = ev.node ?? raftLeader();
        if (!L || !live(L) || raft[L].role !== "leader") {
          push([], say("no live leader to replicate"));
          continue;
        }
        const ld = raft[L];
        const targets = ev.to ? list(ev.to) : others(L);
        for (let round = 0; round < 8; round++) {
          const req: SeqMsg[] = [];
          const sent: Record<string, { prev: number; n: number }> = {};
          for (const f of targets) {
            const next = ld.next[f] ?? ld.log.length + 1;
            const prev = next - 1;
            const n = ld.log.length - prev;
            sent[f] = { prev, n };
            req.push(msg(L, f, n > 0 ? `append ${prev + 1}${n > 1 ? `–${prev + n}` : ""}` : "heartbeat", lose.has(f)));
          }
          push(req, say(round ? `${L} retries with earlier entries` : `${L} sends AppendEntries (term ${ld.term}, commit ${ld.commit})`));
          const reps: SeqMsg[] = [];
          for (const r of req) {
            if (r.lost) continue;
            const f = raft[r.to];
            const { prev, n } = sent[r.to];
            if (ld.term < f.term) {
              reps.push(msg(r.to, L, `no ${f.term}`, loseReply.has(r.to), false));
              continue;
            }
            f.term = ld.term;
            f.role = "follower";
            const ok = prev === 0 || (f.log.length >= prev && f.log[prev - 1].term === ld.log[prev - 1].term);
            if (ok) {
              for (let k = 0; k < n; k++) {
                const idx = prev + k; // 0-based
                const e = ld.log[idx];
                if (f.log[idx] && f.log[idx].term !== e.term) f.log.length = idx;
                if (!f.log[idx]) f.log.push({ ...e });
              }
              f.commit = Math.max(f.commit, Math.min(ld.commit, prev + n));
              reps.push(msg(r.to, L, `ok ${prev + n}`, loseReply.has(r.to)));
            } else reps.push(msg(r.to, L, `no (prev ${prev})`, loseReply.has(r.to), false));
          }
          let retry = false;
          for (const m of reps) {
            if (m.lost) continue;
            if (m.label.startsWith("no ") && !m.label.startsWith("no (")) {
              const t = Number(m.label.split(" ")[1]);
              if (t > ld.term) {
                ld.term = t;
                ld.role = "follower";
              }
            } else if (m.ok) {
              const idx = Number(m.label.split(" ")[1]);
              ld.match[m.from] = idx;
              ld.next[m.from] = idx + 1;
            } else {
              ld.next[m.from] = Math.max(1, (ld.next[m.from] ?? ld.log.length + 1) - 1);
              retry = true;
            }
          }
          const before = ld.commit;
          if (ld.role === "leader")
            for (let N = ld.log.length; N > ld.commit; N--) {
              const count = 1 + others(L).filter((f) => (ld.match[f] ?? 0) >= N).length;
              if (ld.log[N - 1].term === ld.term && count >= q) {
                ld.commit = N;
                break;
              }
            }
          const acks = reps.filter((m) => !m.lost && m.ok).length;
          const stale = ld.log.slice(before).some((e, i) => e.term !== ld.term && 1 + others(L).filter((f) => (ld.match[f] ?? 0) >= before + i + 1).length >= q);
          let note = ld.role !== "leader" ? `${L} learns of a higher term and steps down` : `${acks} follower${acks === 1 ? "" : "s"} acknowledged`;
          if (ld.role === "leader") {
            if (ld.commit > before) note += `: entries up to ${ld.commit} are on a majority — committed`;
            else if (stale) note += `: older-term entries are on a majority but are not committed by counting replicas`;
            else if (retry) note += `; mismatches step nextIndex back`;
          }
          push(reps, say(note), ld.commit > before ? { [L]: `commit ${ld.commit}` } : {});
          if (!retry || ld.role !== "leader") break;
        }
      }
    } else if (s.protocol === "flood") {
      if (ev.do !== "mine") continue;
      const miners = list(ev.by);
      const vals = list(ev.value);
      const marks: Record<string, string> = {};
      let senders: { node: string; from: string }[] = [];
      miners.forEach((m, i) => {
        if (!live(m)) return;
        const v = vals[i] ?? vals[0] ?? `B${chains[m].length + 1}`;
        chains[m] = [...chains[m], v];
        lastMined = v;
        marks[m] = `mines ${v}`;
        senders.push({ node: m, from: "" });
      });
      push([], say(`${miners.filter(live).join(" and ")} mine${miners.length === 1 ? "s" : ""} ${vals.join(" and ")}`), marks);
      for (let round = 0; round < 8 && senders.length; round++) {
        const req: SeqMsg[] = [];
        const carried: SeqMsg[] = [];
        const chainOf = new Map<SeqMsg, string[]>();
        for (const { node, from } of senders)
          for (const nb of adj[node] ?? []) {
            if (nb === from) continue;
            const m = msg(node, nb, chains[node].at(-1) ?? "", lose.has(nb));
            chainOf.set(m, [...chains[node]]);
            req.push(m);
          }
        const next: { node: string; from: string }[] = [];
        for (const m of req) {
          if (m.lost) continue;
          const c = chainOf.get(m)!;
          if (c.length > chains[m.to].length) {
            chains[m.to] = c;
            next.push({ node: m.to, from: m.from });
          } else m.ok = false;
          carried.push(m);
        }
        const adopted = next.length;
        push(req, say(`round ${round + 1}: ${adopted} node${adopted === 1 ? "" : "s"} adopt a longer chain${req.some((m) => !m.ok) ? "; shorter or equal chains are ignored" : ""}`));
        senders = next;
      }
    } else {
      if (ev.do === "set") {
        for (const [n, kv] of Object.entries(ev.set ?? {})) if (script[n]) Object.assign(script[n], kv);
        push([], say(ev.note ?? "state changes"));
        continue;
      }
      const from = list(ev.by)[0] ?? ev.node ?? nodes[0];
      const to = ev.to === "*" || ev.to === undefined ? nodes.filter((n) => n !== from) : list(ev.to);
      const req = to.map((t) => msg(from, t, ev.msg ?? "msg", lose.has(t)));
      if (!ev.reply) for (const [n, kv] of Object.entries(ev.set ?? {})) if (script[n]) Object.assign(script[n], kv);
      push(req, say(`${from} → ${to.join(", ")}: ${ev.msg ?? "msg"}`));
      if (ev.reply) {
        const reps = req.filter((r) => !r.lost).map((r) => msg(r.to, from, ev.reply!, loseReply.has(r.to)));
        for (const [n, kv] of Object.entries(ev.set ?? {})) if (script[n]) Object.assign(script[n], kv);
        push(reps, say(`${reps.filter((m) => !m.lost).length} repl${reps.length === 1 ? "y" : "ies"}: ${ev.reply}`));
      }
    }
  }
  return steps;
}

/** The names a protocol's readouts can use (besides step, steps, done). */
export const PROTOCOL_VARS: Record<Protocol, string[]> = {
  paxos: ["chosen", "chosenN", "quorum", "acceptors", "n", "value", "promises", "accepts", "promised"],
  raft: ["term", "leader", "leaders", "committed", "lastIndex", "votes", "quorum"],
  flood: ["height", "reached", "forks", "agree", "tip"],
  script: [],
};
export const SEQ_COMMON_VARS = ["step", "steps", "done", "messages", "lost", "up", "nodes"];
