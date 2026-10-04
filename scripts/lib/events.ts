// Progress events: the pipeline reports what it is doing through `emit`, the
// CLI renders them (animated in a TTY, plain lines otherwise). Pipeline code
// never prints directly; it emits.

export type Stage = "init" | "render" | "anchors" | "assemble" | "plan" | "build" | "verify" | "serve";

export type DemoPhase =
  | "queued"
  | "building" // model writing code
  | "typecheck"
  | "fixing" // typecheck errors sent back
  | "verifying" // screenshots + review
  | "revising" // review issues sent back
  | "pass"
  | "fail";

export type PipelineEvent =
  | { type: "book"; slug: string; title: string; units: string[]; domain: string; kind: "text" | "scanned" }
  | { type: "stage"; unit: string; stage: Stage; status: "start" | "done" | "skip" | "error"; detail?: string }
  /** Determinate progress within a stage (e.g. pages rendered). */
  | { type: "progress"; unit: string; stage: Stage; done: number; total: number; label?: string }
  /** Plan finished: the demos that will be built. */
  | { type: "plan"; unit: string; demos: { id: string; title: string; beats: number }[] }
  | { type: "demo"; unit: string; id: string; phase: DemoPhase; round?: number; beatsPassed?: number; beats?: number; detail?: string; title?: string }
  /** Running API spend in dollars (total for this run). */
  | { type: "cost"; total: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "done"; url?: string; seconds: number; cost: number; failures: string[] };

export type Emit = (e: PipelineEvent) => void;

/** Default sink: one plain line per event (used when no CLI renderer is attached). */
export const plainEmit: Emit = (e) => {
  const t = new Date().toISOString().slice(11, 19);
  switch (e.type) {
    case "log":
      (e.level === "error" ? console.error : console.log)(`[${t}] ${e.message}`);
      break;
    case "stage":
      console.log(`[${t}] ${e.unit} · ${e.stage}: ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
      break;
    case "demo":
      console.log(`[${t}] ${e.unit} · ${e.id}: ${e.phase}${e.round ? ` r${e.round}` : ""}${e.beats && e.beatsPassed !== undefined ? ` ${e.beatsPassed}/${e.beats}` : ""}${e.detail ? ` — ${e.detail}` : ""}`);
      break;
    case "progress":
      break;
    default:
      console.log(`[${t}] ${JSON.stringify(e)}`);
  }
};
