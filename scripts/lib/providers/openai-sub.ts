// OpenAI models through a ChatGPT subscription: every call runs headless Codex (`codex exec`) logged
// in with ChatGPT, so the calls are covered by the subscription instead of billed to an API key.
// Codex is stripped down to a plain model call: our system prompt replaces its agent prompt
// (model_instructions_file), its tools, skills, plugins, hooks, AGENTS.md and environment context are
// off, the user's config.toml is ignored (it may point at another provider), no saved session, a
// read-only sandbox and an empty temp dir as cwd. What's left of Codex is ~470 tokens of tool specs.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { type Provider, type ProviderRequest, type ProviderResult, ProviderSetupError, ProviderTransientError } from "./types";

const LOGIN_HOW = "log in to Codex with your ChatGPT account: codex login";

/** A child with no output for this long has hung (with the wire trace on, a working one streams steadily). */
const STALL_MS = 10 * 60_000;

/**
 * Codex features that add tools or prompt text. Set through `-c features.<name>=false` rather than
 * `--disable`, which fails on names a Codex version doesn't know.
 */
const FEATURES_OFF = [
  "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "in_app_browser",
  "image_generation", "view_image", "multi_agent", "skill_search", "skill_mcp_dependency_install", "tool_suggest", "sleep_tool", "goals", "memories",
  "code_mode_host", "workspace_dependencies", "realtime_conversation",
  // Codex retries a dead connection forever with this on (each retry is output, so no stall either):
  // off, it gives up after a few and the pipeline's own retry waits take over.
  "unbounded_connection_retries",
];

/** Leads the system prompt: what's left of Codex's tools (apply_patch, request_user_input) must stay unused. */
const PREAMBLE = "You are answering a single request as a plain model. Reply directly with the answer: do not run commands, read or edit files, use tools or ask questions.";

// Each call is a whole Codex process: cap how many run at once.
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

/** Codex's auth file says ChatGPT: checked up front, since a logged-out Codex retries for ~40 s before failing. */
function loggedInWithChatGpt(): boolean {
  try {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const a = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as { auth_mode?: string; tokens?: unknown };
    return a.auth_mode === "chatgpt" && !!a.tokens;
  } catch {
    return false;
  }
}

/**
 * The conversation as one prompt: Codex takes a single user message, so earlier turns become a
 * labelled transcript ending with the last user turn. Images go to files attached with `-i` (Codex
 * puts them ahead of the text as [Image #1], [Image #2], …), referenced where they stood.
 */
function prompt(messages: Anthropic.Beta.BetaMessageParam[], dir: string): { text: string; images: string[] } {
  const images: string[] = [];
  const render = (content: Anthropic.Beta.BetaMessageParam["content"]) => {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const b of content) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "image" && b.source.type === "base64") {
        const file = path.join(dir, `image-${images.length + 1}.${b.source.media_type.split("/")[1]}`);
        fs.writeFileSync(file, Buffer.from(b.source.data, "base64"));
        images.push(file);
        parts.push(`[Image #${images.length}]`);
      }
    }
    return parts.filter((p) => p.trim()).join("\n\n");
  };
  const last = messages.at(-1);
  const earlier = last?.role === "user" ? messages.slice(0, -1) : messages;
  if (!earlier.length) return { text: last ? render(last.content) : "", images };
  const out = ["This conversation continues an earlier exchange. The earlier turns follow in order: the user's messages and your own replies. Reply to the current message at the end as you would in that conversation."];
  for (const m of earlier) out.push(`<earlier_${m.role === "user" ? "user_message" : "assistant_reply"}>\n${render(m.content)}\n</earlier_${m.role === "user" ? "user_message" : "assistant_reply"}>`);
  if (last?.role === "user") out.push(`<current_user_message>\n${render(last.content)}\n</current_user_message>`);
  return { text: out.join("\n\n"), images };
}

type Schema = Record<string, unknown>;

/**
 * The schema for OpenAI's strict mode, from the Anthropic SDK's version (betaZodOutputFormat). That
 * one moves keywords Anthropic doesn't enforce into the description as "{enum: [...], ...}": enum
 * and const go back as keywords (strict mode enforces them), the rest stays as a hint, $schema goes.
 * Strict mode wants every property required: optional ones become nullable, and `optional` records
 * them so their nulls can be dropped from the reply (zod's .optional() rejects null).
 */
function strictSchema(schema: Schema, optional: WeakMap<object, Set<string>>): Schema {
  const s: Schema = { ...schema };
  const hint = typeof s.description === "string" ? /(?:^|\n\n)\{(.*)\}$/s.exec(s.description) : null;
  if (hint) {
    let kept: string | undefined;
    try {
      const kw = JSON.parse(`{${hint[1].replace(/(^|, )([$\w]+): /g, '$1"$2": ')}}`) as Schema;
      for (const k of ["enum", "const"]) if (k in kw) s[k] = kw[k];
      for (const k of ["enum", "const", "$schema"]) delete kw[k];
      kept = Object.keys(kw).length ? `{${Object.entries(kw).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}` : undefined;
    } catch {
      kept = hint[0].trimStart(); // not the SDK's format: leave it
    }
    const desc = [(s.description as string).slice(0, hint.index), kept].filter(Boolean).join("\n\n");
    if (desc) s.description = desc;
    else delete s.description;
  }
  if (s.$defs) s.$defs = Object.fromEntries(Object.entries(s.$defs as Record<string, Schema>).map(([k, v]) => [k, strictSchema(v, optional)]));
  if (s.items) s.items = strictSchema(s.items as Schema, optional);
  for (const k of ["anyOf", "allOf"]) if (Array.isArray(s[k])) s[k] = (s[k] as Schema[]).map((v) => strictSchema(v, optional));
  if (s.properties) {
    const props = Object.fromEntries(Object.entries(s.properties as Record<string, Schema>).map(([k, v]) => [k, strictSchema(v, optional)]));
    const required = new Set((s.required as string[] | undefined) ?? []);
    const added = new Set(Object.keys(props).filter((k) => !required.has(k)));
    for (const k of added) props[k] = nullable(props[k]);
    s.properties = props;
    s.required = Object.keys(props);
    if (added.size) optional.set(s, added);
  }
  return s;
}

function nullable(s: Schema): Schema {
  if (s.$ref || s.anyOf || s.allOf || s.const !== undefined) return { anyOf: [s, { type: "null" }] };
  const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
  if (types.includes("null")) return s;
  return { ...s, type: [...types, "null"], ...(Array.isArray(s.enum) ? { enum: [...s.enum, null] } : {}) };
}

/** The reply with the nulls of optional properties dropped (they were only nullable for strict mode). */
function dropOptionalNulls(v: unknown, s: Schema | undefined, root: Schema, optional: WeakMap<object, Set<string>>): unknown {
  if (!s || v === null || typeof v !== "object") return v;
  if (typeof s.$ref === "string") return dropOptionalNulls(v, (root.$defs as Record<string, Schema> | undefined)?.[s.$ref.split("/").pop()!], root, optional);
  if (Array.isArray(s.anyOf)) return (s.anyOf as Schema[]).reduce<unknown>((acc, a) => dropOptionalNulls(acc, a, root, optional), v);
  if (Array.isArray(v)) return v.map((x) => dropOptionalNulls(x, s.items as Schema | undefined, root, optional));
  const props = s.properties as Record<string, Schema> | undefined;
  if (!props) return v;
  const opt = optional.get(s);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!(x === null && opt?.has(k))) out[k] = dropOptionalNulls(x, props[k], root, optional);
  return out;
}

interface Outcome {
  text: string;
  model?: string;
  usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  ttftMs?: number;
  /** Why the turn failed (Codex's own message), if it did. */
  failure?: string;
}

/** Error of a failed run, by kind: setup (log in), usage cap (hours away), transient (retry later) or plain. */
function codexError(label: string, why: string): Error {
  const msg = `${label}: codex failed: ${why}`;
  if (/401|unauthori[sz]ed|not logged in|log ?in again|refresh token|token (is )?(expired|invalid)|authentication/i.test(why)) return new ProviderSetupError(`${msg} (${LOGIN_HOW})`);
  // The plan's usage cap resets hours later: retrying in a minute won't help.
  if (/usage limit|hit your .*limit|usage_limit|quota/i.test(why)) return new Error(`${msg} (ChatGPT plan usage limit)`);
  if (/rate.?limit|429|too many requests|overloaded|server.?error|50[0-9]|stream disconnected|error sending request|connection|timed? ?out|network|dns|ECONN|ETIMEDOUT|socket|unavailable/i.test(why))
    return new ProviderTransientError(msg);
  return new Error(msg);
}

/** One `codex exec` process: the prompt in on stdin, JSONL events out (and the wire trace on stderr). */
function runCli(req: ProviderRequest, effort: string, schema: Schema | undefined, onConnected: () => void): Promise<Outcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-codex-"));
  const work = path.join(dir, "cwd"); // empty: nothing for the model to look at
  fs.mkdirSync(work);
  const { text, images } = prompt(req.messages, dir);
  // System prompts run to ~120k chars: a file, not an argument.
  const instructions = path.join(dir, "instructions.md");
  fs.writeFileSync(instructions, `${PREAMBLE}\n\n${req.system}`);
  const last = path.join(dir, "last.txt");
  const schemaFile = path.join(dir, "schema.json");
  if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const args = [
    "exec",
    "--json",
    "--color", "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config", // the user's config.toml may route to another provider/model
    "--ignore-rules",
    "--sandbox", "read-only",
    "-C", work,
    "-m", req.model,
    "-c", "model_provider=openai",
    "-c", `model_reasoning_effort=${effort}`,
    "-c", "model_verbosity=medium", // Codex asks for terse replies by default; the API's default is medium
    "-c", "hide_agent_reasoning=true",
    "-c", `model_instructions_file=${JSON.stringify(instructions)}`,
    "-c", "include_permissions_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", "skills.include_instructions=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "web_search=disabled",
    "-c", "check_for_update_on_startup=false",
    "-c", "analytics.enabled=false", // its flush held every exit ~3 s after the reply was in
    ...FEATURES_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
    ...(schema ? ["--output-schema", schemaFile] : []),
    "-o", last,
    ...images.flatMap((f) => ["-i", f]),
    "--",
    "-",
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The websocket trace is the only sign of life while a long reply streams (exec's JSON events
    // only report whole items), and it shows the first output and the model.
    RUST_LOG: "warn,tungstenite::protocol=trace,tungstenite::protocol::frame=off",
  };
  // An API key in the env would take precedence over the ChatGPT login (and bill the API).
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child: ChildProcess;
    try {
      child = spawn("codex", args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
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
    const out: Outcome = { text: "", usage: {} };
    let lastError = "";
    let unauthorized = 0;
    let stderrTail = "";
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

    const onEvent = (line: string) => {
      let ev: { type?: string; message?: string; error?: { message?: string }; usage?: Outcome["usage"]; item?: { type?: string; text?: string } };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "turn.completed") out.usage = ev.usage ?? {};
      else if (ev.type === "turn.failed") out.failure = ev.error?.message ?? (lastError || "turn failed");
      else if (ev.type === "item.completed" && ev.item?.type === "agent_message") out.text = ev.item.text ?? out.text;
      else if (ev.type === "error" && ev.message) {
        lastError = ev.message;
        // Logged out or revoked (twice: once may be an expired token Codex is refreshing): Codex
        // would retry ten times over ~40 s first.
        if (/401 Unauthorized/.test(ev.message) && ++unauthorized >= 2) kill();
      }
    };
    const onTrace = (line: string) => {
      if (!line.includes("Received message")) {
        if (!/ TRACE /.test(line)) stderrTail = (stderrTail + line + "\n").slice(-2000);
        return;
      }
      onConnected();
      if (out.ttftMs === undefined && line.includes('"type":"response.output_item.added"')) out.ttftMs = Date.now() - t0;
      if (line.includes('"type":"response.completed"')) out.model = /"model":"([^"]+)"/.exec(line)?.[1] ?? out.model;
    };
    const lines = (stream: NodeJS.ReadableStream, fn: (line: string) => void) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (d: string) => {
        lastOutput = Date.now();
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          fn(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      stream.on("end", () => buf && fn(buf));
    };
    lines(child.stdout!, onEvent);
    lines(child.stderr!, onTrace);
    child.stdin!.on("error", () => {}); // EPIPE when the child dies early; its exit says why
    child.stdin!.end(text);

    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(e.code === "ENOENT" ? new ProviderSetupError(`Codex (the codex CLI) is not installed or not on PATH: install it (npm i -g @openai/codex), then ${LOGIN_HOW}`) : e);
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      req.signal?.removeEventListener("abort", onAbort);
      try {
        out.text = fs.readFileSync(last, "utf8") || out.text;
      } catch {
        // no final message: the failure below says why
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (stalled) return fail(new ProviderTransientError(`${req.label}: codex produced no output for ${STALL_MS / 60_000} min`));
      if (unauthorized >= 2) return fail(new ProviderSetupError(`${req.label}: ChatGPT login rejected (${lastError}): ${LOGIN_HOW}`));
      if (out.failure) return fail(codexError(req.label, out.failure));
      if (code !== 0) return fail(codexError(req.label, lastError || stderrTail.trim().slice(-500) || `exit code ${code}`));
      settled = true;
      resolve(out);
    });
  });
}

/**
 * Open once one Codex process got through to the model. Codex refreshes an aging ChatGPT token at
 * startup and the refresh token is single-use: parallel first calls could race to refresh it (the
 * losers failing, or invalidating the login), so the first call goes alone until it's connected.
 */
let authGate: Promise<void> | undefined;

export const openaiSub: Provider = async (req) => {
  if (!loggedInWithChatGpt()) throw new ProviderSetupError(`${req.label}: Codex is not logged in with a ChatGPT account: ${LOGIN_HOW}`);
  const effort = req.effort === "max" ? "xhigh" : req.effort;
  const optional = new WeakMap<object, Set<string>>();
  const schema = req.schema ? strictSchema(req.schema, optional) : undefined;
  let opened = () => {};
  if (authGate) await authGate;
  else authGate = new Promise((r) => (opened = r));
  await acquire(req.signal).catch((e) => {
    opened();
    throw e;
  });
  try {
    const usage = { input: 0, output: 0, cacheRead: 0 };
    for (let attempt = 0; ; attempt++) {
      const o = await runCli(req, effort, schema, opened);
      // OpenAI counts cached tokens inside input; the pipeline (Anthropic's convention) apart.
      usage.input += (o.usage.input_tokens ?? 0) - (o.usage.cached_input_tokens ?? 0);
      usage.cacheRead += o.usage.cached_input_tokens ?? 0;
      usage.output += o.usage.output_tokens ?? 0;
      const done = (text: string): ProviderResult => ({ text, model: o.model ?? req.model, stopReason: "end", usage, cost: 0, billing: "subscription", ttftMs: o.ttftMs });
      if (!schema) return done(o.text);
      try {
        return done(JSON.stringify(dropOptionalNulls(JSON.parse(o.text), schema, schema, optional)));
      } catch {
        if (attempt >= 1) throw new Error(`${req.label}: reply is not valid JSON (twice): ${o.text.slice(0, 200)}`);
      }
    }
  } finally {
    opened();
    release();
  }
};
