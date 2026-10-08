// Claude through a Claude subscription: every call runs headless Claude Code (`claude -p`) logged in
// with claude.ai, so the calls are covered by the subscription instead of billed to an API key.
// Claude Code is stripped down to a plain model call: our system prompt replaces its own, no tools,
// no settings/hooks/CLAUDE.md/MCP servers, no saved session, an empty temp dir as cwd.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { type Provider, type ProviderRequest, type ProviderResult, ProviderSetupError, ProviderTransientError } from "./types";

const LOGIN_HOW = "log in to Claude Code with your Claude subscription: claude auth login";

/** A child with no output for this long has hung (partial messages stream steadily while it works). */
const STALL_MS = 10 * 60_000;

/**
 * Env of the Claude Code session that launched the pipeline (if any): a nested `claude` would treat
 * itself as that session's child and pick up its effort.
 */
const PARENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT"];

// Each call is a whole Claude Code process (~200 MB): cap how many run at once.
const LIMIT = Math.max(1, Number(process.env.YAGAMI_SUB_CONCURRENCY) || 6);
let running = 0;
const queue: (() => void)[] = [];

function acquire(signal?: AbortSignal): Promise<void> {
  if (running < LIMIT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const go = () => {
      signal?.removeEventListener("abort", onAbort);
      running++;
      resolve();
    };
    const onAbort = () => {
      queue.splice(queue.indexOf(go), 1);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(go);
  });
}

function release() {
  running--;
  queue.shift()?.();
}

type Block = { type: "text"; text: string } | { type: "image"; source: Anthropic.Beta.BetaImageBlockParam["source"] };

/** Text and image blocks of a turn (thinking dropped, cache markers left out). */
function blocks(content: Anthropic.Beta.BetaMessageParam["content"]): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: Block[] = [];
  for (const b of content) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "image") out.push({ type: "image", source: b.source });
  }
  return out;
}

/**
 * The conversation as one user message: stream-json input only takes user turns, so earlier turns
 * become a labelled transcript (images kept in place), followed by the last user turn.
 */
function userContent(messages: Anthropic.Beta.BetaMessageParam[]): Block[] {
  const last = messages.at(-1);
  const earlier = last?.role === "user" ? messages.slice(0, -1) : messages;
  const out: Block[] = [];
  if (earlier.length) {
    out.push({ type: "text", text: "This conversation continues an earlier exchange. The earlier turns follow in order: the user's messages and your own replies. Reply to the current message at the end as you would in that conversation." });
    for (const m of earlier) out.push({ type: "text", text: m.role === "user" ? "[earlier user message]" : "[earlier assistant reply]" }, ...blocks(m.content));
    if (last?.role === "user") out.push({ type: "text", text: "[current user message]" });
  }
  if (last?.role === "user") out.push(...blocks(last.content));
  // Adjacent text blocks merged; empty ones dropped (the API rejects them).
  const merged: Block[] = [];
  for (const b of out) {
    const prev = merged.at(-1);
    if (b.type === "text" && !b.text.trim()) continue;
    if (b.type === "text" && prev?.type === "text") prev.text += `\n\n${b.text}`;
    else merged.push(b.type === "text" ? { ...b } : b);
  }
  return merged;
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  api_error?: string | null;
  api_error_status?: number | null;
  structured_output?: unknown;
  total_cost_usd?: number;
  ttft_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

interface Outcome {
  result: CliResult;
  /** Text of the real (non-synthetic) assistant messages, in order. */
  text: string;
  model?: string;
  /** `error` of the last synthetic assistant message (e.g. "authentication_failed", "rate_limit"). */
  error?: string;
  ttftMs?: number;
}

/** One `claude -p` process: the request in on stdin, stream-json events out. */
function runCli(req: ProviderRequest, useKey: boolean): Promise<Outcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-claude-"));
  // System prompts run to ~120k chars: a file, not an argument.
  const systemFile = path.join(dir, "system.txt");
  fs.writeFileSync(systemFile, req.system);
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", // required by stream-json output
    "--include-partial-messages", // steady output while it writes, so a silent child really is stuck
    "--system-prompt-file", systemFile,
    "--model", req.model,
    "--effort", req.effort,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const k of PARENT_ENV) delete env[k];
  // A key in the env would take precedence over the subscription login (and bill the API).
  if (!useKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child: ChildProcess;
    try {
      child = spawn("claude", args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      return reject(e);
    }
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const out: Outcome = { result: {}, text: "" };
    const texts: string[] = [];
    let gotResult = false;
    let stderr = "";
    let buf = "";
    let stalled = false;
    let lastOutput = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput < STALL_MS) return;
      stalled = true;
      kill();
    }, 5_000);
    const onAbort = () => {
      kill();
      fail(new Error(`${req.label}: aborted`));
    };
    if (req.signal?.aborted) onAbort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: { type?: string; event?: { type?: string }; message?: { model?: string; content?: { type: string; text?: string }[] }; error?: string; refused_message_id?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "stream_event" && ev.event?.type === "content_block_start") out.ttftMs ??= Date.now() - t0;
      // A safety stop withholds the reply so far and Claude Code asks once more: drop the withheld part.
      else if (ev.type === "user" && ev.refused_message_id) texts.length = 0;
      else if (ev.type === "assistant" && ev.message) {
        if (ev.message.model === "<synthetic>") out.error = ev.error ?? out.error;
        else {
          out.model = ev.message.model ?? out.model;
          for (const b of ev.message.content ?? []) if (b.type === "text" && b.text) texts.push(b.text);
        }
      } else if (ev.type === "result") {
        out.result = ev as CliResult;
        gotResult = true;
      }
    };
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      lastOutput = Date.now();
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      lastOutput = Date.now();
      stderr += d;
    });
    child.stdin!.on("error", () => {}); // EPIPE when the child dies early; its exit says why
    child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content: userContent(req.messages) } }) + "\n");

    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(e.code === "ENOENT" ? new ProviderSetupError(`Claude Code (the claude CLI) is not installed or not on PATH: install it (https://claude.com/claude-code), then ${LOGIN_HOW}`) : e);
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      req.signal?.removeEventListener("abort", onAbort);
      fs.rmSync(dir, { recursive: true, force: true });
      if (buf) onLine(buf);
      out.text = texts.join("");
      if (stalled) return fail(new ProviderTransientError(`${req.label}: claude produced no output for ${STALL_MS / 60_000} min`));
      if (!gotResult) {
        const why = stderr.trim().slice(-500) || `exit code ${code}`;
        if (/not logged in|\/login|invalid api key|oauth token/i.test(why)) return fail(new ProviderSetupError(`${req.label}: ${why}: ${LOGIN_HOW}`));
        return fail(new Error(`${req.label}: claude failed: ${why}`));
      }
      settled = true;
      resolve(out);
    });
  });
}

/** Error of a failed CLI run, by kind: setup (log in), transient (retry later) or plain. */
function cliError(label: string, o: Outcome): Error {
  const r = o.result;
  const msg = `${label}: ${r.result ?? "claude failed"}`;
  const status = r.api_error_status ?? 0;
  if (o.error === "authentication_failed" || status === 401 || /not logged in|\/login|invalid api key|oauth token/i.test(msg)) return new ProviderSetupError(`${msg} (${LOGIN_HOW})`);
  if (o.error === "billing_error") return new ProviderSetupError(`${msg} (check your Claude subscription, then ${LOGIN_HOW})`);
  // A subscription usage limit lasts hours: retrying in a minute won't help.
  if (/hit your .*limit|usage limit/i.test(msg)) return new Error(`${msg} (Claude subscription usage limit)`);
  if (o.error === "rate_limit" || o.error === "overloaded" || o.error === "server_error" || status === 429 || status >= 500 || /overloaded|rate.?limit|connection|timed? ?out|ECONN|ETIMEDOUT|socket|network|fetch failed/i.test(msg))
    return new ProviderTransientError(msg);
  return new Error(msg);
}

/** JSON text of the reply when it parses, else null. */
function jsonText(o: Outcome): string | null {
  if (o.result.structured_output !== undefined && o.result.structured_output !== null) return JSON.stringify(o.result.structured_output);
  const t = (o.result.result ?? o.text).trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    return null;
  }
}

export const claudeSub: Provider = async (req) => {
  // Testing without a subscription: keep the API key (billed to it, reported as such).
  const useKey = process.env.YAGAMI_CLAUDE_SUB_USE_KEY === "1";
  await acquire(req.signal);
  try {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (let attempt = 0; ; attempt++) {
      const o = await runCli(req, useKey);
      const u = o.result.usage ?? {};
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      cost += o.result.total_cost_usd ?? 0;
      const done = (text: string, stopReason: ProviderResult["stopReason"]): ProviderResult => ({
        text,
        model: o.model ?? req.model,
        stopReason,
        usage,
        cost: useKey ? cost : 0,
        billing: useKey ? "api" : "subscription",
        ttftMs: o.ttftMs ?? o.result.ttft_ms,
      });
      if (o.result.stop_reason === "refusal") return done(o.text, "refusal");
      // Claude Code continues a reply cut at the output cap a few times before giving up with this.
      if (o.result.api_error === "max_output_tokens" || o.error === "max_output_tokens" || o.result.stop_reason === "max_tokens") return done(o.text, "max_tokens");
      if (o.result.is_error) throw cliError(req.label, o);
      if (!req.schema) return done(o.text || (o.result.result ?? ""), "end");
      const json = jsonText(o);
      if (json !== null) return done(json, "end");
      if (attempt >= 1) throw new Error(`${req.label}: reply is not valid JSON (twice): ${(o.result.result ?? o.text).slice(0, 200)}`);
    }
  } finally {
    release();
  }
};
