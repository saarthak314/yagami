// One pipeline run as a child process of the web API: prints one PipelineEvent
// JSON per line on stdout and nothing else.
//
//   build a new or existing book:  job.ts --pdf <path> [--slug <slug>] [--units a,b]
//   build an existing book:        job.ts --book <slug> [--units a,b]
//   fix a demo:                    job.ts --book <slug> --unit <id> --demo <id> --note "<problem>"
//
// SIGINT/SIGTERM stops the run: finished work is kept (the next run continues).
// Exit code: 0 all demos ready, 1 some failed, 2 the run itself failed, 130 stopped.

import type { BookConfig } from "../src/types";
import type { PipelineEvent } from "./lib/events";
import { defaultUnits, draftBook, finalizeBook } from "./create-book";
import { loadBook } from "./books";
import { onCost } from "./lib/claude";
import { runBook } from "./run";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");

// stdout carries only events: anything else a library prints goes to stderr.
const writeOut = process.stdout.write.bind(process.stdout);
for (const k of ["log", "info", "warn", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);
const out = (e: PipelineEvent) => writeOut(JSON.stringify(e) + "\n");
const started = Date.now();
let cost = 0;
let finished = false;

// Spend before the run (detecting the subject) is added to the run's own totals.
let before = 0;
const emit = (e: PipelineEvent) => {
  if (e.type === "cost") e = { ...e, total: e.total + before };
  if (e.type === "done") e = { ...e, cost: e.cost + before };
  if (e.type === "cost") cost = e.total;
  if (e.type === "done") finished = true;
  out(e);
};

function stop() {
  if (!finished) out({ type: "done", seconds: (Date.now() - started) / 1000, cost, failures: ["stopped"] });
  process.exit(130);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
// The web server keeps our stdin open; if it goes away (yagami quit), stop too.
if (!process.stdin.isTTY) {
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
}

try {
  let book: BookConfig;
  const pdf = args.get("pdf");
  if (pdf) {
    const draft = draftBook(pdf, { slug: args.get("slug") || undefined });
    book = draft.book;
    if (draft.fresh) {
      // The one slow step before the pipeline: ask a model which subject this is.
      emit({ type: "stage", unit: "", stage: "init", status: "start", detail: "detecting the subject" });
      const off = onCost((c) => (before += c));
      await finalizeBook(pdf, book);
      off();
      cost = before;
      if (before) out({ type: "cost", total: before });
      emit({ type: "stage", unit: "", stage: "init", status: "done" });
    }
  } else book = loadBook(args.get("book") ?? "");

  const demo = args.get("demo");
  const unitsArg = args.get("units");
  const units = unitsArg ? unitsArg.split(",").filter(Boolean) : defaultUnits(book);
  const opts = demo
    ? { units: [args.get("unit") ?? ""], steps: ["verify" as const], only: [demo], note: args.get("note") ?? "" }
    : { units };
  const result = await runBook(book.slug, opts, emit);
  process.exit(result.failures.length ? 1 : 0);
} catch (e) {
  emit({ type: "log", level: "error", message: (e as Error).message });
  if (!finished) out({ type: "done", seconds: (Date.now() - started) / 1000, cost, failures: [(e as Error).message] });
  process.exit(2);
}
