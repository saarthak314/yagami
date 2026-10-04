// Terminal UI for yagami: a calm live view of a pipeline run, driven by
// PipelineEvents, with a few keys (o open · d details · q quit). Zero
// dependencies — plain ANSI. Without a TTY it prints plain progress lines.

import type { DemoPhase, Emit, Stage } from "../scripts/lib/events";

// ---------------------------------------------------------------------------
// Colour: greys + one accent. Decided per stream (stdout here; stderr in `paint`).
// ---------------------------------------------------------------------------

const NO_COLOR_ENV = "NO_COLOR" in process.env;
const NO_COLOR = NO_COLOR_ENV || !process.stdout.isTTY;
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const sgr = (open: string, close = "\x1b[39m") => (s: string) => (NO_COLOR ? s : `\x1b[${open}m${s}${close}`);
const grayN = (n: number) => sgr(`38;5;${n}`);

export const color = {
  fg: grayN(253),
  muted: grayN(248),
  dim: grayN(244),
  faint: grayN(239),
  accent: sgr(TRUECOLOR ? "38;2;82;168;255" : "38;5;75"),
  red: sgr(TRUECOLOR ? "38;2;255;110;110" : "38;5;203"),
  bold: (s: string) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[22m`),
  /** Grey level 0..1. */
  level(t: number) {
    const v = Math.max(0, Math.min(1, t));
    if (NO_COLOR) return (s: string) => s;
    if (TRUECOLOR) {
      const c = Math.round(90 + v * 160);
      return sgr(`38;2;${c};${c};${c}`);
    }
    return grayN(Math.round(239 + v * 15));
  },
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visible = (s: string) => s.replace(ANSI, "");
const vlen = (s: string) => [...visible(s)].length;

/** Text for stderr: colour only when stderr itself is a terminal. */
export const paint = (s: string) => (NO_COLOR_ENV || !process.stderr.isTTY ? visible(s) : s);

/** Truncate to `width` visible columns (never wrap), keeping escape codes intact. */
export function fit(line: string, width: number): string {
  if (vlen(line) <= width) return line;
  let out = "";
  let n = 0;
  for (let i = 0; i < line.length; ) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (n >= width - 1) {
      out += "…";
      break;
    }
    out += ch;
    n++;
    i += ch.length;
  }
  return out + (NO_COLOR ? "" : "\x1b[0m");
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vlen(s)));
const padStart = (s: string, w: number) => " ".repeat(Math.max(0, w - vlen(s))) + s;
export const termWidth = () => Math.max(30, (process.stdout.columns ?? 80) - 1);

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** Whole seconds, for per-row timers. */
function secs(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000));
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Lowercase, except environment-variable names (ANTHROPIC_API_KEY). */
const lower = (s: string) => s.replace(/[A-Za-z][\w]*/g, (w) => (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(w) ? w : w.toLowerCase()));

/** Progress bar with distinct glyphs, so it reads without colour too. */
function bar(done: number, total: number, width: number) {
  const f = total > 0 ? Math.round((done / total) * width) : 0;
  return color.accent("━".repeat(f)) + color.faint("─".repeat(width - f));
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

/**
 * API and network errors arrive as SDK messages ("401 {"type":"error",…}",
 * "Connection error.", "<label>: refused (cyber)"); say what happened instead.
 */
export function humanize(message: string): string {
  const m = message.replace(/\s+/g, " ").trim();
  const refused = /refused \(([^)]+)\)/.exec(m);
  if (refused) return `the model declined this request (${refused[1]})`;
  if (/connection error|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(m)) return "can't reach the anthropic api — check your connection";
  const api = /^(\d{3})\b.*?"message"\s*:\s*"([^"]+)"/.exec(m);
  if (api) {
    const [, code, msg] = api;
    if (code === "401") return "the anthropic api key was rejected — check ANTHROPIC_API_KEY";
    if (code === "429") return "rate limited by the anthropic api — wait a minute and run again";
    if (code === "529" || code === "503") return "the anthropic api is overloaded — run again in a moment";
    return `anthropic api error ${code}: ${msg.toLowerCase()}`;
  }
  return m;
}

/** First sentence, lowercase, no trailing period. */
const shortReason = (s: string | undefined) =>
  lower(humanize(s ?? "").split(/(?<=[.!?])\s/)[0])
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]$/, "");

/** Why a demo failed: a review finding (fixable with `yagami fix`), or something to retry. */
function failKind(detail: string | undefined): "review" | "retry" {
  if (!detail) return "retry";
  const plain = detail.replace(/\s+/g, " ").trim();
  if (humanize(plain) !== plain) return "retry"; // refusal, api or network error
  if (/does not typecheck|error:|exception|timed out|ENOENT/i.test(plain)) return "retry";
  return "review";
}

// ---------------------------------------------------------------------------
// Keys (raw stdin) — shared by the run view, the picker and the serving line
// ---------------------------------------------------------------------------

/** Listen for single keypresses on a TTY. Returns a cleanup function (no-op without a TTY). */
export function onKeys(handler: (key: string) => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  const onData = (buf: Buffer) => handler(buf.toString());
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  const restore = () => {
    stdin.off("data", onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
  process.once("exit", restore);
  return () => {
    process.off("exit", restore);
    restore();
  };
}

const isQuit = (k: string) => k === "q" || k === "Q" || k === "\x03";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Status = "pending" | "running" | "done" | "skip" | "error";

interface StageState {
  status: Status;
  t0?: number;
  t1?: number;
  detail?: string;
  done?: number;
  total?: number;
}

interface DemoState {
  id: string;
  title: string;
  beats: number;
  phase: DemoPhase;
  round?: number;
  beatsPassed?: number;
  detail?: string;
  /** The last review finding, kept while the demo is reworked. */
  issue?: string;
  cached?: boolean;
  t0?: number;
  t1?: number;
}

interface UnitState {
  id: string;
  title: string;
  stages: Map<Stage, StageState>;
  demos: Map<string, DemoState>;
  /** Last event for this unit (timers stop when it goes idle). */
  tLast?: number;
}

const CONTENT: Stage[] = ["render", "anchors", "assemble"];
const UNIT_STAGES: Stage[] = [...CONTENT, "plan", "build", "verify"];
const CONTENT_WORD: Partial<Record<Stage, string>> = { render: "pages", anchors: "paragraphs", assemble: "site" };
const ACTIVE: DemoPhase[] = ["building", "typecheck", "fixing", "verifying", "revising"];
const isDone = (s: StageState) => s.status === "done" || s.status === "skip";

/** One word for what a demo is doing. */
function stateWord(d: DemoState): string {
  switch (d.phase) {
    case "queued":
      return "queued";
    case "building":
      return "writing";
    case "typecheck":
      return "typechecking";
    case "fixing":
      return "fixing types";
    case "verifying":
      return d.round ? "retesting" : "testing";
    case "revising":
      return "revising";
    case "pass":
      return "ready";
    case "fail":
      return "failed";
  }
}

const attempt = (d: DemoState) => (d.round ? d.round + 1 : 1);

export interface Failure {
  title: string;
  reason: string;
  kind: "review" | "retry";
}

/** Shell-safe double-quoted argument. */
const quote = (s: string) => `"${s.replace(/["\\$`]/g, (c) => `\\${c}`)}"`;

/** The exact command to fix a failed demo. Never truncated. */
export function fixCommand(f: Failure): string {
  return `yagami fix ${quote(lower(f.title))} ${quote(f.reason || "describe what's wrong")}`;
}

class Model {
  start = Date.now();
  title = "";
  meta = "";
  init: StageState = { status: "pending" };
  units = new Map<string, UnitState>();
  cost = 0;
  /** Persistent quiet notes (e.g. the site is unavailable). */
  notes: string[] = [];
  errors: string[] = [];
  stageFailures: string[] = [];
  pagesBuilt = false;

  /** `fix`: only the demo being fixed matters — ignore the unit's full demo list and never show "planning…". */
  constructor(
    private unitTitles: Record<string, string> = {},
    private fix = false,
  ) {}

  unit(id: string): UnitState {
    let u = this.units.get(id);
    if (!u) {
      u = { id, title: this.unitTitles[id] ?? id, stages: new Map(), demos: new Map() };
      for (const s of UNIT_STAGES) u.stages.set(s, { status: "pending" });
      this.units.set(id, u);
    }
    return u;
  }

  label(id: string) {
    return this.units.size > 1 ? `${lower(this.unit(id).title)} · ` : "";
  }

  apply(e: Parameters<Emit>[0]): void {
    const now = Date.now();
    switch (e.type) {
      case "book":
        if (!this.title) this.title = e.title;
        for (const id of e.units) this.unit(id);
        return;
      case "stage": {
        if (e.stage === "serve") return;
        const s = e.stage === "init" ? this.init : this.unit(e.unit).stages.get(e.stage)!;
        if (e.stage !== "init") this.unit(e.unit).tLast = now;
        if (e.status === "start") Object.assign(s, { status: "running", t0: now, t1: undefined, detail: e.detail });
        else {
          s.status = e.status === "done" ? "done" : e.status === "skip" ? "skip" : "error";
          s.t1 = now;
          s.t0 ??= now;
          if (e.detail) s.detail = e.status === "error" ? humanize(e.detail) : e.detail;
          if (e.status === "error") this.stageFailures.push(`${this.label(e.unit)}${CONTENT_WORD[e.stage] ?? e.stage}: ${s.detail ?? "failed"}`);
        }
        return;
      }
      case "progress": {
        const s = e.stage === "init" ? this.init : this.unit(e.unit).stages.get(e.stage);
        if (s) Object.assign(s, { done: e.done, total: e.total });
        if (e.stage !== "init") this.unit(e.unit).tLast = now;
        return;
      }
      case "plan": {
        if (this.fix) return;
        const u = this.unit(e.unit);
        for (const d of e.demos) {
          const prev = u.demos.get(d.id);
          u.demos.set(d.id, { phase: "queued", ...prev, id: d.id, title: d.title, beats: d.beats });
        }
        return;
      }
      case "demo": {
        const u = this.unit(e.unit);
        u.tLast = now;
        const d = u.demos.get(e.id) ?? { id: e.id, title: e.title ?? e.id.replace(/-/g, " "), beats: e.beats ?? 0, phase: "queued" as DemoPhase };
        if (e.title) d.title = e.title;
        if (d.t0 === undefined && e.phase !== "queued") d.t0 = now;
        d.phase = e.phase;
        d.round = e.round;
        if (e.beats !== undefined) d.beats = e.beats;
        if (e.beatsPassed !== undefined) d.beatsPassed = e.beatsPassed;
        d.detail = e.detail;
        d.cached = e.phase === "pass" && e.detail === "unchanged";
        if (e.phase === "fail" && e.detail && failKind(e.detail) === "review") d.issue = e.detail;
        if (e.phase === "pass") d.issue = undefined;
        d.t1 = e.phase === "pass" || e.phase === "fail" ? now : undefined;
        u.demos.set(e.id, d);
        return;
      }
      case "cost":
        this.cost = e.total;
        return;
      case "log":
        if (e.level === "info") return;
        if (/^site unavailable/i.test(e.message)) this.notes.push(lower(e.message));
        else this.errors.push(humanize(e.message));
        return;
      case "done":
        return;
    }
  }

  demos() {
    return [...this.units.values()].flatMap((u) => [...u.demos.values()]);
  }

  failures(): Failure[] {
    return this.demos()
      .filter((d) => d.phase === "fail")
      .map((d) => ({ title: d.title, reason: shortReason(d.detail), kind: failKind(d.detail) }));
  }

  pagesReady() {
    return this.pagesBuilt || [...this.units.values()].some((u) => isDone(u.stages.get("assemble")!));
  }

  allPlanned() {
    if (this.fix) return true;
    return [...this.units.values()].every((u) => isDone(u.stages.get("plan")!) || u.stages.get("plan")!.status === "error");
  }

  /** Nothing ran: every step reused. */
  nothingChanged() {
    const units = [...this.units.values()];
    return (
      units.length > 0 &&
      units.every((u) => CONTENT.every((s) => u.stages.get(s)!.status === "skip" || u.stages.get(s)!.status === "pending") && u.stages.get("plan")!.status !== "running" && u.stages.get("plan")!.status !== "done") &&
      this.demos().every((d) => d.cached)
    );
  }

  /** `5/6 ready`, or `ready 3 · planning…` while chapters are still being planned. */
  readyText() {
    const demos = this.demos();
    const ready = demos.filter((d) => d.phase === "pass").length;
    if (!demos.length) return "";
    if (!this.allPlanned()) return `${ready} ready · planning…`;
    return `${ready}/${demos.length} ready`;
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UiOptions {
  unitTitles?: Record<string, string>;
  /** `o` pressed. Receives whether the pages are readable yet; returns a short notice. */
  onOpen?: (pagesReady: boolean) => string;
  /** Whether `o` can work at all right now (the site is up). */
  canOpen?: () => boolean;
  /** `q` / ctrl-c pressed. */
  onQuit?: () => void;
  /** The book's pages already exist from an earlier run (so `o` works at once). */
  pagesReady?: boolean;
  /** A `yagami fix` run: one demo, summary says fixed / not fixed. */
  fix?: boolean;
}

export interface Ui {
  emit: Emit;
  /** Title and one dim meta line at the top. */
  header(title: string, meta: string): void;
  /** Final frame + summary. `url` is printed only when given (omit it when serving follows). */
  finish(url?: string): { failures: Failure[] };
  /** Stop now. Without a message: "stopped" + resume hint. With one: the error. */
  abort(message?: string): void;
}

export function createUi(opts: UiOptions = {}): Ui {
  return process.stdout.isTTY && !process.env.CI ? new LiveUi(opts) : new PlainUi(opts);
}

/** Summary lines shared by both views (already indented; never truncated). */
function summary(m: Model, opts: UiOptions, url: string | undefined): string[] {
  const width = termWidth();
  const demos = m.demos();
  const ready = demos.filter((d) => d.phase === "pass").length;
  const fails = m.failures();
  const ok = fails.length === 0 && m.stageFailures.length === 0;
  const stats = [duration(Date.now() - m.start), `$${m.cost.toFixed(2)}`];
  let head: string;
  if (opts.fix) head = ok ? "fixed" : "not fixed";
  else if (demos.length) head = `${ready}/${demos.length} demos ready`;
  else head = ok ? "done" : `${m.stageFailures[0]?.split(":")[0].split(" · ").pop() ?? "run"} failed`;
  const lines = [`  ${ok ? color.fg("✓") : color.red("✗")} ${color.fg(head)}${color.dim(` · ${stats.join(" · ")}`)}`];
  if (m.units.size > 1) for (const f of m.stageFailures) lines.push(`    ${color.red(f)}`);

  const review = fails.filter((f) => f.kind === "review");
  const retry = fails.filter((f) => f.kind === "retry");
  if (review.length) {
    const say = opts.fix ? "still wrong — describe what you see:" : review.length === 1 ? "to fix it, describe the problem:" : "to fix them, describe each problem:";
    lines.push("", `  ${color.dim(say)}`);
    for (const f of review) {
      const cmd = fixCommand(f);
      lines.push(vlen(cmd) + 2 <= width ? `  ${color.fg(cmd)}` : color.fg(cmd));
    }
  }
  if (retry.length) {
    lines.push("");
    for (const f of retry) lines.push(`  ${color.red(`${lower(f.title)}: ${f.reason || "failed"}`)}`);
    lines.push(`  ${color.dim("run the same command again to retry")}`);
  } else if (m.stageFailures.length) lines.push(`  ${color.dim("run the same command again to retry")}`);
  if (url) lines.push("", `  ${color.accent("→")} ${color.fg(url)}`);
  return lines;
}

function stoppedLines(m: Model): string[] {
  const parts = ["stopped", m.readyText(), duration(Date.now() - m.start), `$${m.cost.toFixed(2)}`].filter(Boolean);
  return [`  ${color.fg(parts[0])}${color.dim(` · ${parts.slice(1).join(" · ")}`)}`, `  ${color.dim("run the same command again to continue where it left off")}`];
}

// ---------------------------------------------------------------------------
// Plain (no TTY / CI): timestamped progress lines, no escape codes, no prompts
// ---------------------------------------------------------------------------

class PlainUi implements Ui {
  private m: Model;
  private printedHeader = false;
  private lastPct = new Map<string, number>();
  private lastPhase = new Map<string, DemoPhase>();
  private beat: NodeJS.Timeout;
  private lastLine = Date.now();

  constructor(private opts: UiOptions) {
    this.m = new Model(opts.unitTitles, !!opts.fix);
    this.m.pagesBuilt = !!opts.pagesReady;
    // Long stages stay audible: a "still …" line every 30 s of silence.
    this.beat = setInterval(() => {
      if (Date.now() - this.lastLine < 30_000) return;
      const what = this.current();
      if (what) this.line(`still ${what}`);
    }, 5_000);
    this.beat.unref();
  }

  private current(): string | null {
    if (this.m.init.status === "running") return this.m.init.detail ?? "reading the pdf";
    for (const u of this.m.units.values()) {
      for (const s of CONTENT) if (u.stages.get(s)!.status === "running") return `${this.m.label(u.id)}${CONTENT_WORD[s]}`;
      if (u.stages.get("plan")!.status === "running") return `${this.m.label(u.id)}planning demos`;
    }
    const active = this.m.demos().filter((d) => ACTIVE.includes(d.phase)).length;
    return active ? `working on ${active} ${active === 1 ? "demo" : "demos"}` : null;
  }

  private line(text: string) {
    this.lastLine = Date.now();
    console.log(`${duration(Date.now() - this.m.start).padStart(6)}  ${text}`);
  }

  header(title: string, meta: string) {
    if (!this.printedHeader) {
      this.printedHeader = true;
      this.m.title = title;
      this.m.meta = meta;
      console.log(`yagami · ${lower(title)}${meta ? ` · ${meta}` : ""}`);
      return;
    }
    const extra = meta.startsWith(this.m.meta) ? meta.slice(this.m.meta.length).replace(/^ · /, "") : meta;
    this.m.meta = meta;
    if (extra) this.line(`subject: ${extra}`);
  }

  emit: Emit = (e) => {
    this.m.apply(e);
    const cost = () => `$${this.m.cost.toFixed(2)}`;
    switch (e.type) {
      case "stage": {
        if (e.stage === "init" || e.stage === "serve" || e.stage === "build" || e.stage === "verify") return;
        const word = e.stage === "plan" ? "planning demos" : CONTENT_WORD[e.stage]!;
        const L = this.m.label(e.unit);
        if (e.status === "start") this.line(`${L}${word}…`);
        else if (e.status === "error") this.line(`${L}${word}: failed — ${humanize(e.detail ?? "")}`);
        else if (e.status === "done") this.line(`${L}${word}: done${e.stage === "plan" && e.detail ? ` · ${lower(e.detail)}` : ""}`);
        else if (e.stage === "plan") this.line(`${L}${this.m.nothingChanged() || CONTENT.every((s) => this.m.unit(e.unit).stages.get(s)!.status === "skip") ? "nothing changed" : "plan: unchanged"}`);
        return;
      }
      case "progress": {
        if (!e.total || e.stage === "build" || e.stage === "verify") return;
        const key = `${e.unit}/${e.stage}`;
        const pct = Math.floor((e.done / e.total) * 4); // a line every quarter
        if (pct === this.lastPct.get(key) || e.done === e.total) return;
        this.lastPct.set(key, pct);
        if (pct > 0) this.line(`${this.m.label(e.unit)}${CONTENT_WORD[e.stage] ?? e.stage} ${e.done}/${e.total}`);
        return;
      }
      case "demo": {
        const key = `${e.unit}/${e.id}`;
        if (this.lastPhase.get(key) === e.phase && e.phase !== "fail") return;
        this.lastPhase.set(key, e.phase);
        if (e.phase === "queued") return;
        const d = this.m.unit(e.unit).demos.get(e.id)!;
        if (d.cached) return this.line(`${this.m.label(e.unit)}${lower(d.title)}: ready`);
        const word = stateWord(d);
        const extra = e.phase === "fail" ? ` — ${shortReason(e.detail)}` : attempt(d) > 1 ? ` (attempt ${attempt(d)})` : "";
        this.line(`${cost().padStart(6)}  ${this.m.label(e.unit)}${lower(d.title)}: ${word}${extra}`);
        return;
      }
      case "log":
        if (e.level !== "info") this.line(humanize(e.message));
        return;
    }
  };

  finish(url?: string) {
    clearInterval(this.beat);
    for (const l of summary(this.m, this.opts, url)) console.log(l.replace(/^  /, ""));
    return { failures: this.m.failures() };
  }

  abort(message?: string) {
    clearInterval(this.beat);
    if (message) console.log(`✗ ${message}`);
    else for (const l of stoppedLines(this.m)) console.log(l.replace(/^  /, ""));
  }
}

// ---------------------------------------------------------------------------
// Live view
// ---------------------------------------------------------------------------

class LiveUi implements Ui {
  private m: Model;
  private prev: string[] = [];
  private timer: NodeJS.Timeout;
  private frame = 0;
  private stopped = false;
  private finalFrame = false;
  private details = false;
  private notice?: { text: string; until: number };
  private restoreConsole: () => void;
  private stopKeys: () => void;

  constructor(private opts: UiOptions) {
    this.m = new Model(opts.unitTitles, !!opts.fix);
    this.m.pagesBuilt = !!opts.pagesReady;
    process.stdout.write("\x1b[?25l");
    this.timer = setInterval(() => this.draw(), 80);
    process.stdout.on("resize", this.onResize);
    process.on("exit", this.onExit);
    // Stray console output would tear the frame: keep it as notes instead.
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture =
      (level: "info" | "warn" | "error") =>
      (...args: unknown[]) =>
        this.m.apply({ type: "log", level, message: args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ") });
    console.log = capture("info");
    console.info = capture("info");
    console.warn = capture("warn");
    console.error = capture("error");
    this.restoreConsole = () => Object.assign(console, orig);
    this.stopKeys = onKeys((k) => {
      if (isQuit(k)) return opts.onQuit?.();
      if (k === "d" || k === "D") this.details = !this.details;
      else if ((k === "o" || k === "O") && this.canOpen()) this.notice = { text: opts.onOpen!(this.m.pagesReady()), until: Date.now() + 2500 };
      else return;
      this.draw();
    });
  }

  private canOpen() {
    return !!this.opts.onOpen && this.m.notes.length === 0 && (this.opts.canOpen?.() ?? true);
  }

  private onResize = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    this.prev = [];
    this.draw();
  };

  private onExit = () => {
    process.stdout.write("\x1b[?25h");
  };

  header(title: string, meta: string) {
    this.m.title = title;
    this.m.meta = meta;
    this.draw();
  }

  emit: Emit = (e) => {
    this.m.apply(e);
  };

  // --- pieces --------------------------------------------------------------

  private spin() {
    return this.finalFrame ? color.faint("·") : color.accent(SPIN[this.frame % SPIN.length]);
  }

  /** A soft light band sweeping across `text`. */
  private shimmer(text: string) {
    if (NO_COLOR || this.finalFrame) return color.fg(text);
    const chars = [...text];
    const span = chars.length + 12;
    const p = (((Date.now() - this.m.start) / 60) % span) - 6;
    return chars.map((ch, i) => color.level(Math.max(0.45, 1 - Math.abs(i - p) / 6))(ch)).join("");
  }

  private row(left: string, right: string, width: number) {
    const room = width - vlen(right) - 1;
    return pad(fit(left, room), room) + " " + right;
  }

  private span(t0?: number, t1?: number) {
    if (t0 === undefined) return "";
    const ms = (t1 ?? Date.now()) - t0;
    return t1 !== undefined && ms < 1000 ? "" : color.dim(duration(ms));
  }

  /** The unit's preparation (pages → plan) as one or two lines; folded once demos start. */
  private prepLines(u: UnitState, width: number, indent = "  "): string[] {
    const st = CONTENT.map((s) => u.stages.get(s)!);
    const plan = u.stages.get("plan")!;
    const contentDone = st.every(isDone);
    const err = st.findIndex((s) => s.status === "error");
    const run = st.findIndex((s) => s.status === "running");
    const t0 = st.find((s) => s.t0)?.t0;
    const out: string[] = [];

    if (err >= 0) return [this.row(`${indent}${color.red("✗")} ${color.fg(CONTENT_WORD[CONTENT[err]]!)}  ${color.red(st[err].detail ?? "failed")}`, "", width)];
    if (run >= 0) {
      const s = st[run];
      const prog = s.total ? `  ${bar(s.done ?? 0, s.total, 14)} ${color.dim(`${s.done ?? 0}/${s.total}`)}` : "";
      return [this.row(`${indent}${this.spin()} ${color.fg(CONTENT_WORD[CONTENT[run]]!)}${prog}`, this.span(t0), width)];
    }
    if (!contentDone) {
      const untouched = st.every((s) => s.status === "pending");
      return untouched && (this.m.init.status === "running" || plan.status !== "pending" || u.demos.size > 0) ? [] : [`${indent}${color.faint("· pages")}`];
    }

    const contentSkipped = st.every((s) => s.status === "skip");
    const contentEnd = Math.max(...st.map((s) => s.t1 ?? 0));
    if (plan.status === "running") {
      if (!contentSkipped) out.push(this.row(`${indent}${color.fg("✓")} ${color.dim("pages ready")}`, this.span(t0, contentEnd), width));
      out.push(this.row(`${indent}${this.spin()} ${this.shimmer("planning demos")}`, this.span(plan.t0), width));
      return out;
    }
    if (plan.status === "error") {
      out.push(this.row(`${indent}${color.red("✗")} ${color.fg("plan")}  ${color.red(plan.detail ?? "failed")}`, "", width));
      return out;
    }
    if (plan.status === "pending") return [this.row(`${indent}${color.fg("✓")} ${color.dim("pages ready")}`, this.span(t0, contentEnd), width)];
    // Content and plan finished: fold into one line (or none for a fix run that reused both).
    if (contentSkipped && plan.status === "skip") return this.opts.fix ? [] : [`${indent}${color.fg("✓")} ${color.dim("nothing changed")}`];
    const end = Math.max(contentEnd, plan.t1 ?? 0);
    return [this.row(`${indent}${color.fg("✓")} ${color.dim(plan.status === "skip" ? "pages ready" : "pages and plan ready")}`, this.span(t0 ?? plan.t0, end), width)];
  }

  private demoRows(u: UnitState, width: number, maxRows: number, indent = "  "): string[] {
    const demos = [...u.demos.values()];
    if (!demos.length || maxRows <= 0) return [];
    const narrow = width < 72;
    const stateW = narrow ? 13 : 24;
    const timeW = 7;
    const longest = Math.max(...demos.map((d) => [...d.title].length));
    const titleW = Math.max(10, Math.min(longest, width - indent.length - 2 - 2 - stateW - timeW - 1));
    const showDetail = (d: DemoState) => !this.finalFrame && visible(this.detail(d)).trim().length > 0;
    const order = demos.length > maxRows ? [...demos].sort((a, b) => rank(a) - rank(b)) : demos;
    const out: string[] = [];
    let shown = 0;
    for (const d of order) {
      const need = 1 + (showDetail(d) ? 1 : 0);
      const remaining = order.length - shown;
      if (out.length + need > maxRows - (remaining > 1 ? 1 : 0)) break;
      const active = ACTIVE.includes(d.phase);
      const g = d.phase === "pass" ? color.fg("✓") : d.phase === "fail" ? color.red("✗") : active ? color.accent("•") : color.faint("·");
      const title = d.phase === "queued" ? color.dim(lower(d.title)) : color.fg(lower(d.title));
      let state = stateWord(d);
      if (this.finalFrame && active) state = "stopped";
      if (!narrow && active && attempt(d) > 1) state += ` · attempt ${attempt(d)}`;
      const stateC = d.phase === "pass" ? color.muted(state) : d.phase === "fail" ? color.red(state) : d.phase === "queued" || this.finalFrame ? color.faint(state) : color.accent(state);
      const ms = d.t0 === undefined ? 0 : (d.t1 ?? Date.now()) - d.t0;
      const time = d.cached || ms < 1000 ? "" : color.dim(secs(ms));
      out.push(this.row(`${indent}${g} ${pad(fit(title, titleW), titleW)}  ${pad(stateC, stateW)}`, padStart(time, timeW), width));
      if (showDetail(d)) out.push(fit(`${indent}    ${this.detail(d)}`, width));
      shown++;
    }
    if (order.length > shown) out.push(`${indent}  ${color.dim(`+${order.length - shown} more`)}`);
    return out;
  }

  /** The second line under a demo: why it failed, what's being fixed, or (with d) what it's doing. */
  private detail(d: DemoState): string {
    const checks = d.beats ? `${d.beatsPassed ?? 0}/${d.beats} checks` : "";
    if (d.phase === "fail") return color.red([checks, shortReason(d.detail)].filter(Boolean).join(" · "));
    const bits: string[] = [];
    if (d.issue && ACTIVE.includes(d.phase)) bits.push(`fixing: ${shortReason(d.issue)}`);
    if (this.details) {
      if (d.phase === "fixing" && d.detail) bits.push(lower(d.detail));
      if (d.phase === "verifying" && d.beats) bits.push(`${d.beats} checks in a headless browser`);
      if (d.phase === "pass" && d.beats) bits.push(`${d.beats}/${d.beats} checks`);
      if (d.phase === "building" && attempt(d) > 1) bits.push("rewriting after review");
      if (d.cached) bits.push("unchanged since last run");
    }
    return color.dim(bits.join(" · "));
  }

  private unitRow(u: UnitState, width: number): string {
    const st = [...u.stages.values()];
    const demos = [...u.demos.values()];
    const ready = demos.filter((d) => d.phase === "pass").length;
    const failed = demos.filter((d) => d.phase === "fail").length;
    const left = demos.length - ready - failed;
    const plan = u.stages.get("plan")!;
    const err = st.some((s) => s.status === "error");
    const content = CONTENT.map((s) => u.stages.get(s)!);
    const running = st.some((s) => s.status === "running") || demos.some((d) => ACTIVE.includes(d.phase));
    const finished = isDone(plan) && demos.length > 0 && left === 0;
    let g: string;
    let what: string;
    if (err) [g, what] = [color.red("✗"), color.red("failed")];
    else if (finished) [g, what] = [failed ? color.red("✗") : color.fg("✓"), color.dim([`${ready} ready`, failed ? `${failed} failed` : ""].filter(Boolean).join(" · "))];
    else if (plan.status === "running") [g, what] = [color.accent("•"), this.shimmer("planning demos")];
    else if (demos.length && running) [g, what] = [color.accent("•"), color.accent(`${ready} ready · ${left} left`)];
    else if (content.some((s) => s.status === "running")) {
      const s = content.find((c) => c.status === "running")!;
      const word = CONTENT_WORD[CONTENT[content.indexOf(s)]]!;
      [g, what] = [color.accent("•"), `${color.accent(word)}${s.total ? `  ${bar(s.done ?? 0, s.total, 10)} ${color.dim(`${s.done ?? 0}/${s.total}`)}` : ""}`];
    }
    else if (content.every(isDone)) [g, what] = [color.faint("·"), color.dim("pages ready")];
    else [g, what] = [color.faint("·"), color.faint("queued")];
    const t0 = st.find((s) => s.t0)?.t0 ?? demos.find((d) => d.t0)?.t0;
    const time = t0 === undefined ? "" : color.dim(secs((running ? Date.now() : (u.tLast ?? Date.now())) - t0));
    const titleW = Math.max(12, Math.min(40, width - 34));
    const title = err || finished || running ? color.fg(lower(u.title)) : color.dim(lower(u.title));
    return this.row(`  ${g} ${pad(fit(title, titleW), titleW)}  ${what}`, padStart(time, 7), width);
  }

  private footer(width: number): string[] {
    const busy =
      this.m.init.status === "running" ||
      [...this.m.units.values()].some((u) => [...u.stages.values()].some((s) => s.status === "running") || [...u.demos.values()].some((d) => ACTIVE.includes(d.phase)));
    const statusLine = [duration(Date.now() - this.m.start), `$${this.m.cost.toFixed(2)}`, this.m.readyText()].filter(Boolean).join(" · ");
    // One spinner on screen: here, unless a preparation line already shows one.
    const single = this.m.units.size <= 1;
    const prepSpinning = this.m.init.status === "running" || (single && [...this.m.units.values()].some((u) => [...CONTENT, "plan" as Stage].some((s) => u.stages.get(s)!.status === "running")));
    const g = busy && !prepSpinning ? `${this.spin()} ` : "";
    const stats = `  ${g}${color.dim(statusLine)}`;
    const note = this.notice && this.notice.until > Date.now() ? color.muted(this.notice.text) : "";
    const keys = color.faint([this.canOpen() && this.m.pagesReady() ? "o open" : "", this.details ? "d hide details" : "d details", "q quit"].filter(Boolean).join(" · "));
    const right = note || keys;
    if (vlen(stats) + vlen(right) + 4 <= width) return [this.row(stats, right, width)];
    return [stats, fit(`  ${right}`, width)];
  }

  private render(): string[] {
    const width = termWidth();
    const rows = Math.max(8, (process.stdout.rows ?? 30) - 1);
    const head: string[] = [""];
    head.push(fit(`  ${color.bold(color.accent("yagami"))}  ${this.m.title ? color.fg(lower(this.m.title)) : color.dim("starting")}`, width));
    if (this.m.meta) head.push(fit(`  ${color.dim(this.m.meta)}`, width));
    head.push("");

    const body: string[] = [];
    const init = this.m.init;
    if (init.status === "pending" && this.m.units.size === 0) body.push(`  ${this.spin()} ${color.dim("reading pdf")}`);
    if (init.status === "running") body.push(this.row(`  ${this.spin()} ${this.shimmer(init.detail ?? "reading pdf")}`, this.span(init.t0), width));
    else if (init.status === "error") body.push(fit(`  ${color.red("✗")} ${color.red(init.detail ?? "failed")}`, width));

    const tail: string[] = [];
    for (const n of this.m.notes.slice(-1)) tail.push("", fit(`  ${color.dim(n)}`, width));
    for (const e of this.m.errors.slice(-1)) if (!this.finalFrame) tail.push("", fit(`  ${color.red(e)}`, width));
    const foot = this.finalFrame ? [] : ["", ...this.footer(width)];

    const units = [...this.m.units.values()];
    const budget = () => rows - head.length - body.length - tail.length - foot.length;
    if (units.length === 1) {
      const u = units[0];
      const prep = this.prepLines(u, width);
      body.push(...prep);
      if (u.demos.size) {
        if (prep.length || body.length) body.push(""); // no double gap when nothing sits above the demos (fix runs)
        body.push(...this.demoRows(u, width, budget()));
      }
    } else if (units.length > 1) {
      const active = units.find((u) => [...u.stages.values()].some((s) => s.status === "running") || [...u.demos.values()].some((d) => ACTIVE.includes(d.phase)));
      for (const u of units) {
        body.push(this.unitRow(u, width));
        if (u === active && !this.finalFrame) {
          const rest = units.length - units.indexOf(u) - 1;
          body.push(...this.demoRows(u, width, budget() - rest, "    "));
        }
      }
    }
    // Header and footer always stay; an over-long middle is cut with "+n more".
    const room = rows - head.length - tail.length - foot.length;
    if (body.length > room) {
      const cut = body.length - room + 1;
      body.splice(Math.max(0, room - 1), cut, `    ${color.dim(`+${cut} more`)}`);
    }
    return [...head, ...body, ...tail, ...foot].slice(0, rows);
  }

  private draw(final = false) {
    if (this.stopped) return;
    this.frame++;
    this.finalFrame = final;
    const lines = this.render();
    const prev = this.prev;
    if (lines.length === prev.length && lines.every((l, i) => l === prev[i])) return;
    // Repaint only changed lines, as one synchronized update.
    let out = "\x1b[?2026h";
    if (prev.length) out += `\x1b[${prev.length}A\r`;
    lines.forEach((l, i) => {
      if (i < prev.length && prev[i] === l) out += "\x1b[1B";
      else out += `\r${l}\x1b[K${i < prev.length ? "\x1b[1B" : "\n"}`;
    });
    // Rows that moved past the old frame were written with \n; clear anything left below.
    out += "\r\x1b[J\x1b[?2026l";
    process.stdout.write(out);
    this.prev = lines;
  }

  private stop() {
    clearInterval(this.timer);
    process.stdout.off("resize", this.onResize);
    this.stopKeys();
    this.restoreConsole();
    this.stopped = true;
  }

  finish(url?: string) {
    if (this.stopped) return { failures: this.m.failures() };
    this.draw(true);
    this.stop();
    process.stdout.write(["", ...summary(this.m, this.opts, url), "", ""].join("\n") + "\x1b[?25h");
    return { failures: this.m.failures() };
  }

  abort(message?: string) {
    if (this.stopped) return;
    this.draw(true);
    this.stop();
    const lines = message ? [`  ${color.red("✗")} ${color.red(message)}`] : stoppedLines(this.m);
    process.stdout.write(["", ...lines, "", ""].join("\n") + "\x1b[?25h");
  }
}

function rank(d: DemoState) {
  if (ACTIVE.includes(d.phase)) return 0;
  if (d.phase === "fail") return 1;
  if (d.phase === "queued") return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Serving: the URL once, then one status line with keys
// ---------------------------------------------------------------------------

/** Serve until q / ctrl-c (TTY) or SIGINT / SIGTERM (no TTY). Resolves when the user quits. */
export function servingLine(url: string, open: () => void): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(`→ serving ${url} · ctrl-c to stop`);
    return new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  }
  process.stdout.write(`  ${color.accent("→")} ${color.fg(url)}\n`);
  const write = (note?: string) =>
    process.stdout.write(`\r${fit(`  ${color.accent("●")} ${color.fg("serving")}  ${note ? color.muted(note) : color.faint("o open · q quit")}`, termWidth())}\x1b[K`);
  process.stdout.write("\x1b[?25l");
  write();
  return new Promise((resolve) => {
    let t: NodeJS.Timeout | undefined;
    const onResize = () => write();
    process.stdout.on("resize", onResize);
    const stop = onKeys((k) => {
      if (isQuit(k)) {
        clearTimeout(t);
        stop();
        process.stdout.off("resize", onResize);
        process.stdout.write(`\r  ${color.dim("stopped serving")}\x1b[K\n\n\x1b[?25h`);
        resolve();
      } else if (k === "o" || k === "O") {
        open();
        write("opened in your browser");
        clearTimeout(t);
        t = setTimeout(() => write(), 2000);
      }
    });
  });
}
