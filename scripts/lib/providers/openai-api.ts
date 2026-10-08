// OpenAI models through the OpenAI API (OPENAI_API_KEY; OPENAI_BASE_URL is honoured, e.g. for a mock).
// One streamed Responses API request per call: the Anthropic-format conversation becomes `input`, the
// system prompt `instructions`, and a JSON schema becomes a strict `json_schema` text format.

import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseInputContent, ResponseInputItem, Response as OpenAIResponse } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import crypto from "node:crypto";
import { type Effort, type Provider, type ProviderRequest, type ProviderResult, ProviderSetupError, ProviderTransientError } from "./types";

type Price = { in: number; cached?: number; out: number; write?: number; long?: true };

/**
 * $ per million tokens, Standard tier, prompts up to 272K input tokens, from
 * https://developers.openai.com/api/docs/pricing (checked 2026-10-08). `cached` defaults to `in` (no
 * cache discount listed); `write` is the cache-write rate of GPT-5.6 and later (earlier models charge
 * none). `long`: the request is billed 2× input and 1.5× output above 272K input tokens. gpt-5.6-sol is
 * a promotional price (at least through 2026-11-21). YAGAMI_OPENAI_PRICES='{"model":[in,cachedIn,out]}'
 * adds or overrides models.
 */
const PRICES: Record<string, Price> = {
  "gpt-6-astra": { in: 10, cached: 1, out: 50, write: 12.5, long: true },
  "gpt-6.1-sol": { in: 2, cached: 0.1, out: 10, write: 2.5, long: true },
  "gpt-6-sol": { in: 2, cached: 0.2, out: 10, write: 2.5, long: true },
  "gpt-6-luna": { in: 0.1, cached: 0.01, out: 0.5, write: 0.125, long: true },
  "gpt-5.6-sol": { in: 4, cached: 0.4, out: 20, write: 5, long: true },
  "gpt-5.6-terra": { in: 2, cached: 0.2, out: 12, write: 2.5, long: true },
  "gpt-5.6-luna": { in: 0.2, cached: 0.02, out: 1.2, write: 0.25, long: true },
  "gpt-5.5": { in: 5, cached: 0.5, out: 30, long: true },
  "gpt-5.5-pro": { in: 30, out: 180, long: true },
  "gpt-5.4": { in: 2.5, cached: 0.25, out: 15, long: true },
  "gpt-5.4-pro": { in: 30, out: 180, long: true },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cached: 0.02, out: 1.25 },
  "gpt-5.3-codex": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.2": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.2-pro": { in: 21, out: 168 },
  "gpt-5.1": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5-mini": { in: 0.25, cached: 0.025, out: 2 },
  "gpt-5-nano": { in: 0.05, cached: 0.005, out: 0.4 },
  "gpt-5-pro": { in: 15, out: 120 },
};
const LONG_CONTEXT = 272_000;

let overrides: Record<string, Price> | undefined;
function priceOverrides(): Record<string, Price> {
  if (overrides) return overrides;
  overrides = {};
  const raw = process.env.YAGAMI_OPENAI_PRICES;
  if (!raw) return overrides;
  try {
    for (const [m, p] of Object.entries(JSON.parse(raw) as Record<string, number[]>)) {
      if (!Array.isArray(p) || p.length < 3 || !p.every((n) => typeof n === "number")) throw new Error(`${m}: want [in, cachedIn, out]`);
      overrides[m] = { in: p[0], cached: p[1], out: p[2], ...(p[3] !== undefined ? { write: p[3] } : {}) };
    }
  } catch (e) {
    throw new ProviderSetupError(`YAGAMI_OPENAI_PRICES is not valid ('{"model":[in,cachedIn,out]}' in $/M tokens): ${(e as Error).message}`);
  }
  return overrides;
}

const warnedPrice = new Set<string>();
/** Price of a model id, also for dated snapshots (gpt-5.5-2026-04-23 → gpt-5.5). */
function priceOf(...ids: string[]): Price | undefined {
  const o = priceOverrides();
  for (const id of ids.flatMap((m) => [m, m.replace(/-\d{4}-\d{2}-\d{2}$/, "")])) if (o[id] ?? PRICES[id]) return o[id] ?? PRICES[id];
  const id = ids[ids.length - 1];
  if (!warnedPrice.has(id)) {
    warnedPrice.add(id);
    console.warn(`openai: no price for ${id}; its cost is logged as 0 (set YAGAMI_OPENAI_PRICES='{"${id}":[in,cachedIn,out]}' in $/M tokens)`);
  }
  return undefined;
}

/** Dollars for a response's usage. OpenAI's input_tokens include cached and cache-written tokens. */
function costOf(p: Price | undefined, u: { input: number; cacheRead: number; cacheWrite: number; output: number }): number {
  if (!p) return 0;
  const total = u.input + u.cacheRead + u.cacheWrite;
  const [fi, fo] = p.long && total > LONG_CONTEXT ? [2, 1.5] : [1, 1];
  return ((u.input * p.in + u.cacheRead * (p.cached ?? p.in) + u.cacheWrite * (p.write ?? p.in)) * fi + u.output * p.out * fo) / 1e6;
}

/** "max" exists from GPT-5.6 on; earlier models top out at "xhigh" (gpt-5.5: none…xhigh). */
function apiEffort(model: string, effort: Effort): ReasoningEffort {
  if (effort !== "max") return effort;
  const v = /^gpt-(\d+)(?:\.(\d+))?/.exec(model);
  return v && (Number(v[1]) > 5 || (Number(v[1]) === 5 && Number(v[2] ?? 0) >= 6)) ? "max" : "xhigh";
}

/** Anthropic-format turns as Responses input: user text/images in order, assistant text as its final answer. */
function toInput(messages: ProviderRequest["messages"]): ResponseInputItem[] {
  return messages.map((m) => {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "assistant") {
      const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
      // Codex-style replay of an earlier reply (no id needed); thinking and tool blocks are dropped.
      return { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] } as unknown as ResponseInputItem;
    }
    const content = blocks.map((b): ResponseInputContent => {
      if (b.type === "text") return { type: "input_text", text: b.text };
      if (b.type === "image" && b.source.type === "base64") return { type: "input_image", detail: "auto", image_url: `data:${b.source.media_type};base64,${b.source.data}` };
      if (b.type === "image" && b.source.type === "url") return { type: "input_image", detail: "auto", image_url: b.source.url };
      throw new Error(`openai: unsupported ${b.type} block in a user turn`);
    });
    return { type: "message", role: "user", content } satisfies ResponseInputItem;
  });
}

// --- Structured outputs ------------------------------------------------------------------------
// The schemas come from betaZodOutputFormat, which shapes them for Anthropic: keywords Anthropic
// rejects (enum, const, minimum, maxItems, …) are folded into the description as `{enum: [...]}`, and
// optional properties are left out of `required`. OpenAI strict mode supports most of those keywords
// but wants every property required, so: restore what strict mode enforces, make optional properties
// required-but-nullable, and drop the nulls from the reply again (zod's .optional() rejects null).

const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
const NUMBER_KW = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const ARRAY_KW = new Set(["minItems", "maxItems"]);
const KEEP = new Set(["type", "description", "title", "properties", "required", "additionalProperties", "items", "anyOf", "$ref", "$defs", "enum", "format", ...NUMBER_KW, ...ARRAY_KW]);
type Json = Record<string, unknown>;

/** Split a betaZodOutputFormat description into its text and the folded `{key: json, ...}` keywords. */
function unfold(desc: string): { text: string; kw: Json } {
  const at = desc.startsWith("{") ? 0 : desc.lastIndexOf("\n\n{") + 2;
  if (at === 1 || !desc.endsWith("}")) return { text: desc, kw: {} };
  const body = desc.slice(at + 1, -1);
  const kw: Json = {};
  for (let pos = 0; pos < body.length; ) {
    const key = /^([A-Za-z_$][\w$]*): /.exec(body.slice(pos));
    if (!key) return { text: desc, kw: {} };
    pos += key[0].length;
    // The value ends at a ", key: " boundary (or the end) where it parses as JSON.
    let end = -1;
    for (let j = pos; j <= body.length; j++) {
      if (j < body.length && !(body.startsWith(", ", j) && /^, [A-Za-z_$][\w$]*: /.test(body.slice(j)))) continue;
      try {
        kw[key[1]] = JSON.parse(body.slice(pos, j));
        end = j;
        break;
      } catch {
        // not the end of this value yet
      }
    }
    if (end < 0) return { text: desc, kw: {} };
    pos = end + 2;
  }
  return { text: desc.slice(0, Math.max(0, at - 2)), kw };
}

const fold = (text: string, kw: Json) =>
  Object.keys(kw).length ? `${text ? text + "\n\n" : ""}{${Object.entries(kw).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}` : text;

const nullable = (s: Json): boolean =>
  s.type === "null" || (Array.isArray(s.type) && s.type.includes("null")) || (Array.isArray(s.anyOf) && (s.anyOf as Json[]).some(nullable));

interface Strict {
  schema: Json;
  /** Properties made nullable because they were optional, per object schema (to drop their nulls). */
  optional: Map<Json, Set<string>>;
  /** False when the schema uses something strict mode can't express (allOf). */
  strict: boolean;
}

export function strictSchema(input: Record<string, unknown>): Strict {
  const out: Strict = { schema: {}, optional: new Map(), strict: true };
  const root = structuredClone(input) as Json;
  const defs = (root.$defs ?? {}) as Record<string, Json>;
  const resolve = (s: Json): Json => (typeof s.$ref === "string" && s.$ref.startsWith("#/$defs/") ? (defs[s.$ref.slice(8)] ?? s) : s);
  const walk = (s: Json): Json => {
    if (Array.isArray(s.allOf) && s.allOf.length === 1) s = { ...(s.allOf[0] as Json), ...s, allOf: undefined };
    if (typeof s.$ref === "string") return { $ref: s.$ref };
    const { text, kw } = typeof s.description === "string" ? unfold(s.description) : { text: undefined, kw: {} };
    const n: Json = {};
    const extra: Json = {};
    const types = ([] as unknown[]).concat(s.type ?? []);
    for (const [k, v] of Object.entries({ ...s, ...kw })) {
      if (v === undefined || k === "description" || k === "$schema") continue;
      if (k === "const") n.enum = [v];
      else if (k === "format" && !FORMATS.has(v as string)) extra[k] = v;
      else if ((NUMBER_KW.has(k) && !types.some((t) => t === "number" || t === "integer")) || (ARRAY_KW.has(k) && !types.includes("array"))) extra[k] = v;
      else if (k === "allOf") {
        out.strict = false;
        n.allOf = (v as Json[]).map(walk);
      } else if (KEEP.has(k)) n[k] = v;
      else extra[k] = v;
    }
    const description = fold(text ?? "", extra);
    if (description) n.description = description;
    if (Array.isArray(n.enum) && types.includes("null") && !n.enum.includes(null)) n.enum.push(null);
    if (n.anyOf) n.anyOf = (n.anyOf as Json[]).map(walk);
    if (n.items && !Array.isArray(n.items)) n.items = walk(n.items as Json);
    if (types.includes("object") || n.properties) {
      const props = (n.properties ?? {}) as Record<string, Json>;
      const required = new Set((n.required as string[] | undefined) ?? []);
      const optional = new Set<string>();
      n.properties = Object.fromEntries(
        Object.entries(props).map(([k, p]) => {
          const w = walk(p);
          if (required.has(k) || nullable(resolve(p))) return [k, w];
          optional.add(k);
          return [k, { anyOf: [w, { type: "null" }] }];
        }),
      );
      n.required = Object.keys(props);
      n.additionalProperties = false;
      if (optional.size) out.optional.set(n, optional);
    }
    return n;
  };
  // Definitions first, so `resolve` sees their final shape when checking nullability.
  if (root.$defs) for (const [k, d] of Object.entries(defs)) defs[k] = walk(d);
  out.schema = walk({ ...root, $defs: undefined });
  if (root.$defs) out.schema.$defs = defs;
  return out;
}

/** Drop the nulls the model wrote for optional properties, following the schema. */
export function dropOptionalNulls(st: Strict, value: unknown, s: Json = st.schema): void {
  const defs = (st.schema.$defs ?? {}) as Record<string, Json>;
  if (typeof s.$ref === "string") s = defs[s.$ref.slice(8)] ?? {};
  if (Array.isArray(s.anyOf)) {
    const variants = (s.anyOf as Json[]).map((v) => (typeof v.$ref === "string" ? (defs[v.$ref.slice(8)] ?? {}) : v));
    const pick = Array.isArray(value)
      ? variants.find((v) => v.items)
      : value && typeof value === "object"
        ? variants.find((v) => v.properties && Object.keys(value).every((k) => k in (v.properties as Json)))
        : undefined;
    if (pick) dropOptionalNulls(st, value, pick);
    return;
  }
  if (Array.isArray(value) && s.items) for (const v of value) dropOptionalNulls(st, v, s.items as Json);
  else if (value && typeof value === "object" && s.properties) {
    const opt = st.optional.get(s);
    const props = s.properties as Record<string, Json>;
    for (const [k, v] of Object.entries(value as Json)) {
      if (v === null && opt?.has(k)) delete (value as Json)[k];
      else if (props[k]) dropOptionalNulls(st, v, props[k]);
    }
  }
}

// --- The call ----------------------------------------------------------------------------------

/**
 * Streamed, with an idle watchdog: a healthy stream sends events steadily, a stalled one goes quiet.
 * Reasoning is hidden, so a reasoning summary is requested to keep events flowing while the model
 * thinks; the window is longer before the first visible text (a model may think for minutes, and
 * Node's fetch drops a body silent for 5 minutes anyway). Non-streaming would need a timeout as long
 * as the longest legitimate call (tens of minutes) to tell a slow call from a hung one.
 */
const STALL_MS = Number(process.env.YAGAMI_STALL_MS) || 90_000;
const THINK_STALL_MS = Math.max(STALL_MS, 270_000);

/** Some organizations may not request reasoning summaries (unverified): stop asking after the first refusal. */
let summaries = true;
/** Schemas OpenAI's strict mode rejected (by content): sent non-strict from then on. */
const looseSchemas = new Set<string>();

let client: OpenAI | undefined;

const TRANSIENT_FAILURES = new Set(["server_error", "rate_limit_exceeded", "vector_store_timeout"]);
const POLICY_FAILURES = new Set(["bio_policy", "misalignment_policy_violation", "image_content_policy_violation"]);

function classify(e: unknown, label: string): Error {
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof OpenAI.APIError && e.status !== undefined) {
    if (e.status === 401) return new ProviderSetupError(`${label}: OPENAI_API_KEY was rejected (401): ${msg}`);
    if (e.status === 429 && e.code === "insufficient_quota") return new ProviderSetupError(`${label}: the OpenAI account is out of credits (429 insufficient_quota): ${msg}`);
    if (e.status === 403 || e.status === 404) return new ProviderSetupError(`${label}: ${e.status} from OpenAI (model access or YAGAMI_OPENAI_MODEL): ${msg}`);
    if (e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500) return new ProviderTransientError(`${label}: OpenAI ${e.status}: ${msg}`);
    return new Error(`${label}: OpenAI ${e.status}: ${msg}`);
  }
  // Connection drops, timeouts, a stream cut mid-way, a server `error` event (no HTTP status): worth a retry.
  if (e instanceof OpenAI.APIError && /invalid|unsupported|context_length/i.test(e.code ?? "")) return new Error(`${label}: OpenAI: ${msg}`);
  return new ProviderTransientError(`${label}: OpenAI connection: ${msg}`);
}

export const openaiApi: Provider = async (req) => {
  if (!process.env.OPENAI_API_KEY) throw new ProviderSetupError("set OPENAI_API_KEY");
  client ??= new OpenAI({ maxRetries: 2 });
  const st = req.schema ? strictSchema(req.schema) : undefined;
  const schemaKey = req.schema ? JSON.stringify(req.schema) : "";
  let effort: ReasoningEffort | undefined = apiEffort(req.model, req.effort);
  const t0 = Date.now();

  // Up to a few re-sends with a request field the model or account rejected (400) toned down.
  for (let attempt = 0; ; attempt++) {
    const body: ResponseCreateParamsStreaming = {
      model: req.model,
      ...(req.system ? { instructions: req.system } : {}),
      input: toInput(req.messages),
      max_output_tokens: req.maxTokens,
      ...(effort ? { reasoning: { effort, ...(summaries ? { summary: "auto" as const } : {}) } } : {}),
      ...(st ? { text: { format: { type: "json_schema", name: "reply", schema: st.schema, strict: st.strict && !looseSchemas.has(schemaKey) } } } : {}),
      // Parallel calls share long system prompts: one key routes them to the same prompt cache.
      prompt_cache_key: `yagami-${crypto.createHash("sha1").update(req.system).digest("hex").slice(0, 16)}`,
      store: false,
      stream: true,
    };
    const local = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, local.signal]) : local.signal;
    let stalled = false;
    let lastEvent = Date.now();
    let texting = false;
    let ttftMs: number | undefined;
    const watchdog = setInterval(() => {
      if (Date.now() - lastEvent < (texting ? STALL_MS : THINK_STALL_MS)) return;
      stalled = true;
      local.abort();
    }, 5_000);
    let final: OpenAIResponse | undefined;
    try {
      const stream = await client.responses.create(body, { signal });
      for await (const ev of stream) {
        lastEvent = Date.now();
        if (ev.type === "response.output_item.added") ttftMs ??= Date.now() - t0;
        if (ev.type === "response.output_text.delta") texting = true;
        if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") final = ev.response;
      }
      // An abort mid-stream ends the SDK's iteration quietly.
      if (signal.aborted) throw new OpenAI.APIUserAbortError();
    } catch (e) {
      if (req.signal?.aborted) throw e;
      if (stalled) throw new ProviderTransientError(`${req.label}: OpenAI stream stalled (no event for ${(texting ? STALL_MS : THINK_STALL_MS) / 1000} s)`);
      if (e instanceof OpenAI.BadRequestError && attempt < 4) {
        const what = `${e.param ?? ""} ${e.message}`;
        if (/reasoning\.summary|summar/i.test(what) && summaries) {
          summaries = false;
          continue;
        }
        if (/reasoning\.effort|reasoning_effort/i.test(what) && effort) {
          effort = effort === "max" ? "xhigh" : effort === "xhigh" ? "high" : undefined;
          continue;
        }
        if (st && !looseSchemas.has(schemaKey) && st.strict && (e.code === "invalid_json_schema" || /text\.format|schema/i.test(what))) {
          console.warn(`${req.label}: OpenAI strict mode rejected the reply schema, sending it non-strict (${e.message})`);
          looseSchemas.add(schemaKey);
          continue;
        }
      }
      throw classify(e, req.label);
    } finally {
      clearInterval(watchdog);
    }
    if (!final) throw new ProviderTransientError(`${req.label}: OpenAI stream ended without a final response`);
    if (final.status === "failed" && !POLICY_FAILURES.has(final.error?.code ?? "")) {
      const code = final.error?.code ?? "unknown";
      const err = `${req.label}: OpenAI response failed (${code}): ${final.error?.message ?? ""}`;
      throw TRANSIENT_FAILURES.has(code) ? new ProviderTransientError(err) : new Error(err);
    }

    const parts = final.output.flatMap((o) => (o.type === "message" ? o.content : []));
    let text = parts.map((p) => (p.type === "output_text" ? p.text : "")).join("");
    const refused = parts.some((p) => p.type === "refusal") || final.status === "failed" || final.incomplete_details?.reason === "content_filter";
    const stopReason = refused ? "refusal" : final.status === "incomplete" && final.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end";
    if (st?.optional.size && stopReason === "end") {
      try {
        const data: unknown = JSON.parse(text);
        dropOptionalNulls(st, data);
        text = JSON.stringify(data);
      } catch {
        // not JSON (non-strict reply): the caller's parse reports it
      }
    }
    const u = final.usage;
    const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = u?.input_tokens_details?.cache_write_tokens ?? 0;
    // Anthropic's convention (the usage log mixes providers): `input` excludes cache reads and writes.
    const usage = { input: (u?.input_tokens ?? 0) - cacheRead - cacheWrite, output: u?.output_tokens ?? 0, cacheRead, cacheWrite };
    const model = final.model || req.model;
    return {
      text,
      model,
      stopReason,
      usage: { input: usage.input, output: usage.output, cacheRead, ...(cacheWrite ? { cacheWrite } : {}) },
      cost: costOf(priceOf(model, req.model), usage),
      billing: "api",
      ...(ttftMs !== undefined ? { ttftMs } : {}),
    } satisfies ProviderResult;
  }
};
