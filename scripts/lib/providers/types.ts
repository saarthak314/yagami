// The contract between the pipeline's model layer (scripts/lib/claude.ts) and a model provider.
// The pipeline speaks Anthropic's message format everywhere (conversations are stored and continued
// in it). Providers other than the Anthropic API take that format and convert it themselves:
// text and base64 image blocks are content; thinking blocks are dropped; cache_control is ignored.

import type Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Where model calls go.
 * - "anthropic":   Claude via the Anthropic API (ANTHROPIC_API_KEY)
 * - "claude-sub":  Claude via a Claude subscription (headless Claude Code, logged in with claude.ai)
 * - "openai":      OpenAI models via the OpenAI API (OPENAI_API_KEY)
 * - "openai-sub":  OpenAI models via a ChatGPT subscription (headless Codex, logged in with ChatGPT)
 */
export type ProviderId = "anthropic" | "claude-sub" | "openai" | "openai-sub";

export interface ProviderRequest {
  /** Provider model id (e.g. "claude-opus-5-5", "gpt-5.5"). */
  model: string;
  effort: Effort;
  /** For logs and errors only. */
  label: string;
  /** System prompt as plain text (cache markers already stripped). */
  system: string;
  /** Conversation in Anthropic format: user/assistant turns, text and base64 image blocks. */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Output cap (tokens, including reasoning where the provider counts it). */
  maxTokens: number;
  /** JSON Schema the reply must satisfy (structured output). The reply text is then that JSON. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResult {
  /** The reply text (the JSON document when `schema` was given). */
  text: string;
  /** Model that actually answered. */
  model: string;
  stopReason: "end" | "max_tokens" | "refusal";
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /**
   * Dollars billed per call: API providers estimate it from token prices. Subscription providers
   * report 0 (the call is covered by the subscription) and say so in `billing`.
   */
  cost: number;
  billing: "api" | "subscription";
  /** Milliseconds to the first output, when known. */
  ttftMs?: number;
}

export type Provider = (req: ProviderRequest) => Promise<ProviderResult>;

/** Plain text of a content list (text blocks joined), images as "[image]". */
export function blocksText(content: string | Anthropic.Beta.BetaContentBlockParam[] | Anthropic.Beta.BetaContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** Base64 images of a content list, in order. */
export function blocksImages(content: string | Anthropic.Beta.BetaContentBlockParam[] | Anthropic.Beta.BetaContentBlock[]): { mediaType: string; data: string }[] {
  if (typeof content === "string") return [];
  const out: { mediaType: string; data: string }[] = [];
  for (const b of content) if (b.type === "image" && b.source.type === "base64") out.push({ mediaType: b.source.media_type, data: b.source.data });
  return out;
}

/** Thrown when a provider is not set up (not logged in, CLI missing, no key): the message says how to fix it. */
export class ProviderSetupError extends Error {}

/** A failure worth retrying after a wait (dropped connection, timeout, overloaded or rate-limited). */
export class ProviderTransientError extends Error {}
