// Shared model client for every pipeline step. One place for providers, models, effort,
// refusal fallbacks, streaming, JSON outputs and cost logging. Calls go to the Anthropic API by
// default; other providers (a Claude subscription, the OpenAI API, a ChatGPT subscription) live in
// ./providers and take the same Anthropic-format requests (see providers/types.ts).

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Provider, type ProviderId, type ProviderResult, ProviderTransientError } from "./providers/types";
import { applySettings, keyHint, keySource, readSettings } from "./settings";

// Keys pasted in the site's model panel (~/.config/yagami/settings.json) apply unless the environment sets them.
applySettings();

/** The Anthropic API client; made on first use, so a key saved after startup is picked up. */
let anthropicClient: Anthropic | null = null;
let anthropicKeyUsed: string | undefined;
function anthropic(): Anthropic {
  if (!anthropicClient || anthropicKeyUsed !== process.env.ANTHROPIC_API_KEY) {
    anthropicKeyUsed = process.env.ANTHROPIC_API_KEY;
    anthropicClient = new Anthropic({ maxRetries: 4 });
  }
  return anthropicClient;
}

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  /** Trial only (YAGAMI_<GROUP>_MODEL=haiku): no effort parameter, no adaptive thinking. */
  haiku: "claude-haiku-4-5",
} as const;

/** A model id: one of MODELS for Claude providers, an OpenAI model id (e.g. "gpt-5.5") for OpenAI ones. */
export type Model = string;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Default OpenAI model for every role on an API key (YAGAMI_OPENAI_MODEL, or YAGAMI_<GROUP>_MODEL per group). */
export const OPENAI_DEFAULT = "gpt-5.5";
/** On a ChatGPT plan (Codex): GPT-5.6 at xhigh effort for every call — the plan, not tokens, pays for it. */
export const CODEX_DEFAULT = "gpt-5.6-sol";
const CODEX_EFFORT: Effort = "xhigh";

const PROVIDERS: ProviderId[] = ["anthropic", "claude-sub", "openai", "openai-sub"];
let resolved: ProviderId | null = null;

/** Claude Code is logged in with a Claude subscription (not an API key). */
function claudeSubLoggedIn(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const out = execFileSync("claude", ["auth", "status"], { env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const st = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
    return !!st.loggedIn && st.authMethod !== "api_key";
  } catch {
    return false;
  }
}

/** Codex is logged in with a ChatGPT account. */
function codexChatGpt(): boolean {
  try {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const a = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as { auth_mode?: string; tokens?: unknown };
    return a.auth_mode === "chatgpt" && !!a.tokens;
  } catch {
    return false;
  }
}

function anthropicKey(): boolean {
  const profile = path.join(os.homedir(), ".config", "anthropic", "profiles");
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || (fs.existsSync(profile) && fs.readdirSync(profile).length > 0));
}

/**
 * The provider every call goes to: YAGAMI_PROVIDER when set, else the one chosen in the site's model
 * panel, else the first one set up of an Anthropic API key, a Claude subscription, an OpenAI API key
 * and a ChatGPT subscription.
 */
export function activeProvider(): ProviderId {
  if (resolved) return resolved;
  const want = (process.env.YAGAMI_PROVIDER ?? readSettings().provider) as ProviderId | undefined;
  if (want && !PROVIDERS.includes(want)) throw new Error(`unknown YAGAMI_PROVIDER "${want}" (one of: ${PROVIDERS.join(", ")})`);
  resolved = want ?? (anthropicKey() ? "anthropic" : claudeSubLoggedIn() ? "claude-sub" : process.env.OPENAI_API_KEY ? "openai" : codexChatGpt() ? "openai-sub" : "anthropic");
  return resolved;
}

/** Forget the resolved provider (after the settings or a login changed). */
export function resetProvider(): void {
  resolved = null;
}

/** "claude-opus-5-5" → "opus 5.5", "gpt-5.5" stays. */
const shortModel = (m: string) => m.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, "$1 $2.$3");

/** What a provider's models do, in a few words ("opus 5.5 writes demos · sonnet 5.5 reviews"). */
function modelsLine(p: ProviderId): string {
  const build = shortModel(modelFor(p, "build").model);
  const review = shortModel(modelFor(p, "review").model);
  return build === review ? `${build} does everything` : `${build} writes demos · ${review} reviews`;
}

/** The CLI a subscription provider runs is installed. */
function hasCli(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Every provider: whether it is set up, where its access comes from, and which one is active. */
export function providersOverview(): {
  active: ProviderId;
  chosen: ProviderId | null;
  /** YAGAMI_PROVIDER pins the provider; the panel can't change it. */
  pinned: boolean;
  providers: { id: ProviderId; ready: boolean; source: "env" | "saved" | "login" | null; hint: string | null; billing: "api" | "subscription"; installed: boolean; models: string }[];
} {
  const pinned = !!process.env.YAGAMI_PROVIDER;
  const claudeSub = claudeSubLoggedIn();
  const chatgpt = codexChatGpt();
  return {
    active: activeProvider(),
    chosen: (process.env.YAGAMI_PROVIDER as ProviderId | undefined) ?? readSettings().provider ?? null,
    pinned,
    providers: [
      { id: "anthropic", ready: anthropicKey(), source: keySource("anthropic") ?? (anthropicKey() ? "env" : null), hint: keyHint("anthropic"), billing: "api", installed: true, models: modelsLine("anthropic") },
      { id: "claude-sub", ready: claudeSub, source: claudeSub ? "login" : null, hint: null, billing: "subscription", installed: hasCli("claude"), models: modelsLine("claude-sub") },
      { id: "openai", ready: !!process.env.OPENAI_API_KEY, source: keySource("openai"), hint: keyHint("openai"), billing: "api", installed: true, models: modelsLine("openai") },
      { id: "openai-sub", ready: chatgpt, source: chatgpt ? "login" : null, hint: null, billing: "subscription", installed: hasCli("codex"), models: modelsLine("openai-sub") },
    ],
  };
}

/** Whether the active provider is set up, and how to set it up when it isn't. */
export function providerStatus(): { provider: ProviderId; ready: boolean; how?: string } {
  const provider = activeProvider();
  switch (provider) {
    case "anthropic":
      return anthropicKey()
        ? { provider, ready: true }
        : { provider, ready: false, how: "connect one in the site (yagami, then the model button), or set ANTHROPIC_API_KEY / OPENAI_API_KEY, or run claude auth login / codex login" };
    case "claude-sub":
      return claudeSubLoggedIn() ? { provider, ready: true } : { provider, ready: false, how: "claude code isn't logged in to your claude plan — run claude auth login, or pick another model in the site" };
    case "openai":
      return process.env.OPENAI_API_KEY ? { provider, ready: true } : { provider, ready: false, how: "no openai key — set OPENAI_API_KEY or add one in the site's model panel" };
    case "openai-sub":
      return codexChatGpt() ? { provider, ready: true } : { provider, ready: false, how: "codex isn't logged in to your chatgpt plan — run codex login, or pick another model in the site" };
  }
}

const isOpenAi = (p: ProviderId) => p === "openai" || p === "openai-sub";

/** Billing of the active provider: subscription calls cost no API dollars. */
export function billing(): "api" | "subscription" {
  const p = activeProvider();
  return p === "claude-sub" || p === "openai-sub" ? "subscription" : "api";
}

/** Pipeline roles that call a model. */
export type Role = "outline" | "plan" | "repair" | "build" | "template" | "review" | "domain";

const ROLE_GROUP: Record<Role, string> = { outline: "PLAN", plan: "PLAN", repair: "PLAN", build: "BUILD", template: "TEMPLATE", review: "REVIEW", domain: "DOMAIN" };
/** Groups that fall back to another group's settings when their own env vars are unset. */
const GROUP_FALLBACK: Record<string, string> = { TEMPLATE: "BUILD" };

const isEffort = (e: string | undefined): e is Effort => e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max";

/**
 * Model and effort for a role, at medium effort by default.
 * - Claude providers: Opus 5.5 writes the demos (spec + code, templates and their fixes); planning,
 *   reviews and subject detection run on Sonnet 5.5. Audited on 10 papers, Opus-written demos were
 *   74% fully correct and 3% wrong, against 42% and 17% for Sonnet, for about 1.5× the cost.
 * - OpenAI providers: YAGAMI_OPENAI_MODEL (default gpt-5.5) for every role.
 * Overrides: YAGAMI_MODEL / YAGAMI_EFFORT for all roles, or per group YAGAMI_PLAN_* (outline,
 * legacy plan, repair), YAGAMI_BUILD_* (spec + code, templates), YAGAMI_TEMPLATE_*, YAGAMI_REVIEW_*,
 * YAGAMI_DOMAIN_* (subject detection, default low effort). Models: opus, sonnet, haiku or a full id.
 */
export function roleModel(role: Role): { model: Model; effort: Effort } {
  return modelFor(activeProvider(), role);
}

/** roleModel for a given provider (the model panel shows each provider's models). */
export function modelFor(provider: ProviderId, role: Role): { model: Model; effort: Effort } {
  const g = ROLE_GROUP[role];
  const fb = GROUP_FALLBACK[g];
  const m = process.env[`YAGAMI_${g}_MODEL`] ?? (fb ? process.env[`YAGAMI_${fb}_MODEL`] : undefined) ?? process.env.YAGAMI_MODEL;
  const e = process.env[`YAGAMI_${g}_EFFORT`] ?? (fb ? process.env[`YAGAMI_${fb}_EFFORT`] : undefined) ?? process.env.YAGAMI_EFFORT;
  const effort: Effort = isEffort(e) ? e : provider === "openai-sub" ? CODEX_EFFORT : role === "domain" ? "low" : "medium";
  if (isOpenAi(provider)) {
    const fallback = process.env.YAGAMI_OPENAI_MODEL ?? (provider === "openai-sub" ? CODEX_DEFAULT : OPENAI_DEFAULT);
    return { model: m && !/^(opus|sonnet|haiku|claude-)/.test(m) ? m : fallback, effort };
  }
  const builds = g === "BUILD" || g === "TEMPLATE";
  const model =
    m === "opus" || m === MODELS.opus ? MODELS.opus : m === "haiku" || m === MODELS.haiku ? MODELS.haiku : m === "sonnet" || m === MODELS.sonnet ? MODELS.sonnet : builds ? MODELS.opus : MODELS.sonnet;
  return { model, effort };
}

/**
 * Effort for fix turns (typecheck fixes, check/review fixes, config fixes, spec patches):
 * small, targeted edits, so low by default (YAGAMI_FIX_EFFORT overrides).
 */
export function fixEffort(): Effort {
  const e = process.env.YAGAMI_FIX_EFFORT;
  return isEffort(e) ? e : activeProvider() === "openai-sub" ? CODEX_EFFORT : "low";
}

/** Haiku 4.5 takes no effort parameter and no adaptive thinking (thinking is simply omitted). */
const isHaiku = (m: Model) => m === MODELS.haiku;

/** The provider implementation (loaded on first use; the Anthropic API is built in). */
const loaded = new Map<ProviderId, Promise<Provider>>();
function providerImpl(p: ProviderId): Promise<Provider> {
  let got = loaded.get(p);
  if (!got) {
    got =
      p === "claude-sub"
        ? import("./providers/claude-sub").then((m) => m.claudeSub)
        : p === "openai"
          ? import("./providers/openai-api").then((m) => m.openaiApi)
          : import("./providers/openai-sub").then((m) => m.openaiSub);
    loaded.set(p, got);
  }
  return got;
}

// $ per million tokens: [input, output, cache read, cache write (5m)]; a 1-hour cache write is 2× input.
const PRICES: Record<string, [number, number, number, number]> = {
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
/**
 * A stream with no event for this long has stalled: healthy streams send their first event within
 * seconds (p99 ≈ 4 s) and then stream steadily, while a stalled Opus build once hung 35 minutes.
 */
const STALL_MS = Number(process.env.YAGAMI_STALL_MS) || 90_000;

class StalledError extends Error {}

async function run(opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(opts, format);
    } catch (e) {
      const wait = RECONNECT_WAITS_MS[attempt];
      if (!(e instanceof Anthropic.APIConnectionError || e instanceof StalledError || e instanceof ProviderTransientError) || wait === undefined || opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** A call through another provider: its reply as an Anthropic-shaped message, its usage logged. */
async function runProvider(p: ProviderId, opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>): Promise<Anthropic.Beta.BetaMessage> {
  const impl = await providerImpl(p);
  const system = typeof opts.system === "string" ? opts.system : (opts.system ?? []).map((b) => b.text).join("\n\n");
  const t0 = Date.now();
  let r: ProviderResult;
  try {
    r = await impl({ model: opts.model, effort: opts.effort, label: opts.label, system, messages: opts.messages, maxTokens: opts.maxTokens ?? 64000, schema: format?.schema as Record<string, unknown> | undefined, signal: opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw new AbortedError(`${opts.label}: aborted`);
    throw e;
  }
  const end = Date.now();
  fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
  fs.appendFileSync(
    USAGE_LOG,
    JSON.stringify({
      at: new Date(end).toISOString(),
      label: opts.label,
      model: r.model,
      provider: p,
      billing: r.billing,
      input: r.usage.input,
      output: r.usage.output,
      cacheRead: r.usage.cacheRead,
      cacheWrite: r.usage.cacheWrite,
      cost: Number(r.cost.toFixed(5)),
      startedAt: new Date(t0).toISOString(),
      ms: end - t0,
      ...(r.ttftMs ? { ttftMs: r.ttftMs } : {}),
    }) + "\n",
  );
  for (const fn of costListeners) fn(r.cost, opts.label);
  if (r.stopReason === "refusal") throw new RefusalError(`${opts.label}: refused`);
  if (r.stopReason === "max_tokens") throw new Error(`${opts.label}: hit max_tokens`);
  if (opts.onText) opts.onText(r.text);
  return {
    id: `${p}-${t0}`,
    type: "message",
    role: "assistant",
    model: r.model,
    content: [{ type: "text", text: r.text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output, cache_read_input_tokens: r.usage.cacheRead ?? 0, cache_creation_input_tokens: r.usage.cacheWrite ?? 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

async function runOnce(opts: CallOpts, format?: ReturnType<typeof betaZodOutputFormat>) {
  if (opts.signal?.aborted) throw new AbortedError(`${opts.label}: aborted before it started`);
  const p = activeProvider();
  if (p !== "anthropic") return runProvider(p, opts, format);
  const t0 = Date.now();
  const stream = anthropic().beta.messages.stream({
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
  let lastEvent = Date.now();
  let stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastEvent < STALL_MS) return;
    stalled = true;
    stream.abort();
  }, 5_000);
  stream.on("streamEvent", (e) => {
    lastEvent = Date.now();
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
    if (opts.signal?.aborted || stalled) {
      // The losing side of a race: still account for what was billed until the abort. The
      // snapshot has the input/cache usage from message_start; output tokens only arrive at the
      // end, so estimate them from the streamed time (thinking isn't visible) and text.
      timing.end = Date.now();
      const snap = stream.currentMessage;
      const streamed = timing.first ? (timing.end - timing.first) / 1000 : 0;
      const output = Math.max(Math.round(textChars / 4), Math.round(streamed * EST_TOKENS_PER_SECOND));
      const usage = { ...(snap?.usage ?? {}), output_tokens: output } as Anthropic.Beta.BetaUsage;
      logUsage(opts.label, opts.model, usage, timing, { aborted: true, outputEstimated: true });
      if (stalled && !opts.signal?.aborted) throw new StalledError(`${opts.label}: stream stalled (no event for ${STALL_MS / 1000} s)`);
      throw new AbortedError(`${opts.label}: aborted`);
    }
    throw e;
  } finally {
    clearInterval(watchdog);
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
  if (activeProvider() !== "anthropic") return;
  const oneHour = opts.system.some((b) => (b.cache_control as { ttl?: string } | undefined)?.ttl === "1h");
  const key = crypto
    .createHash("sha1")
    // The API host is part of the key: a warm against a mock or another endpoint says nothing about this one.
    .update(`${anthropic().baseURL}\0${opts.model}\0${isHaiku(opts.model) ? "" : opts.effort}\0${opts.system.map((b) => b.text).join("\0")}`)
    .digest("hex")
    .slice(0, 20);
  if (oneHour && warmedRecently(key)) return;
  try {
    const message = await anthropic().beta.messages.create({
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
