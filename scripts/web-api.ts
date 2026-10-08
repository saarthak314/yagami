// The site's local API (Vite dev-server middleware, same origin, 127.0.0.1 only):
// upload a PDF, start / watch / stop builds and demo fixes. Each run is a
// `scripts/job.ts` child process printing PipelineEvent JSON lines; events are
// kept in memory (and work/jobs/<id>.jsonl) and streamed to the browser as SSE.
// Contract: work/design/web-upload.md.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import type { DemoPlan } from "../src/types";
import type { PipelineEvent } from "./lib/events";
import { defaultUnits, inspectPdf, listBooks, type Draft, type PdfInfo } from "./create-book";

const MAX_UPLOAD = 300 * 1024 * 1024;
const KEEP_JOBS = 30;

interface Upload {
  id: string;
  pdf: string;
  info: PdfInfo;
  draft: Draft;
}

type Status = "running" | "done" | "failed" | "stopped";

interface Job {
  id: string;
  slug: string;
  title: string;
  kind: "build" | "fix";
  args: string[];
  /** The upload a build came from (repeat requests for it watch the same job). */
  upload?: string;
  status: Status;
  startedAt: number;
  endedAt?: number;
  cost: number;
  demos: Map<string, boolean>; // id → ready
  /** A plan event arrived (until then the demo total isn't known). */
  planned: boolean;
  pagesReady: boolean;
  events: PipelineEvent[];
  listeners: Set<ServerResponse>;
  child?: ChildProcess;
  /** Waiting for another job to finish. */
  queued: boolean;
  stopRequested: boolean;
  log: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const has = (bin: string) => spawnSync("which", [bin]).status === 0;
const id = (prefix: string) => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// --- Model access (the site's model panel) ---------------------------------------
//
// Providers: anthropic / openai (API keys, pasted here or from the environment) and claude-sub /
// openai-sub (subscriptions, logged in through the official CLIs). A login runs the CLI's own flow:
// it prints a sign-in URL the page opens; Codex finishes by itself (its callback is on localhost),
// Claude shows a code after sign-in that the page sends back to the CLI.

const PROVIDER_IDS = ["anthropic", "claude-sub", "openai", "openai-sub"] as const;
type ProviderName = (typeof PROVIDER_IDS)[number];

interface Login {
  provider: "claude-sub" | "openai-sub";
  child: ChildProcess;
  url: string | null;
  /** Claude: waiting for the code shown after sign-in. */
  needsCode: boolean;
  status: "waiting" | "done" | "failed";
  error?: string;
  /** The last pasted code was refused (the CLI waits for another). */
  codeError?: string;
  out: string;
  /** Codex: the temporary CODEX_HOME the login writes to (copied over the real one only on success). */
  tmpHome?: string;
}

const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

/** Stop a login CLI and whatever it started (`claude` is a launcher: killing only it orphans the real process). */
function stopLogin(l: Login) {
  try {
    if (l.child.pid) process.kill(-l.child.pid, "SIGTERM");
  } catch {
    l.child.kill("SIGTERM");
  }
}
let login: Login | null = null;

/** CLI output without colours or terminal hyperlinks. */
const plain = (t: string) => t.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function loginView() {
  return login
    ? { provider: login.provider, url: login.url, needsCode: login.needsCode, status: login.status, ...(login.error ? { error: login.error } : {}), ...(login.codeError ? { codeError: login.codeError } : {}) }
    : null;
}

async function modelsView() {
  const { providersOverview, resetProvider } = await import("./lib/claude");
  // Re-resolve "automatic": a login or logout outside the page (codex logout, claude auth login in a
  // terminal) changes which provider is first set up, and the resolved one is cached.
  resetProvider();
  return { ...providersOverview(), login: loginView() };
}

/**
 * Why a login ended without working, in a line: the refused code (Claude exits after one), else the
 * CLI's last error-looking line. Never the sign-in URL or the "paste code" prompt.
 */
function loginFailure(l: Login): string {
  if (l.codeError) return `${l.codeError} — log in again for a new code`;
  const lines = plain(l.out)
    .split(/\r?\n|\r/)
    .map((x) => x.trim())
    .filter((x) => x && !/https?:\/\//.test(x) && !/paste code/i.test(x));
  const bad = lines.filter((x) => /error|fail|invalid|expired|denied|cancel/i.test(x));
  return (bad.at(-1) ?? lines.at(-1) ?? "").toLowerCase().slice(0, 200) || "the login didn't finish";
}

/** Start a subscription login; resolves with the sign-in URL once the CLI prints it. */
async function startLogin(provider: "claude-sub" | "openai-sub"): Promise<void> {
  if (login?.status === "waiting") stopLogin(login);
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: "true" }; // the page opens the URL; the CLI shouldn't open another tab
  delete env.ANTHROPIC_API_KEY; // a Claude login must not fall back to the API key
  delete env.ANTHROPIC_AUTH_TOKEN;
  // `codex login` signs the current account out as soon as it starts: log in into a temporary home
  // and copy the result over only when it succeeds, so a cancelled login keeps the old one.
  const tmpHome = provider === "openai-sub" ? fs.mkdtempSync(path.join(os.tmpdir(), "yagami-codex-")) : undefined;
  if (tmpHome) env.CODEX_HOME = tmpHome;
  const child = provider === "claude-sub" ? spawn("claude", ["auth", "login", "--claudeai"], { env, stdio: ["pipe", "pipe", "pipe"], detached: true }) : spawn("codex", ["login"], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const l: Login = { provider, child, url: null, needsCode: false, status: "waiting", out: "", tmpHome };
  login = l;
  const onData = (b: Buffer) => {
    l.out = (l.out + plain(b.toString())).slice(-8000);
    l.url ??= /https:\/\/[^\s"'<>\]]+/.exec(l.out)?.[0] ?? null;
    if (provider === "claude-sub" && /paste code/i.test(l.out)) l.needsCode = true;
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => {
    l.status = "failed";
    l.error = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${provider === "claude-sub" ? "claude code" : "codex"} is not installed` : e.message;
  });
  child.on("exit", async (code) => {
    if (l.tmpHome) {
      const got = path.join(l.tmpHome, "auth.json");
      if (code === 0 && l.status === "waiting" && fs.existsSync(got)) {
        fs.mkdirSync(codexHome(), { recursive: true });
        fs.copyFileSync(got, path.join(codexHome(), "auth.json"));
        fs.chmodSync(path.join(codexHome(), "auth.json"), 0o600);
      }
      fs.rmSync(l.tmpHome, { recursive: true, force: true });
    }
    if (l.status !== "waiting") return;
    const { resetProvider } = await import("./lib/claude");
    resetProvider();
    const ok = (await modelsView()).providers.find((x) => x.id === provider)?.ready;
    l.status = code === 0 && ok ? "done" : "failed";
    if (l.status === "failed") l.error = loginFailure(l);
  });
  for (let i = 0; i < 100 && !l.url && l.status === "waiting"; i++) await new Promise((r) => setTimeout(r, 100));
  if (!l.url && l.status === "waiting") {
    stopLogin(l);
    l.status = "failed";
    l.error = "the login didn't start (no sign-in link)";
  }
}

/** A pasted API key works: a free model-list request (401/403 = rejected). */
async function checkKey(k: "anthropic" | "openai", key: string): Promise<void> {
  let r: Response;
  try {
    r =
      k === "anthropic"
        ? await fetch(`${(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/models?limit=1`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) })
        : await fetch(`${(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new HttpError(502, "couldn't reach the api to check the key — check your connection");
  }
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "that key was rejected — check it and try again");
  if (!r.ok) throw new HttpError(502, `couldn't check the key (the api answered ${r.status})`);
}

/** Model access on this server: the active provider (scripts/lib/claude.ts), whether it is set up, and how. */
async function models(): Promise<{ ready: boolean; provider: string; billing: "api" | "subscription"; how?: string }> {
  const { providerStatus, billing, resetProvider } = await import("./lib/claude");
  resetProvider(); // as in modelsView: logins can change outside the page
  try {
    const st = providerStatus();
    return { ready: st.ready, provider: st.provider, billing: billing(), how: st.how };
  } catch (e) {
    return { ready: false, provider: "unknown", billing: "api", how: (e as Error).message };
  }
}

async function chromiumReady(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function tools() {
  return { poppler: ["pdfinfo", "pdftotext", "pdftoppm"].every(has), tesseract: has("tesseract"), chromium: await chromiumReady() };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "expected a json body");
  }
}

/** A safe file name from the X-Filename header (keeps the title fallback readable). */
function fileName(header: string | string[] | undefined): string {
  const raw = decodeURIComponent(String(Array.isArray(header) ? header[0] : (header ?? "")) || "document.pdf");
  const base = path.basename(raw).replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "document";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export function yagamiApi(): Plugin {
  const uploads = new Map<string, Upload>();
  const jobs: Job[] = [];
  let root = process.cwd();

  const jobsDir = () => path.join(root, "work", "jobs");

  function view(j: Job) {
    return {
      job: j.id,
      slug: j.slug,
      title: j.title,
      kind: j.kind,
      status: j.status,
      startedAt: j.startedAt,
      ...(j.endedAt ? { endedAt: j.endedAt } : {}),
      cost: Math.round(j.cost * 10000) / 10000,
      ready: [...j.demos.values()].filter(Boolean).length,
      // Builds: the total is only known once planned (demo events can arrive first).
      total: j.kind === "fix" || j.planned ? j.demos.size : 0,
      pagesReady: j.pagesReady,
    };
  }

  /** Jobs are saved (work/jobs/<id>.json + .jsonl) so the list and build pages survive a server restart. */
  function saveMeta(j: Job) {
    const meta = { id: j.id, slug: j.slug, title: j.title, kind: j.kind, args: j.args, upload: j.upload, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt };
    try {
      fs.mkdirSync(jobsDir(), { recursive: true });
      fs.writeFileSync(path.join(jobsDir(), `${j.id}.json`), JSON.stringify(meta));
    } catch {
      // best effort
    }
  }

  function loadSaved() {
    let files: string[] = [];
    try {
      files = fs.readdirSync(jobsDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    const metas = files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(jobsDir(), f), "utf8")) as Pick<Job, "id" | "slug" | "title" | "kind" | "args" | "upload" | "status" | "startedAt" | "endedAt">;
        } catch {
          return null;
        }
      })
      .filter((m): m is NonNullable<typeof m> => !!m && !!m.id)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-KEEP_JOBS);
    for (const m of metas) {
      const j: Job = { ...m, cost: 0, demos: new Map(), planned: false, pagesReady: false, events: [], listeners: new Set(), queued: false, stopRequested: false, log: "" };
      try {
        for (const line of fs.readFileSync(path.join(jobsDir(), `${m.id}.jsonl`), "utf8").split("\n")) if (line.trim()) apply(j, JSON.parse(line) as PipelineEvent);
      } catch {
        // no events saved
      }
      jobs.push(j);
      // A run cut off by a server restart: it is not running any more; finished work is kept.
      if (j.status === "running") finish(j, "stopped", "stopped");
    }
  }

  /** Fold one event into the job's summary state. */
  function apply(j: Job, e: PipelineEvent) {
    j.events.push(e);
    if (e.type === "cost") j.cost = e.total;
    if (e.type === "plan" && j.kind === "build") {
      j.planned = true;
      for (const d of e.demos) if (!j.demos.has(d.id)) j.demos.set(d.id, false);
    }
    if (e.type === "demo") j.demos.set(e.id, e.phase === "pass");
    if (e.type === "stage" && e.stage === "assemble" && (e.status === "done" || e.status === "skip")) j.pagesReady = true;
    // The run is over as soon as it says so (the process may take a moment to exit).
    if (e.type === "done" && j.status === "running" && !j.queued) {
      j.status = e.failures[0] === "stopped" ? "stopped" : "done";
      j.endedAt ??= Date.now();
    }
  }

  function record(j: Job, e: PipelineEvent) {
    apply(j, e);
    if (e.type === "done") saveMeta(j);
    try {
      fs.appendFileSync(path.join(jobsDir(), `${j.id}.jsonl`), JSON.stringify(e) + "\n");
    } catch {
      // the log on disk is a convenience
    }
    const msg = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of j.listeners) {
      res.write(msg);
      if (e.type === "done") res.end();
    }
    if (e.type === "done") j.listeners.clear();
  }

  const finished = (j: Job) => j.events.some((e) => e.type === "done");

  function finish(j: Job, status: Status, fallback?: string) {
    if (!finished(j)) record(j, { type: "done", seconds: (Date.now() - j.startedAt) / 1000, cost: j.cost, failures: [fallback ?? "the run stopped unexpectedly"] });
    j.status = status;
    j.endedAt ??= Date.now();
    j.child = undefined;
    j.queued = false;
    saveMeta(j);
    // Keep the list bounded: drop the oldest finished jobs.
    while (jobs.length > KEEP_JOBS) {
      const i = jobs.findIndex((x) => x.status !== "running");
      if (i < 0) break;
      jobs.splice(i, 1);
    }
    runNext();
  }

  function start(j: Job) {
    j.queued = false;
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts/job.ts"), ...j.args], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"], // stdin stays open: the child stops if this server goes away
    });
    j.child = child;
    let buf = "";
    child.stdout!.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          record(j, JSON.parse(line) as PipelineEvent);
        } catch {
          j.log += line + "\n";
        }
      }
    });
    child.stderr!.on("data", (c: Buffer) => {
      j.log = (j.log + c.toString("utf8")).slice(-20000);
    });
    child.on("error", (e) => finish(j, "failed", e.message));
    child.on("exit", (code) => {
      if (j.stopRequested || code === 130) return finish(j, "stopped", "stopped");
      // 0: all ready; 1: the run completed with some demos failed (listed in the done event).
      if (code === 0 || (code === 1 && finished(j))) return finish(j, "done");
      const last = j.log.trim().split("\n").filter(Boolean).pop();
      finish(j, "failed", last ? last.slice(0, 300) : `the run exited with code ${code}`);
    });
  }

  function runNext() {
    if (jobs.some((j) => j.child && j.child.exitCode === null && j.child.signalCode === null)) return;
    const next = jobs.filter((j) => j.status === "running" && j.queued).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (next) start(next);
  }

  function enqueue(spec: Pick<Job, "slug" | "title" | "kind" | "args" | "upload">): Job {
    fs.mkdirSync(jobsDir(), { recursive: true });
    const j: Job = {
      ...spec,
      id: id("j"),
      status: "running",
      startedAt: Date.now(),
      cost: 0,
      demos: new Map(),
      planned: false,
      pagesReady: false,
      events: [],
      listeners: new Set(),
      queued: true,
      stopRequested: false,
      log: "",
    };
    jobs.push(j);
    saveMeta(j);
    if (jobs.some((x) => x !== j && x.status === "running")) record(j, { type: "log", level: "info", message: "waiting for another build to finish" });
    runNext();
    return j;
  }

  /** Slugs reserved by builds that haven't written their book yet. */
  const reserved = () => new Set(jobs.filter((j) => j.status === "running").map((j) => j.slug));

  async function preflight(kind: "text" | "scanned" | undefined) {
    const mm = await models();
    if (!mm.ready) throw new HttpError(400, `no model access (${mm.provider}) — ${mm.how}`);
    const t = await tools();
    if (!t.poppler) throw new HttpError(400, "poppler is not installed — it reads pdfs (macOS: brew install poppler)");
    if (!t.chromium) throw new HttpError(400, "headless chromium is missing — run: npx playwright install chromium");
    if (kind === "scanned" && !t.tesseract) throw new HttpError(400, "tesseract is not installed — it reads scanned pdfs (macOS: brew install tesseract)");
  }

  // --- handlers ----------------------------------------------------------------

  async function upload(req: IncomingMessage, res: ServerResponse) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_UPLOAD) throw new HttpError(413, "that file is larger than 300 mb");
    if (!["pdfinfo", "pdftotext", "pdftoppm"].every(has)) throw new HttpError(500, "poppler is not installed — it reads pdfs (macOS: brew install poppler)");
    const uid = id("u");
    const dir = path.join(root, "work", "uploads", uid);
    fs.mkdirSync(dir, { recursive: true });
    const pdf = path.join(dir, fileName(req.headers["x-filename"]));
    let size = 0;
    const file = fs.createWriteStream(pdf);
    try {
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_UPLOAD) {
            req.unpipe(file);
            reject(new HttpError(413, "that file is larger than 300 mb"));
            req.resume();
          }
        });
        req.on("error", reject);
        file.on("error", reject);
        file.on("finish", resolve);
        req.pipe(file);
      });
    } catch (e) {
      file.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const head = Buffer.alloc(5);
    const fd = fs.openSync(pdf, "r");
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    if (size === 0 || head.toString() !== "%PDF-") {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(400, size === 0 ? "that file is empty" : "that file isn't a pdf");
    }
    let inspected: ReturnType<typeof inspectPdf>;
    try {
      inspected = inspectPdf(pdf, { taken: reserved() });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(400, "can't read this pdf — it may be damaged or password-protected");
    }
    if (!inspected.info.pages) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(400, "this pdf has no pages");
    }
    uploads.set(uid, { id: uid, pdf, ...inspected });
    send(res, 200, { upload: uid, info: inspected.info });
  }

  /** `{ book, units? }`: continue a stopped build, or add chapters to a book, without uploading again. */
  async function continueBook(body: Record<string, unknown>, res: ServerResponse) {
    const book = listBooks().find((b) => b.slug === body.book);
    if (!book) throw new HttpError(404, `no book "${String(body.book)}"`);
    let units = defaultUnits(book);
    if (body.units !== undefined) {
      if (!Array.isArray(body.units) || !body.units.every((u) => typeof u === "string") || !body.units.length) throw new HttpError(400, "choose at least one chapter");
      const known = new Set(book.units.map((u) => u.id));
      const bad = (body.units as string[]).filter((u) => !known.has(u));
      if (bad.length) throw new HttpError(400, `unknown chapters: ${bad.join(", ")}`);
      units = [...new Set(body.units as string[])];
    }
    const building = jobs.find((j) => j.status === "running" && j.kind === "build" && j.slug === book.slug);
    if (building) return send(res, 200, { job: building.id, slug: book.slug });
    await preflight(book.source.kind);
    const j = enqueue({ slug: book.slug, title: book.title, kind: "build", args: ["--book", book.slug, "--units", units.join(",")] });
    send(res, 200, { job: j.id, slug: book.slug });
  }

  async function createJob(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    if (typeof body.book === "string") return continueBook(body, res);
    const up = uploads.get(String(body.upload ?? ""));
    if (!up) throw new HttpError(404, "upload not found — add the pdf again");
    const book = up.draft.book;
    let units = defaultUnits(book);
    if (body.units !== undefined) {
      if (!Array.isArray(body.units) || !body.units.every((u) => typeof u === "string")) throw new HttpError(400, "units must be a list of chapter ids");
      const known = new Set(book.units.map((u) => u.id));
      const bad = (body.units as string[]).filter((u) => !known.has(u));
      if (bad.length) throw new HttpError(400, `unknown chapters: ${bad.join(", ")}`);
      if (!body.units.length) throw new HttpError(400, "choose at least one chapter");
      units = [...new Set(body.units as string[])];
    }
    const same = jobs.find((j) => j.status === "running" && j.upload === up.id);
    if (same) return send(res, 200, { job: same.id, slug: same.slug }); // already building: watch that one
    // Look again: another build may have created this book (or taken its name) since the upload.
    const now = inspectPdf(up.pdf, { taken: reserved() }).draft;
    await preflight(now.fresh ? now.book.source.kind : undefined);
    const slug = now.book.slug;
    const building = jobs.find((j) => j.status === "running" && j.kind === "build" && j.slug === slug);
    if (building) return send(res, 200, { job: building.id, slug });
    const args = now.fresh ? ["--pdf", up.pdf, "--slug", slug, "--units", units.join(",")] : ["--book", slug, "--units", units.join(",")];
    const j = enqueue({ slug, title: now.book.title, kind: "build", args, upload: up.id });
    send(res, 200, { job: j.id, slug });
  }

  async function createFix(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const [bookSlug, unit, demo, problem] = ["book", "unit", "demo", "problem"].map((k) => (typeof body[k] === "string" ? (body[k] as string).trim() : ""));
    if (!bookSlug || !unit || !demo) throw new HttpError(400, "book, unit and demo are required");
    if (!problem) throw new HttpError(400, "describe what's wrong with the demo");
    if (problem.length > 1000) throw new HttpError(400, "keep the description under 1000 characters");
    const book = listBooks().find((b) => b.slug === bookSlug);
    if (!book) throw new HttpError(404, `no book "${bookSlug}"`);
    if (!book.units.some((u) => u.id === unit)) throw new HttpError(404, `no chapter "${unit}" in ${book.short.toLowerCase()}`);
    const planFile = path.join(root, "src", "demos", book.slug, unit, "plan.json");
    const spec = fs.existsSync(planFile) ? (JSON.parse(fs.readFileSync(planFile, "utf8")) as DemoPlan).demos.find((d) => d.id === demo) : undefined;
    if (!spec) throw new HttpError(404, `no demo "${demo}" in that chapter`);
    await preflight(undefined);
    const j = enqueue({ slug: book.slug, title: spec.title, kind: "fix", args: ["--book", book.slug, "--unit", unit, "--demo", demo, "--note", problem] });
    send(res, 200, { job: j.id, slug: book.slug });
  }

  function events(j: Job, req: IncomingMessage, res: ServerResponse) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": yagami\n\n");
    for (const e of j.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (finished(j)) return res.end();
    j.listeners.add(res);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(beat);
      j.listeners.delete(res);
    });
  }

  function stopJob(j: Job, res: ServerResponse) {
    if (j.status === "running") {
      j.stopRequested = true;
      if (j.child) j.child.kill("SIGINT");
      else finish(j, "stopped", "stopped"); // still queued
    }
    send(res, 200, { ok: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method ?? "GET";
    // Only this site may change anything: other pages in the browser can send simple cross-site
    // requests to 127.0.0.1, and a rebinding DNS name could reach it with another Host.
    if (m !== "GET" && m !== "HEAD") {
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, "forbidden");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== host) throw new HttpError(403, "forbidden");
      if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "forbidden");
    }
    if (m === "GET" && p === "/models") return send(res, 200, await modelsView());
    if (m === "POST" && p === "/models/use") {
      const b = await readJson(req);
      const id = b.provider === null ? null : String(b.provider);
      if (id !== null && !PROVIDER_IDS.includes(id as ProviderName)) throw new HttpError(400, "unknown provider");
      if (process.env.YAGAMI_PROVIDER) throw new HttpError(409, `YAGAMI_PROVIDER=${process.env.YAGAMI_PROVIDER} is set where yagami runs — unset it to choose here`);
      const { saveProvider } = await import("./lib/settings");
      const { resetProvider } = await import("./lib/claude");
      saveProvider(id as ProviderName | null);
      resetProvider();
      return send(res, 200, await modelsView());
    }
    const km = /^\/models\/key\/(anthropic|openai)$/.exec(p);
    if (km && (m === "PUT" || m === "DELETE")) {
      const k = km[1] as "anthropic" | "openai";
      const { keySource, saveKey } = await import("./lib/settings");
      const { resetProvider } = await import("./lib/claude");
      if (keySource(k) === "env") throw new HttpError(409, `${k === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} is set where yagami runs — change it there`);
      if (m === "PUT") {
        const key = String((await readJson(req)).key ?? "").trim();
        if (!key) throw new HttpError(400, "paste a key");
        if (key.length > 400 || /\s/.test(key)) throw new HttpError(400, "that doesn't look like an api key");
        await checkKey(k, key);
        saveKey(k, key);
      } else saveKey(k, null);
      resetProvider();
      return send(res, 200, await modelsView());
    }
    if (m === "POST" && p === "/models/login") {
      const prov = String((await readJson(req)).provider ?? "");
      if (prov !== "claude-sub" && prov !== "openai-sub") throw new HttpError(400, "unknown login");
      // `claude auth login` may replace the stored login as it starts: never start one over a working login.
      if (prov === "claude-sub" && (await modelsView()).providers.find((x) => x.id === "claude-sub")?.ready) throw new HttpError(409, "claude is already logged in with a subscription");
      await startLogin(prov);
      return send(res, 200, await modelsView());
    }
    if (m === "POST" && p === "/models/login/code") {
      const code = String((await readJson(req)).code ?? "").trim();
      if (!login || login.provider !== "claude-sub" || login.status !== "waiting") throw new HttpError(409, "no claude login is waiting for a code");
      if (!code || code.length > 2000) throw new HttpError(400, "paste the code shown after signing in");
      const l = login;
      const seen = l.out.length;
      delete l.codeError;
      l.child.stdin?.write(code + "\n");
      // The CLI exchanges the code and exits, or says the code is wrong and waits for another:
      // wait for either so the answer says how it went.
      for (let i = 0; i < 150 && l.status === "waiting"; i++) {
        const said = l.out.slice(seen);
        if (/invalid|error|failed|expired/i.test(said)) {
          l.codeError = said.trim().split("\n").filter(Boolean)[0].toLowerCase().slice(0, 160);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return send(res, 200, await modelsView());
    }
    if (m === "DELETE" && p === "/models/login") {
      if (login?.status === "waiting") stopLogin(login);
      login = null;
      return send(res, 200, await modelsView());
    }
    if (m === "GET" && p === "/health") {
      const mm = await models();
      return send(res, 200, { credentials: mm.ready, provider: mm.provider, billing: mm.billing, ...(mm.how ? { how: mm.how } : {}), tools: await tools() });
    }
    if (m === "POST" && p === "/uploads") return upload(req, res);
    if (m === "POST" && p === "/jobs") return createJob(req, res);
    if (m === "POST" && p === "/jobs/fix") return createFix(req, res);
    if (m === "GET" && p === "/jobs") return send(res, 200, { jobs: [...jobs].sort((a, b) => b.startedAt - a.startedAt).map(view) });
    const dm = /^\/jobs\/([\w-]+)$/.exec(p);
    if (m === "DELETE" && dm) {
      // Forget a finished job (the library stops listing it); running jobs must be stopped first.
      const i = jobs.findIndex((x) => x.id === dm[1]);
      if (i < 0) throw new HttpError(404, "no such build");
      if (jobs[i].status === "running") throw new HttpError(409, "stop the build first");
      const [gone] = jobs.splice(i, 1);
      for (const ext of [".json", ".jsonl"]) fs.rmSync(path.join(jobsDir(), gone.id + ext), { force: true });
      return send(res, 200, { ok: true });
    }
    const jm = /^\/jobs\/([\w-]+)\/(events|stop)$/.exec(p);
    if (jm) {
      const j = jobs.find((x) => x.id === jm[1]);
      if (!j) throw new HttpError(404, "no such build");
      if (m === "GET" && jm[2] === "events") return events(j, req, res);
      if (m === "POST" && jm[2] === "stop") return stopJob(j, res);
    }
    throw new HttpError(404, "not found");
  }

  const stopAll = () => {
    if (login?.status === "waiting") stopLogin(login);
    for (const j of jobs) if (j.child && j.child.exitCode === null) j.child.kill("SIGINT");
  };

  return {
    name: "yagami-api",
    apply: "serve",
    configureServer(server) {
      root = server.config.root;
      loadSaved();
      server.middlewares.use("/api", (req, res) => {
        handle(req, res).catch((e: unknown) => {
          if (res.headersSent) return res.end();
          if (e instanceof HttpError) send(res, e.status, { error: e.message });
          else send(res, 500, { error: (e as Error)?.message ? String((e as Error).message).toLowerCase().slice(0, 300) : "something went wrong" });
        });
      });
      server.httpServer?.on("close", stopAll);
      process.once("exit", stopAll);
    },
  };
}
