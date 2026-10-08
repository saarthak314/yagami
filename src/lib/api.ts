// Client for the local build API (served by the yagami dev server, same origin).
// See work/design/web-upload.md for the contract. When the site is served without
// it (a static export), `health()` resolves to null and the upload UI stays hidden.

import { useSyncExternalStore } from "react";
import type { PipelineEvent } from "../../scripts/lib/events";

export type { PipelineEvent };

export interface Health {
  /** The model provider is set up. */
  credentials: boolean;
  /** anthropic · claude-sub · openai · openai-sub */
  provider?: string;
  /** Subscription providers cost no API dollars. */
  billing?: "api" | "subscription";
  /** How to set the provider up, when it isn't. */
  how?: string;
  tools: { poppler: boolean; tesseract: boolean; chromium: boolean };
}

export interface UploadInfo {
  title: string;
  author?: string;
  pages: number;
  kind: "text" | "scanned";
  units: { id: string; title: string; pages: [number, number]; built: boolean }[];
  /** Slug of the book already made from this exact PDF. */
  existing?: string;
}

export interface JobSummary {
  job: string;
  slug: string;
  title: string;
  kind: "build" | "fix";
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  cost: number;
  ready: number;
  total: number;
  pagesReady: boolean;
}

export class ApiError extends Error {}

async function json<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not json
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error;
    throw new ApiError(msg ?? `something went wrong (${res.status})`);
  }
  return body as T;
}

/** Health of the build server, or null when there is no build server (static site). */
export async function health(): Promise<Health | null> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

/** Upload a PDF with progress (0..1). Resolves with the upload id and what's in it. */
export function upload(file: File, onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ upload: string; info: UploadInfo }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not json
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as unknown as { upload: string; info: UploadInfo });
      else reject(new ApiError(body?.error ?? (xhr.status === 413 ? "that file is too large (300 mb max)" : `upload failed (${xhr.status || "network"})`)));
    };
    xhr.onerror = () => reject(new ApiError("upload failed — is yagami still running?"));
    xhr.onabort = () => reject(new ApiError("cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export async function startBuild(uploadId: string, units?: string[]): Promise<{ job: string; slug: string }> {
  return json(await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upload: uploadId, units }) }));
}

export async function startFix(book: string, unit: string, demo: string, problem: string): Promise<{ job: string; slug: string }> {
  return json(await fetch("/api/jobs/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book, unit, demo, problem }) }));
}

export async function listJobs(): Promise<JobSummary[]> {
  try {
    const res = await fetch("/api/jobs");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return [];
    return ((await res.json()) as { jobs: JobSummary[] }).jobs ?? [];
  } catch {
    return [];
  }
}

export async function stopJob(job: string): Promise<void> {
  await json(await fetch(`/api/jobs/${encodeURIComponent(job)}/stop`, { method: "POST" }));
}

/** Follow a job's events (replayed from the start, then live). Returns an unsubscribe function. */
/** followJob ends with this when the server has no such build (unknown id, or cleared). */
export const JOB_GONE = "this build isn't known any more";

export function followJob(job: string, onEvent: (e: PipelineEvent) => void, onEnd: (error?: string) => void): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(job)}/events`);
  let ended = false;
  let any = false;
  es.onmessage = (m) => {
    any = true;
    let e: PipelineEvent;
    try {
      e = JSON.parse(m.data) as PipelineEvent;
    } catch {
      return;
    }
    onEvent(e);
    if (e.type === "done") {
      ended = true;
      es.close();
      onEnd();
    }
  };
  es.onerror = () => {
    // The stream closes after "done"; anything else is a lost connection (server restarted).
    if (ended) return;
    if (es.readyState === EventSource.CLOSED) onEnd(any ? "lost the connection to yagami" : JOB_GONE);
  };
  return () => es.close();
}

/** Continue a stopped build, or add chapters to an existing book, without uploading again. */
export async function continueBook(book: string, units?: string[]): Promise<{ job: string; slug: string }> {
  return json(await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book, units }) }));
}

/** Forget a finished job (it stops being listed). */
export async function forgetJob(job: string): Promise<void> {
  await json(await fetch(`/api/jobs/${encodeURIComponent(job)}`, { method: "DELETE" }));
}

// --- model access (the header's model panel) -------------------------------------

export type ProviderId = "anthropic" | "claude-sub" | "openai" | "openai-sub";
export type SubProvider = "claude-sub" | "openai-sub";

export interface ProviderState {
  id: ProviderId;
  ready: boolean;
  /** Where its access comes from: an env var, a key saved from the site, or a CLI login. */
  source: "env" | "saved" | "login" | null;
  /** Last four characters of the key ("…a1b2"). */
  hint: string | null;
  billing: "api" | "subscription";
  /** Subscriptions: the CLI it runs (claude / codex) is installed. Always true for keys. */
  installed: boolean;
  /** What its models do, from the real settings ("opus 5.5 writes demos · sonnet 5.5 reviews"). */
  models: string;
}

export interface LoginState {
  provider: SubProvider;
  /** The sign-in page to open. */
  url: string | null;
  /** Claude: waiting for the code shown after signing in. */
  needsCode: boolean;
  status: "waiting" | "done" | "failed";
  error?: string;
  /** The last pasted code was refused (the login still waits for another). */
  codeError?: string;
}

export interface ModelsView {
  active: ProviderId;
  /** null: automatic (the first one set up). */
  chosen: ProviderId | null;
  /** YAGAMI_PROVIDER is set where yagami runs: choosing here is off. */
  pinned: boolean;
  providers: ProviderState[];
  login: LoginState | null;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});

export async function getModels(): Promise<ModelsView> {
  return json(await fetch("/api/models"));
}

/** Use a provider (null: automatic). */
export async function chooseProvider(provider: ProviderId | null): Promise<ModelsView> {
  return json(await fetch("/api/models/use", send("POST", { provider })));
}

/** Check a pasted API key with the provider (free) and save it. */
export async function saveKey(provider: "anthropic" | "openai", key: string): Promise<ModelsView> {
  return json(await fetch(`/api/models/key/${provider}`, send("PUT", { key })));
}

export async function removeKey(provider: "anthropic" | "openai"): Promise<ModelsView> {
  return json(await fetch(`/api/models/key/${provider}`, send("DELETE")));
}

/** Start a subscription login (the official CLI's flow); the view carries its sign-in url. */
export async function startLogin(provider: SubProvider): Promise<ModelsView> {
  return json(await fetch("/api/models/login", send("POST", { provider })));
}

/** Claude: the code shown after signing in. */
export async function sendLoginCode(code: string): Promise<ModelsView> {
  return json(await fetch("/api/models/login/code", send("POST", { code })));
}

/** Cancel a pending login (or clear a finished one). */
export async function cancelLogin(): Promise<ModelsView> {
  return json(await fetch("/api/models/login", send("DELETE")));
}

/** Window events: the model setup changed (refresh health) / open the model panel. */
export const MODELS_CHANGED = "yagami:models";
export const OPEN_MODELS = "yagami:open-models";
export const openModels = () => window.dispatchEvent(new Event(OPEN_MODELS));

/** How each provider is named: in the panel, in the header, and when it's chosen but not set up. */
export const PROVIDERS: Record<ProviderId, { name: string; short: string; missing: string; fix: string }> = {
  anthropic: { name: "anthropic api key", short: "anthropic key", missing: "no anthropic api key added", fix: "add a key or switch" },
  "claude-sub": { name: "claude plan", short: "claude plan", missing: "claude plan isn't logged in", fix: "log in or switch" },
  openai: { name: "openai api key", short: "openai key", missing: "no openai api key added", fix: "add a key or switch" },
  "openai-sub": { name: "chatgpt plan", short: "chatgpt plan", missing: "chatgpt plan isn't logged in", fix: "log in or switch" },
};
const isProvider = (id: string | undefined): id is ProviderId => !!id && id in PROVIDERS;

// The model panel's last view of the providers, shared with the rest of the page (it knows what is
// chosen, which /api/health doesn't say).
let modelsSnapshot: ModelsView | null = null;
const listeners = new Set<() => void>();
export function publishModels(v: ModelsView | null) {
  if (v === modelsSnapshot) return;
  modelsSnapshot = v;
  listeners.forEach((l) => l());
}
const subscribeModels = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** The model panel's view of the providers (null until it has loaded). */
export const useModelsView = () => useSyncExternalStore(subscribeModels, () => modelsSnapshot);

/**
 * Why the server can't use a model, or null when it can: the provider chosen isn't set up
 * ("claude subscription isn't logged in"), or none is connected at all.
 */
export function modelGap(h: Health | null | undefined, v?: ModelsView | null): { id: ProviderId | null; what: string; how: string } | null {
  if (!h || h.credentials) return null;
  // "automatic" only falls back to the anthropic key when nothing is set up: any other provider not
  // ready is one that was chosen. For anthropic, the panel's view says whether it was chosen.
  const id = isProvider(h.provider) ? h.provider : null;
  const chosen = id && (id !== "anthropic" || (v && v.chosen === "anthropic" && v.active === "anthropic"));
  if (id && chosen) return { id, what: PROVIDERS[id].missing, how: PROVIDERS[id].fix };
  return { id: null, what: "no model connected", how: "connect a model" };
}

/** Everything missing for building on this server, as short plain phrases (empty when ready). */
export function missingPrereqs(h: Health | null | undefined, v?: ModelsView | null): { what: string; how: string; scansOnly?: boolean; models?: boolean }[] {
  if (!h) return [];
  const out: { what: string; how: string; scansOnly?: boolean; models?: boolean }[] = [];
  const gap = modelGap(h, v);
  if (gap) out.push({ what: gap.what, how: gap.how, models: true });
  if (!h.tools.poppler) out.push({ what: "poppler", how: "brew install poppler" });
  if (!h.tools.chromium) out.push({ what: "headless chromium", how: "npx playwright install chromium" });
  if (!h.tools.tesseract) out.push({ what: "tesseract", how: "brew install tesseract", scansOnly: true });
  return out;
}

/** Rough cost of building on an anthropic key: about $2.50 per paper or chapter (Opus writes the demos). */
export const estimate = (units: number) => `about $${Math.round(Math.max(1, units) * 2.5)}`;

/** The server builds on a subscription: no dollar figures, it uses the plan. */
export const onPlan = (h: Health | null | undefined) => h?.billing === "subscription";

/** What building costs, in words, for the server's provider. `what`: "this paper", "3 chapters". */
export function costNote(h: Health | null | undefined, units: number, what: string): string {
  const stop = "you can stop it any time.";
  if (onPlan(h)) {
    const plan = h?.provider === "openai-sub" ? "chatgpt" : "claude";
    return `building uses your ${plan} plan${units > 0 ? ` for ${what}` : ""} — no api cost. ${stop}`;
  }
  if (h?.provider === "openai") return `building on your openai key is pay per use. ${stop}`;
  // Nothing connected yet: what it would cost either way, without claiming a provider.
  if (!h?.credentials) return units > 0 ? `${what}: ${estimate(units)} on an anthropic key, or included in a claude or chatgpt plan.` : "about $2.50 a chapter on an anthropic key, or included in a claude or chatgpt plan.";
  return units > 0 ? `building ${what} on your anthropic key costs ${estimate(units)}. ${stop}` : "building on your anthropic key costs about $2.50 a chapter.";
}

/** Touch devices: "choose", not "drop"; no keyboard hints. */
export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
