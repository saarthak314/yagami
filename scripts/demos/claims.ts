// Caption claims checked against the readouts over time (no model). A caption that says a readout
// rises, falls, or stays below/above a value or another readout must agree with what the readouts
// show while the beat runs. Audits found the reviewer passing "the loss jumps up" while the loss
// fell 1.70 → 0.33, and "stays below the bound" while the frequency sat at 4× the bound.

import type { ReadoutSpec } from "../../src/types";
import { numbersIn } from "./verify";

export interface Sample {
  t: number;
  readouts: Record<string, string>;
}

const UP = /\b(rises?|rising|rose|increases?|increasing|grows?|growing|climbs?|climbing|jumps? up|goes up|shoots up|spikes?|blows? up)\b/i;
const DOWN = /\b(falls?|falling|fell|drops?|dropping|decreases?|decreasing|shrinks?|shrinking|declines?|declining|decays?|decaying|goes down|vanishes|collapses?)\b/i;
const BELOW = /^(?:stays?|remains?|keeps?|is|sits?|holds?)?\s*(?:well\s+|safely\s+|always\s+)?(?:below|under|beneath|at most|no more than|never (?:exceeds|goes above|rises above|crosses))\b/i;
const ABOVE = /^(?:stays?|remains?|keeps?|is|sits?|holds?)?\s*(?:well\s+|safely\s+|always\s+)?(?:above|over|at least|no less than|never (?:drops|falls|goes) below)\b/i;
/** Words that make a trend conditional, comparative or negated: not a claim about this beat over time. */
const HEDGED = /\b(not|never|no longer|doesn'?t|does not|don'?t|barely|hardly|without|as|when|whenever|if|than|compared|faster|slower|until|would|could|might|with (?:larger|smaller|more|fewer|higher|lower)|you)\b/i;
/** A mention inside these is about something else ("the gap between A and B", "A versus B"). */
const OF_SOMETHING = /(?:\b(between|of|than|versus|vs|against|over|per|minus|plus)\s+(?:the\s+|a\s+|its\s+)?|\bbetween\b[^.,;]*\b(?:and|or)\s+(?:the\s+|a\s+|its\s+)?)$/i;
const NUM = /^(?:the\s+)?(?:value\s+)?(?:of\s+)?(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*(%?)/i;

/** A readout label as caption text: words without LaTeX, or the LaTeX itself. */
function mentions(caption: string, r: ReadoutSpec): { start: number; end: number }[] {
  const forms = new Set<string>();
  const plain = r.label
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-z]+/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (plain.length >= 3 && !/^(value|count|total|number|step|steps|time|t)$/.test(plain)) forms.add(plain);
  for (const m of r.label.matchAll(/\$[^$]+\$/g)) if (m[0].length >= 4) forms.add(m[0].toLowerCase());
  // Captions often name a readout by what its id says ("the loss" for id "loss", label "$f(\theta_t)$").
  const id = r.id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  if (/^[a-z]{3,}( [a-z]{3,})?$/.test(id) && !/^(value|count|total|number|step|steps|time|sum|min|max)$/.test(id)) forms.add(id);
  const low = caption.toLowerCase();
  const out: { start: number; end: number }[] = [];
  for (const f of forms) {
    const word = /^\w/.test(f) ? "\\b" : "";
    const re = new RegExp(`${word}${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${/\w$/.test(f) ? "\\b" : ""}`, "g");
    for (const m of low.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The rest of the clause after a mention (up to . ; , or a contrast word). */
function clauseAfter(caption: string, end: number): string {
  const rest = caption.slice(end, end + 80);
  const cut = rest.search(/[.;:,]\s|[.;]$|\b(but|while|whereas|and then|then)\b/i);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

/** First number of a readout's text at each sample (NaN when none). */
function series(samples: Sample[], id: string): number[] {
  return samples.map((s) => (s.readouts[id] === undefined ? NaN : (numbersIn(s.readouts[id])[0] ?? NaN)));
}

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toPrecision(3) : String(Math.round(v * 1000) / 1000));
const q = (s: string) => `"${s.length > 50 ? s.slice(0, 49) + "…" : s}"`;

/** Notes for caption claims the readouts contradict (empty when none, or nothing checkable). */
export function claimNotes(caption: string, readouts: ReadoutSpec[], samples: Sample[]): string[] {
  const out: string[] = [];
  if (samples.length < 3) return out;
  const span = `${samples[0].t}–${samples[samples.length - 1].t} s`;
  for (const r of readouts) {
    const v = series(samples, r.id);
    const known = v.filter(Number.isFinite);
    if (known.length < 3) continue;
    for (const m of mentions(caption, r)) {
      if (OF_SOMETHING.test(caption.slice(Math.max(0, m.start - 40), m.start))) continue;
      const clause = clauseAfter(caption, m.end);
      // Trend: "<readout> rises / falls", the verb within three words of the mention.
      const lead = clause.slice(0, 40);
      const up = UP.exec(lead);
      const down = DOWN.exec(lead);
      const hit = up && (!down || up.index < down.index) ? { dir: "up" as const, m: up } : down ? { dir: "down" as const, m: down } : null;
      const before = clause.slice(0, hit?.m.index ?? 0);
      // The mention is the verb's subject: at most three words between, not part of "A and B", and no
      // condition, comparison or negation anywhere in the clause.
      if (hit && before.trim().split(/\s+/).filter(Boolean).length <= 3 && !/\b(and|or|with)\b/i.test(before) && !HEDGED.test(clause)) {
        const first = known[0];
        const rest = known.slice(1);
        const tol = Math.max(1e-9, 0.01 * Math.abs(first));
        // A flat readout is a state, not a trend: "collapses"/"drops" then contrasts it with another
        // beat or setting. A sudden rise ("spikes", "jumps up") may be over before the first sample:
        // a start well above the rest shows it.
        const flat = Math.max(...known) - Math.min(...known) <= tol;
        const sorted = [...rest].sort((a, b) => a - b);
        const sudden = hit.dir === "up" && /spike|jump|shoot|blow/i.test(hit.m[0]) && first >= 1.5 * sorted[Math.floor(sorted.length / 2)];
        const contradicted = !flat && !sudden && (hit.dir === "up" ? Math.max(...rest) <= first + tol : Math.min(...rest) >= first - tol);
        if (contradicted) {
          out.push(
            `the caption says ${q(r.label)} ${hit.m[0].toLowerCase()} (${q(caption.slice(m.start, m.end + hit.m.index + hit.m[0].length))}), but over ${span} the readout ${hit.dir === "up" ? "never rises above" : "never falls below"} its first value (${fmt(known[0])} → ${known.slice(1).map(fmt).slice(-3).join(", ")}). Make the caption match the readout, or the demo show the ${hit.dir === "up" ? "rise" : "fall"} slowly enough to see`,
          );
          break;
        }
      }
      // Bound: "<readout> stays below 0.5" / "… below <other readout>".
      for (const [re, dir] of [
        [BELOW, "below"],
        [ABOVE, "above"],
      ] as const) {
        const b = re.exec(clause.trim());
        if (!b) continue;
        const after = clause.trim().slice(b[0].length).trim();
        let target: number[] | null = null;
        let what = "";
        const n = NUM.exec(after);
        if (n) {
          const x = Number(n[1]);
          target = samples.map(() => (n[2] && !samples.some((s) => /%/.test(s.readouts[r.id] ?? "")) ? x / 100 : x));
          what = n[0].trim();
        } else {
          const other = readouts.find((o) => o.id !== r.id && mentions(after.slice(0, 40), o).some((mm) => mm.start <= 12));
          if (other) {
            target = series(samples, other.id);
            what = other.label;
          }
        }
        if (!target) continue;
        const bad = samples.findIndex((s, i) => {
          const a = v[i];
          const t = target![i];
          if (!Number.isFinite(a) || !Number.isFinite(t)) return false;
          const tol = Math.max(1e-9, 0.01 * Math.abs(t));
          return dir === "below" ? a > t + tol : a < t - tol;
        });
        if (bad >= 0) {
          out.push(
            `the caption says ${q(r.label)} stays ${dir} ${q(what)}, but at ${samples[bad].t} s the readout shows ${fmt(v[bad])} against ${fmt(target[bad])}. Make the caption match, or fix the simulation (e.g. enough trials that noise can't cross the bound)`,
          );
          break;
        }
      }
    }
  }
  return [...new Set(out)];
}
