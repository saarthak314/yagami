// Shared Claude client for every pipeline step. One place for models, effort,
// refusal fallbacks, streaming, JSON outputs and cost logging.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export const client = new Anthropic({ maxRetries: 4 });

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
} as const;

export type Model = (typeof MODELS)[keyof typeof MODELS];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pipeline roles that call a model. */
export type Role = "outline" | "plan" | "repair" | "build" | "template" | "review" | "domain";

const ROLE_GROUP: Record<Role, string> = { outline: "PLAN", plan: "PLAN", repair: "PLAN", build: "BUILD", template: "BUILD", review: "REVIEW", domain: "DOMAIN" };

const isEffort = (e: string | undefined): e is Effort => e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max";

/**
 * Model and effort for a role. Every demo step (outline, spec + code, templates, fixes,
 * reviews) runs on Sonnet 5.5 at medium effort — the user's choice for time and cost.
 * Experiments can override: YAGAMI_MODEL / YAGAMI_EFFORT for all roles, or per group
 * YAGAMI_PLAN_* (outline, legacy plan, repair), YAGAMI_BUILD_* (spec + code, templates),
 * YAGAMI_REVIEW_*, YAGAMI_DOMAIN_* (subject detection, default low effort).
 */
export function roleModel(role: Role): { model: Model; effort: Effort } {
  const g = ROLE_GROUP[role];
  const m = process.env[`YAGAMI_${g}_MODEL`] ?? process.env.YAGAMI_MODEL;
  const e = process.env[`YAGAMI_${g}_EFFORT`] ?? process.env.YAGAMI_EFFORT;
  const model = m === "opus" || m === MODELS.opus ? MODELS.opus : MODELS.sonnet;
  return { model, effort: isEffort(e) ? e : role === "domain" ? "low" : "medium" };
}

// $ per million tokens: [input, output, cache read, cache write (5m)]
const PRICES: Record<Model, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
};

const USAGE_LOG = path.resolve("work/usage.jsonl");

export interface CallOpts {
  model: Model;
  effort: Effort;
  /** Tag for the usage log, e.g. "transcribe:p130". */
  label: string;
  system?: string | Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens?: number;
  /** Receives response text as it streams (e.g. to start work on early parts of a long reply). */
  onText?: (delta: string) => void;
  /**
   * Prompt caching (default on). Turn it off for single-use requests (reviews, one-off
   * classifications): a cache write costs 1.25× input and is wasted if nothing reads it.
   */
  cache?: boolean;
}

export class RefusalError extends Error {}

type CostListener = (cost: number, label: string) => void;
const costListeners = new Set<CostListener>();

/** Subscribe to the dollar cost of every API call; returns an unsubscribe function. */
export function onCost(fn: CostListener): () => void {
  costListeners.add(fn);
  return () => costListeners.delete(fn);
}

function logUsage(label: string, model: Model, u: Anthropic.Beta.BetaUsage) {
  const [pi, po, pr, pw] = PRICES[model];
  const cost =
    ((u.input_tokens ?? 0) * pi +
      (u.output_tokens ?? 0) * po +
      (u.cache_read_input_tokens ?? 0) * pr +
      (u.cache_creation_input_tokens ?? 0) * pw) /
    1e6;
  fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
  fs.appendFileSync(
    USAGE_LOG,
    JSON.stringify({
      at: new Date().toISOString(),
      label,
      model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
      cost: Number(cost.toFixed(5)),
    }) + "\n",
  );
  for (const fn of costListeners) fn(cost, label);
  return cost;
}

/** Total logged spend in dollars (optionally only labels starting with `prefix`). */
export function spent(prefix = ""): number {
  if (!fs.existsSync(USAGE_LOG)) return 0;
  return fs
    .readFileSync(USAGE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { label: string; cost: number })
    .filter((r) => r.label.startsWith(prefix))
    .reduce((s, r) => s + r.cost, 0);
}

async function run(opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>) {
  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: format ? { effort: opts.effort, format } : { effort: opts.effort },
    // Cache the stable prefix (system + earlier turns) across retries and fix-up turns.
    ...(opts.cache === false ? {} : { cache_control: { type: "ephemeral" as const } }),
    system: opts.system,
    messages: opts.messages,
  });
  if (opts.onText) stream.on("text", opts.onText);
  const message = await stream.finalMessage();
  logUsage(opts.label, opts.model, message.usage);
  if (message.stop_reason === "refusal") {
    throw new RefusalError(`${opts.label}: refused (${message.stop_details?.category ?? "unknown"})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(`${opts.label}: hit max_tokens`);
  }
  return message;
}

/**
 * Pre-warm the prompt cache for a shared system prompt (cache_control on its blocks): a
 * non-streaming `max_tokens: 0` request runs prefill only, writing the cache entry once so
 * parallel requests that start right after it read the prefix instead of each writing it.
 * Thinking and effort must match the real requests (both are part of the cached prefix).
 * Best effort: failures are swallowed (the real requests then simply write the cache).
 */
export async function prewarm(opts: { model: Model; effort: Effort; label: string; system: Anthropic.Beta.BetaTextBlockParam[] }): Promise<void> {
  try {
    const message = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 0,
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort },
      system: opts.system,
      messages: [{ role: "user", content: "warmup" }],
    });
    logUsage(opts.label, opts.model, message.usage);
  } catch {
    // not worth failing a run over
  }
}

export function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Free-form call. Returns the final message (append `message.content` to continue the conversation). */
export async function call(opts: CallOpts) {
  const message = await run(opts);
  return { message, text: textOf(message) };
}

/** Call with a JSON-schema constrained response, validated with zod. */
export async function callJson<S extends z.ZodType>(schema: S, opts: CallOpts) {
  const message = await run(opts, betaZodOutputFormat(schema));
  const data = schema.parse(JSON.parse(textOf(message))) as z.infer<S>;
  return { message, data };
}

/** Base64 image content block from a file on disk. */
export function imageBlock(file: string): Anthropic.Beta.BetaImageBlockParam {
  const ext = path.extname(file).slice(1).toLowerCase();
  const media_type = (ext === "jpg" ? "image/jpeg" : `image/${ext}`) as "image/png" | "image/jpeg" | "image/webp";
  return { type: "image", source: { type: "base64", media_type, data: fs.readFileSync(file).toString("base64") } };
}

/** Run async tasks with bounded concurrency, preserving order of results. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
