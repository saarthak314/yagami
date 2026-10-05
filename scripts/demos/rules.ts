// Coding rules for generated demos, and a cheap static audit of their code.
//
// DEMO_RULES is included in every demo prompt (builder and template); it is
// distilled from the failures this pipeline actually saw: fix requests in
// work/*/demos/** (readouts wrong or missing, overlapping/clipped labels,
// frozen or non-looping animations, NaN readouts, tiny cramped layouts) and the
// stress audit (time-based indices going out of range, broken readouts at
// control extremes). Keep the export names stable: build/template prompts import them.

/** Rules every generated demo must follow (concise; included verbatim in prompts). */
export const DEMO_RULES = `Robustness rules (the demo is stress-tested: every beat run for a long time, every preset, every control at min/max/mid, extreme combinations, pause/restart and resizes; any crash, NaN or blank stage fails it):
- Step-throughs: pick the current step with stepAt(steps.length, t, speed, hold) from the kit — never index arrays with Math.floor(t * speed) or similar. Index any array with a computed index through at(arr, i) or clamp the index first.
- Every array index, division, sqrt, log and pow on values that depend on params or time must be safe at every control's min and max: guard with safeDiv(a, b), finite(v), clamp(v, lo, hi); a slider at 0 or 1 is a normal state, not an edge case.
- Initialise simulation state for every preset and every control value (useSim with [resetKey, preset, …params that change the setup]); never assume a previous preset's state.
- Animations loop (or hold, then restart) forever; a stage that animates must keep animating after any time, restart or control change.
- Step-throughs and processes reach the state the caption describes within ~12 s at default settings (pace the steps), then hold that end state for several seconds before replaying; the reader and the checks must be able to see the end state.
- Publish every readout id on every frame via setReadouts, with finite values (format with fmt()); never NaN, Infinity, "undefined" or "null". Use "—" only when a readout truly doesn't apply in the current preset.
- Keep every label inside the stage (≥ 16 px margin) and never let two labels overlap; put legends in their own row outside the plot area; size fonts and layout from width/height so it works from 480×300 to 1200×900.
- Deterministic: no Math.random, Date or performance.now; seed randomness with rng(seed); animate only from Stage's onFrame (t, dt).
- No DOM, timers or global state: no document/window access, setTimeout/setInterval/requestAnimationFrame, or module-level mutable variables.

Faithfulness rules (an expert compares every beat with the paper; these are the failures it found most):
- A caption says what that beat's stage visibly does with its preset and params: the objects, the behaviour and the outcome the reader will see. Never claim a sweep, overshoot, fork, second leader or curve that the beat doesn't draw. A true fact from the paper that the stage doesn't show is not a caption.
- The beat's preset must reach the captioned state: if a caption is about one moment of a process (a split vote, the entry at index 7, the resize), give that beat params that set the process up to show it and hold it, rather than a moment inside a long loop shared with other beats.
- Use the paper's own example, method and numbers where it gives them (its machine table, its source, its scenario). Compared values come from one table and row, the one the paragraph discusses. Don't simplify away the point the paragraph makes.
- Every control and every preset parameter changes the stage or a readout, and a select or label shows the value that is actually simulated.
- Experimental results (training curves, accuracies, measured timings) come from the paper's printed numbers, never from a made-up toy run that imitates them. Parameter wording is read in context ("small 1 − β₂" means β₂ close to 1).
- A simulated frequency shown against an exact value or bound uses enough trials that sampling noise can't cross it, or shows the exact value beside it.`;

/** A risky pattern in demo code and what to tell the builder. Only near-zero-false-positive patterns belong here. */
interface Pattern {
  re: RegExp;
  note: (m: RegExpExecArray) => string;
  /** Extra filter on the match (return false to ignore it). */
  when?: (m: RegExpExecArray) => boolean;
}

const TIMEISH = /(\.t\b|\bt\b|\btime\b|\belapsed\b|\bclock\b|\bspeed\b|\bphase\b)/;

const PATTERNS: Pattern[] = [
  {
    // arr[Math.floor(t * speed)] — goes out of range when time runs past the steps.
    re: /\[\s*Math\.(?:floor|round|ceil|trunc)\(([^\]\n]*)\)\s*\]/g,
    when: (m) => TIMEISH.test(m[1]) && !/%/.test(m[1]),
    note: (m) => `indexes an array with a time-based value (${m[0].slice(0, 60)}) that runs past the end — use stepAt(count, t, speed, hold) or at(arr, i) from the kit`,
  },
  { re: /\bMath\.random\s*\(/g, note: () => "uses Math.random — runs must be deterministic: use rng(seed) from the kit" },
  { re: /\b(?:Date\.now|performance\.now)\s*\(|\bnew Date\s*\(/g, note: (m) => `reads the wall clock (${m[0].trim()}) — animate from Stage's onFrame t/dt only` },
  { re: /\b(?:requestAnimationFrame|setInterval|setTimeout)\s*\(/g, note: (m) => `runs its own timer (${m[0].replace(/\s*\($/, "")}) — animate inside Stage's onFrame` },
  { re: /\b(?:document|window)\s*\.\s*(?!devicePixelRatio\b)\w+/g, note: (m) => `touches the page (${m[0].replace(/\s+/g, "")}) — demos draw only on their Stage` },
];

/** Risky patterns in a demo's source → notes for the builder (empty when clean). */
export function staticAudit(code: string): string[] {
  // Ignore comments and string contents so prose doesn't trigger patterns.
  const src = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  const out = new Set<string>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(src); m; m = p.re.exec(src)) {
      if (p.when && !p.when(m)) continue;
      out.add(`code: ${p.note(m)}`);
    }
  }
  return [...out];
}
