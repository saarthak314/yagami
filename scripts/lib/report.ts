// The event sink. Library code calls emit()/info()/warn(); the orchestrator
// (scripts/run.ts) runs each book inside `withEmit`, so concurrent runs in one
// process (a test driver, a server) each get their own events. setEmit() sets the
// process-wide fallback used outside any run.

import { AsyncLocalStorage } from "node:async_hooks";
import { plainEmit, type Emit, type PipelineEvent } from "./events";

let sink: Emit = plainEmit;
const scoped = new AsyncLocalStorage<Emit>();

/** Run `fn` with `e` as the sink for everything it (asynchronously) does. */
export function withEmit<T>(e: Emit, fn: () => Promise<T>): Promise<T> {
  return scoped.run(e, fn);
}

const current = (): Emit => scoped.getStore() ?? sink;

/** Install a sink; returns the previous one. */
export function setEmit(e: Emit): Emit {
  const prev = sink;
  sink = e;
  return prev;
}

export function emit(e: PipelineEvent): void {
  current()(e);
}

export const info = (message: string) => current()({ type: "log", level: "info", message });
export const warn = (message: string) => current()({ type: "log", level: "warn", message });
export const error = (message: string) => current()({ type: "log", level: "error", message });
