// Domain profiles: what a good demo looks like in each field, how the builder
// should implement it, and how the reviewer should judge it. Plan, build and
// verify combine a profile with the book's title; nothing else in the demo
// pipeline is subject-specific.

import type { Domain } from "../../src/types";

export interface DomainProfile {
  /** "mathematics", "computer science", "physics", "machine learning". */
  subject: string;
  /** Demo kind, e.g. "interactive physics demo". */
  demoNoun: string;
  /** Extra planner guidance: what makes a good demo in this field, what to avoid. */
  planner: string;
  /** Example captions in the house style. */
  captionExample: string;
  /** Extra builder rules for this field. */
  builder: string;
  /** Reviewer persona, e.g. "a careful physicist". */
  reviewer: string;
  /** Field-specific failure checks for the reviewer. */
  reviewChecks: string;
  /** Reference demos shown to the builder (dir under src/demo/reference with <Component>.tsx + spec.json). */
  references: { dir: string; component: string }[];
}

const physics: DomainProfile = {
  subject: "physics",
  demoNoun: "interactive physics demo",
  planner: `Good physics demos:
- simulate or visualize exactly what the text describes, often re-drawing one of the book's own figures as a live, manipulable animation (e.g. a sawtooth path with work accumulating step by step; a cannonball launched sideways from a mountain at increasing speeds);
- let the reader check an equation numerically: readouts show both sides (e.g. "W so far" next to "mg(z₁ − z₂)");
- use the book's symbols, units and the numbers quoted in the text as beat params.
Avoid decorative animations that don't carry the argument, and demos of things the text only mentions in passing.`,
  captionExample: "Uniform gravity is vertical, so only up and down steps count. Paths A and B give the same work, mg times the drop.",
  builder: `- Style: thin monochrome line art like the book's figures. Physical symbols with \`draw.text(..., { kind: "symbol" })\`.
- Physics must be correct and match the spec and the book: correct equations, units, signs and directions. Use \`rk4\` for ODEs; use substeps when dt × speed is large.`,
  reviewer: "a careful physicist",
  reviewChecks: `- wrong physics: wrong directions, signs, magnitudes, trajectories, or readouts inconsistent with each other or with the equation they illustrate (check the arithmetic). Work out the physics yourself before calling something wrong (e.g. gravity does negative work while a body rises; a path that first climbs then falls has a total that dips negative before ending positive).`,
  references: [{ dir: "src/demo/reference", component: "WorkGravity" }],
};

const ml: DomainProfile = {
  subject: "machine learning",
  demoNoun: "interactive machine-learning demo",
  planner: `Good machine-learning demos make a mechanism visible with small, concrete numbers that are computed live in the browser:
- small tensors: 4–8 tokens labelled with example words (e.g. "the cat sat on the mat"), model width d = 4–16, all weights from a seeded PRNG (never real trained weights, never Math.random);
- show the computation itself: e.g. Q·Kᵀ scores, the softmax that turns them into attention weights (a heatmap), the weighted sum of values; the effect of scaling by 1/√d_k on softmax saturation as d_k grows; causal masking in a decoder; several heads projecting into subspaces and being concatenated; sinusoidal positional encodings and the fact that a fixed offset is a linear map; the warm-up then inverse-square-root learning-rate schedule; label smoothing's effect on the target distribution; per-layer cost and path-length comparisons between layer types;
- readouts that let the reader check an equation or a table value from the paper (e.g. a row of weights summing to 1, the learning rate at a given step, the formula value next to the computed one);
- one demo per idea, reused across the paragraphs that discuss it; presets switch between the variants the text compares.
Skip the references, acknowledgements, author lists and experimental-results tables unless a small live calculation genuinely illuminates a table (e.g. a cost formula). Do not try to train a real model or reproduce reported scores.`,
  captionExample: "Each row of the heatmap is one query's attention over the keys, and it sums to 1. Raise d_k without the 1/√d_k factor and the rows collapse onto a single key.",
  builder: `- Visual language: heatmaps with \`draw.matrix\` (\`sequential\` for weights/probabilities, \`diverging\` with a symmetric domain for signed values), bar charts with \`draw.bars\`, tokens as \`draw.chip\`, plots with \`axes\`. Keep matrices small enough that labels stay legible (cells ≥ 16 px); print values in cells only when they fit.
- All numbers are computed live from the params with the kit's \`rng\`/\`randn\`/\`randMatrix\`, \`softmax\`, \`matmul\`, \`dot\`, \`transpose\` (fixed seeds, so every render is identical). Recompute derived matrices with useMemo keyed on the params they depend on, not every frame.
- Animation is optional: use time to sweep a highlight (the current query row, the current training step) or to ease between states, not for decoration. When nothing needs to move, draw the static state every frame.
- Maths must match the paper exactly (e.g. Attention(Q,K,V) = softmax(QKᵀ/√d_k)V, PE(pos,2i) = sin(pos/10000^{2i/d_model})); readouts are computed from the same arrays that are drawn.`,
  reviewer: "a careful machine-learning researcher",
  reviewChecks: `- wrong maths: softmax rows that don't sum to 1, masks applied to the wrong side of the diagonal, scaling applied wrongly, formulas that disagree with the paper, readouts that disagree with the drawn matrices or with each other (check the arithmetic on a cell or two).`,
  references: [{ dir: "src/demo/reference/ml", component: "SoftmaxTemperature" }],
};

const cs: DomainProfile = {
  subject: "computer science",
  demoNoun: "interactive algorithm demo",
  planner: `Good computer-science demos step through an algorithm or data structure on a small concrete input:
- arrays as rows of cells with index labels, pointers/cursors as small arrows, trees and graphs as nodes (chips) and edges, stacks/queues as columns of cells;
- the animation advances in discrete steps over time (one comparison, swap, relaxation or rotation per step, ~0.5–1 s each, controlled by a speed slider), with the cells or edges involved in the current step highlighted;
- readouts are counters and invariants the text talks about (comparisons, swaps, the current loop invariant, heap size, path cost) so the reader can check a complexity claim or a hand trace;
- presets switch between inputs the text discusses (sorted, reversed, random with a fixed seed; best and worst cases).
Avoid demos that are just static diagrams, and inputs too large to follow (keep to ~6–16 elements).`,
  captionExample: "Each pass bubbles the largest remaining element to the end, so the sorted suffix grows by one. On reversed input every comparison causes a swap.",
  builder: `- Visual language: arrays / memory as a row of cells with \`draw.cells\` (index or address labels, per-cell style "active" for the cells the current step touches, "muted" for out-of-range, "done" for settled), named cursors (lo, hi, i, p, head …) with \`draw.pointer\`, nodes/tokens with \`draw.chip\`, edges with \`draw.line\`/\`draw.arrow\`, one plain sentence under the structure saying what the current step did. Accent only for the current step.
- Precompute the full list of steps (states) from the input with a pure function in useMemo, then pick the current step from elapsed time × speed in onFrame. Restart (resetKey) goes back to step 0; the last state holds for ~1.5 s, then the run loops.
- Inputs come from params or a fixed-seed \`rng\`; counters in readouts are taken from the same step list that is drawn.
- When the text shows or describes code, show it with \`draw.code(ctx, lines, x, y, { lang, highlight: currentLine, lineNumbers: true, width })\` beside the structure and highlight the line the current step executes (each step records its code line). Keep listings short (at most 12 lines and 40 columns; shorten names rather than wrapping). draw.code colours tokens with the reader's chosen code theme; never colour code yourself.`,
  reviewer: "a careful computer scientist",
  reviewChecks: `- wrong algorithm behaviour: steps that the algorithm would not take, invariants that don't hold in the screenshot, counters that disagree with the drawn state or with the text's complexity claim.`,
  references: [{ dir: "src/demo/reference/cs", component: "BinarySearch" }],
};

const math: DomainProfile = {
  subject: "mathematics",
  demoNoun: "interactive mathematics demo",
  planner: `Good mathematics demos make an argument or object visible and checkable with small, concrete numbers:
- constructions and proofs as step-throughs: each step of the argument is one state (draw the auxiliary line, apply the substitution, take the next term), advancing over time with the part that changed highlighted;
- geometric and algebraic pictures: plots of the functions involved, transforms of the plane by a matrix (grid, basis vectors, an eigenvector staying on its line), areas under curves filling in as Riemann sums refine, sequences and series converging, ε–δ windows shrinking;
- numeric checks of identities and theorems: both sides of an equation evaluated live as the reader moves a parameter (e.g. a partial sum next to its closed form, a determinant next to the area it scales);
- probability and statistics by simulation with a seeded RNG: histograms filling in, running means settling, compared with the exact value from the text;
- one demo per idea, reused across the paragraphs that develop it; presets switch between the cases the text compares (convergent/divergent, singular/non-singular, small/large n).
Avoid demos that only restate a formula, and anything that needs symbolic algebra the browser can't do numerically.`,
  captionExample: "The shaded rectangles are a left Riemann sum with n strips. Double n and the gap to the exact area, shown in the readout, roughly halves.",
  builder: `- Visual language: \`axes\` for plots (sensible ticks, symbols as axis labels), thin \`theme.fg\` curves, the quantity being studied in \`theme.accent\`, a contrasting second quantity in \`theme.accent2\`; shaded regions with low alpha fills; points with \`draw.dot\`; matrices with \`draw.matrix\`; symbols with \`draw.text(..., { kind: "symbol" })\`.
- Step-throughs: precompute the list of states with a pure function in useMemo and pick the current step from elapsed time × speed; the last state holds ~1.5 s, then loops.
- Numerics: evaluate both sides of the identity from the same values that are drawn; guard against division by zero and overflow; random experiments use the kit's seeded \`rng\`.`,
  reviewer: "a careful mathematician",
  reviewChecks: `- wrong mathematics: curves or regions that don't match the formula, identities whose two sides disagree in the readouts, limits approached from the wrong side, transforms applied incorrectly (check a value or two yourself).`,
  references: [
    { dir: "src/demo/reference", component: "WorkGravity" },
    { dir: "src/demo/reference/ml", component: "SoftmaxTemperature" },
  ],
};

export const DOMAINS: Record<Domain, DomainProfile> = { math, physics, ml, cs };

export function domainOf(d: Domain): DomainProfile {
  const p = DOMAINS[d];
  if (!p) throw new Error(`unknown domain "${d}"`);
  return p;
}
