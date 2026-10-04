// Client for the local build API (served by the yagami dev server, same origin).
// See work/design/web-upload.md for the contract. When the site is served without
// it (a static export), `health()` resolves to null and the upload UI stays hidden.

import type { PipelineEvent } from "../../scripts/lib/events";

export type { PipelineEvent };

export interface Health {
  credentials: boolean;
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

/** Everything missing for building on this server, as short plain phrases (empty when ready). */
export function missingPrereqs(h: Health | null | undefined): { what: string; how: string; scansOnly?: boolean }[] {
  if (!h) return [];
  const out: { what: string; how: string; scansOnly?: boolean }[] = [];
  if (!h.credentials) out.push({ what: "anthropic credentials", how: "set ANTHROPIC_API_KEY where yagami runs, then restart it" });
  if (!h.tools.poppler) out.push({ what: "poppler", how: "brew install poppler" });
  if (!h.tools.chromium) out.push({ what: "headless chromium", how: "npx playwright install chromium" });
  if (!h.tools.tesseract) out.push({ what: "tesseract", how: "brew install tesseract", scansOnly: true });
  return out;
}

/** Rough cost of building: about $2 per paper or chapter. */
export const estimate = (units: number) => `about $${Math.max(1, units) * 2}`;

/** Touch devices: "choose", not "drop"; no keyboard hints. */
export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
