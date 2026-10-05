// Model-fidelity review: does the demo's simulation implement the paper's own model — its equations,
// update rules, algorithm steps, scenario and numbers? Text-only (code or template config vs the
// paper), so it runs alongside the render checks. An expert audit of 10 papers found that most demos
// that teach something false do so here, not in their drawing: Adam run with a constant step instead
// of α/√t, a 3 ms split-vote window, an extra absorbing barrier, a universal machine that calls two
// different instructions "alike" — captions quote the paper while the simulation does something else.
// Every finding must quote the paper's rule and the exact code that breaks it; a code quote that isn't
// in the source is discarded (no hallucinated fixes).

import fs from "node:fs";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { callJson, fixEffort, roleModel } from "../lib/claude";
import type { BookConfig, DemoSpec } from "../../src/types";
import { bookImages, demoRegions, regionsBlock } from "./build";
import { anchorContext, type Ctx, paths, tag, textSourceNote } from "./common";
import { domainOf } from "./domains";

const FidelitySchema = z.object({
  issues: z.array(
    z.object({
      severity: z.enum(["blocker", "minor"]),
      /** The paper's rule, equation, step or number, quoted (or written out from the page image). */
      paper: z.string(),
      /** Exact code (or config) that contradicts it, copied from the source. */
      code: z.string(),
      text: z.string(),
    }),
  ),
});

type Issue = z.infer<typeof FidelitySchema>["issues"][number];

const HEDGE = /\b(not a (real )?(blocker|problem|issue)|on the (book|paper)'s side|acceptable|simplif\w*|is fine|seems? (fine|ok|correct)|may want|could also|not (necessarily )?wrong|minor|arguabl\w*|stylistic|for clarity)\b/i;

const squash = (s: string) => s.replace(/\s+/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Every piece of a quote ("…"-separated, ≥ 6 chars) appears in the source, ignoring whitespace. */
export function quoted(source: string, quote: string): boolean {
  const src = squash(source);
  const parts = quote
    .split(/\.\.\.|…/)
    .map(squash)
    .filter((p) => p.length >= 6);
  return parts.length > 0 && parts.every((p) => src.includes(p));
}

/** Blockers whose code quote is real and that don't hedge. */
export function realModelBlockers(issues: Issue[], source: string): Issue[] {
  return issues.filter((i) => i.severity === "blocker" && i.paper.trim().length >= 6 && quoted(source, i.code) && !HEDGE.test(i.text));
}

function system(book: BookConfig): string {
  const d = domainOf(book.domain);
  return `You are ${d.reviewer} checking the simulation behind a ${d.demoNoun} that accompanies "${book.title}". You get the demo's spec (brief, controls, presets, beats with captions), the paragraphs its beats are anchored to (">>>") with their neighbours, referenced tables, page images, and the source: a React component's code, or a template config.

Check only the model: does the code compute what the paper says, for the scenario the paper describes?
- equations and update rules (schedules, normalisations, bias corrections, probabilities, recurrences), with the paper's constants and defaults;
- algorithm and protocol steps: their order, conditions and the decisions they make (who wins, what matches, what is committed or chosen, when it halts);
- the scenario: the paper's own example, machine, graph, table rows or parameters when it gives them, and boundary conditions;
- numbers taken from the paper (table values, constants) and which table or row they come from;
- whether each beat's preset and params set up the situation its caption is about.
Ignore drawing, layout, colours, labels and code style; a script already checks crashes and layout.

"blocker": with this code the demo would show a reader something the paper contradicts — a wrong formula or schedule, a step that decides wrongly, a scenario that isn't the paper's and changes its point, a constant that makes the paper's effect impossible, a number from the wrong table. Also a beat whose preset cannot produce what its caption describes.
"minor": everything else, including faithful simplifications that keep the paper's point (fewer nodes, smaller sizes, scaled time).
A blocker quotes the paper ("paper": its words, equation or number, written out if it is only in the image) and the code that contradicts it ("code": copied exactly from the source, one or a few lines, "…" between separate pieces). If you cannot quote both, it is minor. At most 4 blockers; "text" says what is wrong and what the code should do instead. Reply as JSON { "issues": [{ "severity": "blocker" | "minor", "paper": string, "code": string, "text": string }] }. Use an empty list when the model is faithful.`;
}

/** The demo's model source: its component file, or its template config. Null when there is none. */
export function modelSource(c: Ctx, demo: DemoSpec): string | null {
  if (demo.template) return demo.config === undefined ? null : `template "${demo.template}", config:\n${JSON.stringify(demo.config, null, 2)}`;
  const file = paths.component(c.book.slug, c.unit.unit, demo.component);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * One model-fidelity review (YAGAMI_FIDELITY=off skips it). With `previous` (the blockers a review
 * found before a fix), it only re-checks those, at fix effort: a fixed version is judged on what it
 * was asked to fix, not reviewed from scratch.
 */
export async function reviewModel(c: Ctx, demo: DemoSpec, previous?: string[]): Promise<{ pass: boolean; issues: string[] }> {
  const source = modelSource(c, demo);
  if (process.env.YAGAMI_FIDELITY === "off" || !source) return { pass: true, issues: [] };
  const regions = demoRegions(c, [demo.brief, ...demo.beats.map((b) => b.caption)], demo.beats.map((b) => b.anchor));
  const { expect: _e, flagged: _f, config: _c, ...spec } = demo;
  const beats = demo.beats.map((b, i) => `Beat ${i} (preset "${b.preset}"${b.params ? `, params ${JSON.stringify(b.params)}` : ""}) — caption: ${b.caption}\n${anchorContext(c, b.anchor, 2, 1)}`).join("\n\n");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `Demo spec:\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nBeats and their paragraphs (${textSourceNote(c.book).name}; ${textSourceNote(c.book).caveat}):\n\n${beats}${regionsBlock(regions)}`,
    },
    ...(await bookImages(c, demo, regions)),
    {
      type: "text",
      text: `The source:\n\`\`\`${demo.template ? "json" : "tsx"}\n${source}\n\`\`\`\n\n${
        previous?.length
          ? `A review of the previous version found these blockers, and the source was revised to fix them:\n${previous.map((p) => `- ${p}`).join("\n")}\n\nCheck only whether each is fixed now. Report each one still unfixed as a blocker (quoting the current code); report nothing else as a blocker. Reply as JSON.`
          : "Check the model. Reply as JSON."
      }`,
    },
  ];
  const { data } = await callJson(FidelitySchema, {
    ...roleModel("review"),
    ...(previous?.length ? { effort: fixEffort() } : {}),
    label: `fidelity:${tag(c.book.slug, c.unit.unit)}:${demo.id}`,
    system: system(c.book),
    messages: [{ role: "user", content }],
    maxTokens: 10000,
    cache: false,
  });
  const issues = realModelBlockers(data.issues, source).map((i) => {
    const code = i.code.trim().replace(/\s+/g, " ");
    return `model: ${i.text} (paper: "${i.paper.trim()}"; code: \`${code.length > 160 ? code.slice(0, 159) + "…" : code}\`)`;
  });
  return { pass: issues.length === 0, issues };
}
