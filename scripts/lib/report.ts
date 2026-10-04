// The process-wide event sink. Library code calls emit()/info()/warn(); the
// orchestrator (scripts/run.ts) installs the CLI's renderer with setEmit().

import { plainEmit, type Emit, type PipelineEvent } from "./events";

let sink: Emit = plainEmit;

/** Install a sink; returns the previous one. */
export function setEmit(e: Emit): Emit {
  const prev = sink;
  sink = e;
  return prev;
}

export function emit(e: PipelineEvent): void {
  sink(e);
}

export const info = (message: string) => sink({ type: "log", level: "info", message });
export const warn = (message: string) => sink({ type: "log", level: "warn", message });
export const error = (message: string) => sink({ type: "log", level: "error", message });
