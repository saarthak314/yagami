// Shared Claude client for every pipeline step. One place for models, effort,
// refusal fallbacks, streaming, JSON outputs and cost logging.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const client = new Anthropic({ maxRetries: 4 });

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  /** Trial only (YAGAMI_<GROUP>_MODEL=haiku): no effort parameter, no adaptive thinking. */
  haiku: "claude-haiku-4-5",
} as const;

export type Model = (typeof MODELS)[keyof typeof MODELS];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pipeline roles that call a model. */
export type Role = "outline" | "plan" | "repair" | "build" | "template" | "review" | "domain";

const ROLE_GROUP: Record<Role, string> = { outline: "PLAN", plan: "PLAN", repair: "PLAN", build: "BUILD", template: "TEMPLATE", review: "REVIEW", domain: "DOMAIN" };
/** Groups that fall back to another group's settings when their own env vars are unset. */
const GROUP_FALLBACK: Record<string, string> = { TEMPLATE: "BUILD" };

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
  const fb = GROUP_FALLBACK[g];
  const m = process.env[`YAGAMI_${g}_MODEL`] ?? (fb ? process.env[`YAGAMI_${fb}_MODEL`] : undefined) ?? process.env.YAGAMI_MODEL;
  const e = process.env[`YAGAMI_${g}_EFFORT`] ?? (fb ? process.env[`YAGAMI_${fb}_EFFORT`] : undefined) ?? process.env.YAGAMI_EFFORT;
  const model = m === "opus" || m === MODELS.opus ? MODELS.opus : m === "haiku" || m === MODELS.haiku ? MODELS.haiku : MODELS.sonnet;
  return { model, effort: isEffort(e) ? e : role === "domain" ? "low" : "medium" };
}

/**
 * Effort for fix turns (typecheck fixes, check/review fixes, config fixes, spec patches):
 * small, targeted edits, so low by default (YAGAMI_FIX_EFFORT overrides).
 */
export function fixEffort(): Effort {
  const e = process.env.YAGAMI_FIX_EFFORT;
  return isEffort(e) ? e : "low";
}

/** Haiku 4.5 takes no effort parameter and no adaptive thinking (thinking is simply omitted). */
const isHaiku = (m: Model) => m === MODELS.haiku;

// $ per million tokens: [input, output, cache read, cache write (5m)]; a 1-hour cache write is 2× input.
const PRICES: Record<Model, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
};

/**
 * Cache TTL for the large shared system prompts (builder, templates). Default 5 minutes: a 1-hour
 * write costs 2× input instead of 1.25× and only pays off when several books of the same subject are
 * built within the hour (benchmarked: it cost more than it saved per run). YAGAMI_CACHE_TTL=1h opts in.
 */
export function systemCacheControl(): { type: "ephemeral"; ttl?: "1h" } {
  return process.env.YAGAMI_CACHE_TTL === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

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
  /** Abort the request (e.g. the losing candidate of a race); throws AbortedError. */
  signal?: AbortSignal;
}

/** The call was aborted through `signal` (its partial usage is still logged). */
export class AbortedError extends Error {}

export class RefusalError extends Error {}

type CostListener = (cost: number, label: string) => void;
const costListeners = new Set<CostListener>();

/** Subscribe to the dollar cost of every API call; returns an unsubscribe function. */
export function onCost(fn: CostListener): () => void {
  costListeners.add(fn);
  return () => costListeners.delete(fn);
}

/** Timing of one request (for the latency waterfall): start, first streamed token, end. */
interface Timing {
  start: number;
  /** First content block (often thinking). */
  first?: number;
  /** First visible text token (after any thinking). */
  text?: number;
  end: number;
}

function logUsage(label: string, model: Model, u: Anthropic.Beta.BetaUsage, timing?: Timing, extra: Record<string, unknown> = {}) {
  const [pi, po, pr, pw] = PRICES[model];
  // Cache writes by TTL when the API breaks them down (1-hour writes cost 2× input).
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const cost =
    ((u.input_tokens ?? 0) * pi +
      (u.output_tokens ?? 0) * po +
      (u.cache_read_input_tokens ?? 0) * pr +
      w5m * pw +
      w1h * pi * 2) /
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
      ...(w1h ? { cacheWrite1h: w1h } : {}),
      ...extra,
      ...(timing
        ? { startedAt: new Date(timing.start).toISOString(), ms: timing.end - timing.start, ...(timing.first ? { ttftMs: timing.first - timing.start } : {}), ...(timing.text ? { textMs: timing.text - timing.start } : {}) }
        : {}),
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

/** Request fields that depend on the model (Haiku 4.5: no effort, no adaptive thinking, no fallbacks). */
function modelParams(model: Model, effort: Effort, format?: ReturnType<typeof betaZodOutputFormat>) {
  if (isHaiku(model)) return format ? { output_config: { format } } : {};
  return {
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    thinking: { type: "adaptive" as const },
    output_config: format ? { effort, format } : { effort },
  };
}

/** Sonnet's typical output speed, for estimating the tokens of a stream aborted mid-way. */
const EST_TOKENS_PER_SECOND = 150;

/**
 * Waits before re-sending a request whose connection failed. The SDK's own retries (maxRetries) cover
 * a few seconds; a network drop of a minute or two used to fail whole books (every stage at once).
 */
const RECONNECT_WAITS_MS = [10_000, 30_000, 60_000];

async function run(opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(opts, format);
    } catch (e) {
      const wait = RECONNECT_WAITS_MS[attempt];
      if (!(e instanceof Anthropic.APIConnectionError) || wait === undefined || opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function runOnce(opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>) {
  if (opts.signal?.aborted) throw new AbortedError(`${opts.label}: aborted before it started`);
  const t0 = Date.now();
  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? (isHaiku(opts.model) ? 32000 : 64000),
    ...modelParams(opts.model, opts.effort, format),
    // Cache the stable prefix (system + earlier turns) across retries and fix-up turns.
    ...(opts.cache === false ? {} : { cache_control: { type: "ephemeral" as const } }),
    system: opts.system,
    messages: opts.messages,
  });
  if (opts.onText) stream.on("text", opts.onText);
  const timing: Timing = { start: t0, end: 0 };
  let textChars = 0;
  stream.on("streamEvent", (e) => {
    if (timing.first === undefined && e.type === "content_block_start") timing.first = Date.now();
    if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
      timing.text ??= Date.now();
      textChars += e.delta.text.length;
    }
  });
  const onAbort = () => stream.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await stream.finalMessage();
  } catch (e) {
    if (opts.signal?.aborted) {
      // The losing side of a race: still account for what was billed until the abort. The
      // snapshot has the input/cache usage from message_start; output tokens only arrive at the
      // end, so estimate them from the streamed time (thinking isn't visible) and text.
      timing.end = Date.now();
      const snap = stream.currentMessage;
      const streamed = timing.first ? (timing.end - timing.first) / 1000 : 0;
      const output = Math.max(Math.round(textChars / 4), Math.round(streamed * EST_TOKENS_PER_SECOND));
      const usage = { ...(snap?.usage ?? {}), output_tokens: output } as Anthropic.Beta.BetaUsage;
      logUsage(opts.label, opts.model, usage, timing, { aborted: true, outputEstimated: true });
      throw new AbortedError(`${opts.label}: aborted`);
    }
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  timing.end = Date.now();
  logUsage(opts.label, opts.model, message.usage, timing);
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
 * With a 1-hour TTL the warm is recorded in work/cache-warm.json and skipped by later runs
 * within ~55 minutes (the entry is still alive server-side).
 * Best effort: failures are swallowed (the real requests then simply write the cache).
 */
export async function prewarm(opts: { model: Model; effort: Effort; label: string; system: Anthropic.Beta.BetaTextBlockParam[] }): Promise<void> {
  const oneHour = opts.system.some((b) => (b.cache_control as { ttl?: string } | undefined)?.ttl === "1h");
  const key = crypto
    .createHash("sha1")
    // The API host is part of the key: a warm against a mock or another endpoint says nothing about this one.
    .update(`${client.baseURL}\0${opts.model}\0${isHaiku(opts.model) ? "" : opts.effort}\0${opts.system.map((b) => b.text).join("\0")}`)
    .digest("hex")
    .slice(0, 20);
  if (oneHour && warmedRecently(key)) return;
  try {
    const message = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 0,
      ...(isHaiku(opts.model) ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort: opts.effort } }),
      system: opts.system,
      messages: [{ role: "user", content: "warmup" }],
    });
    logUsage(opts.label, opts.model, message.usage);
    if (oneHour) recordWarm(key);
  } catch {
    // not worth failing a run over
  }
}

const WARM_LOG = path.resolve("work/cache-warm.json");
/** Treat a 1-hour entry as alive for 55 minutes after it was written or read. */
const WARM_FRESH_MS = 55 * 60 * 1000;

function warmLog(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(WARM_LOG, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function warmedRecently(key: string): boolean {
  const at = warmLog()[key];
  return typeof at === "number" && Date.now() - at < WARM_FRESH_MS;
}

function recordWarm(key: string) {
  const log = warmLog();
  log[key] = Date.now();
  for (const [k, at] of Object.entries(log)) if (Date.now() - at > WARM_FRESH_MS) delete log[k];
  fs.mkdirSync(path.dirname(WARM_LOG), { recursive: true });
  fs.writeFileSync(WARM_LOG, JSON.stringify(log));
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
