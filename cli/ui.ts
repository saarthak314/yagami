// Terminal UI for a pipeline run: a live, redraw-in-place view driven by
// PipelineEvents. Zero dependencies — plain ANSI. Falls back to one plain line
// per event when stdout isn't a TTY (CI, pipes).

import type { DemoPhase, Emit, PipelineEvent, Stage } from "../scripts/lib/events";
import { plainEmit } from "../scripts/lib/events";

// ---------------------------------------------------------------------------
// Colour (monochrome + one accent; NO_COLOR respected)
// ---------------------------------------------------------------------------

const NO_COLOR = "NO_COLOR" in process.env || !process.stdout.isTTY;
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const sgr = (open: string, close = "\x1b[39m") => (s: string) => (NO_COLOR ? s : `\x1b[${open}m${s}${close}`);
const grayN = (n: number) => sgr(`38;5;${n}`);

export const color = {
  fg: grayN(255),
  muted: grayN(248),
  dim: grayN(243),
  faint: grayN(238),
  accent: sgr(TRUECOLOR ? "38;2;82;168;255" : "38;5;75"),
  red: sgr(TRUECOLOR ? "38;2;255;110;110" : "38;5;203"),
  bold: (s: string) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[22m`),
  /** Grey level 0..1 → truecolor or the 232–255 ramp. */
  level(t: number) {
    const v = Math.max(0, Math.min(1, t));
    if (NO_COLOR) return (s: string) => s;
    if (TRUECOLOR) {
      const c = Math.round(100 + v * 155);
      return sgr(`38;2;${c};${c};${c}`);
    }
    return grayN(Math.round(240 + v * 15));
  },
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visible = (s: string) => s.replace(ANSI, "");
const vlen = (s: string) => [...visible(s)].length;

/** Truncate to `width` visible columns, keeping escape codes intact. */
function fit(line: string, width: number): string {
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

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type StageStatus = "pending" | "running" | "done" | "skip" | "error";

interface StageState {
  status: StageStatus;
  t0?: number;
  t1?: number;
  detail?: string;
  done?: number;
  total?: number;
  label?: string;
}

interface DemoState {
  id: string;
  title: string;
  beats: number;
  phase: DemoPhase;
  round?: number;
  beatsPassed?: number;
  detail?: string;
  t0?: number;
  t1?: number;
}

interface UnitState {
  id: string;
  title: string;
  stages: Map<Stage, StageState>;
  demos: Map<string, DemoState>;
}

const UNIT_STAGES: Stage[] = ["render", "anchors", "assemble", "plan", "build", "verify"];
const STAGE_LABEL: Record<Stage, string> = {
  init: "reading pdf",
  render: "render",
  anchors: "anchors",
  assemble: "assemble",
  plan: "plan",
  build: "build",
  verify: "verify",
  serve: "serve",
};

const ACTIVE: DemoPhase[] = ["building", "typecheck", "fixing", "verifying", "revising"];

export interface UiOptions {
  /** Unit titles by id, for headings (optional). */
  unitTitles?: Record<string, string>;
}

export interface Ui {
  emit: Emit;
  /** Stop animating, draw the final frame, print the summary. */
  finish(summary?: { url?: string; lines?: string[] }): void;
  /** Stop immediately (Ctrl-C / crash), restoring the terminal. */
  abort(message?: string): void;
}

export function createUi(opts: UiOptions = {}): Ui {
  const tty = process.stdout.isTTY && !process.env.CI;
  return tty ? new LiveUi(opts) : new PlainUi();
}

// ---------------------------------------------------------------------------
// Plain fallback
// ---------------------------------------------------------------------------

class PlainUi implements Ui {
  private start = Date.now();
  private cost = 0;
  private demos = new Map<string, DemoPhase>();
  emit: Emit = (e) => {
    if (e.type === "cost") this.cost = e.total;
    if (e.type === "demo") this.demos.set(`${e.unit}/${e.id}`, e.phase);
    plainEmit(e);
  };
  finish(summary?: { url?: string; lines?: string[] }) {
    const pass = [...this.demos.values()].filter((p) => p === "pass").length;
    console.log(`done in ${duration(Date.now() - this.start)} · $${this.cost.toFixed(2)} · ${pass}/${this.demos.size} demos pass`);
    for (const l of summary?.lines ?? []) console.log(l);
    if (summary?.url) console.log(`→ ${summary.url}`);
  }
  abort(message?: string) {
    if (message) console.error(message);
  }
}

// ---------------------------------------------------------------------------
// Live renderer
// ---------------------------------------------------------------------------

class LiveUi implements Ui {
  private start = Date.now();
  private book?: Extract<PipelineEvent, { type: "book" }>;
  private init: StageState = { status: "pending" };
  private units = new Map<string, UnitState>();
  private cost = 0;
  private logs: { level: string; message: string }[] = [];
  private failures: string[] = [];
  private lastHeight = 0;
  private timer: NodeJS.Timeout;
  private frame = 0;
  private stopped = false;
  private restoreConsole: () => void;

  constructor(private opts: UiOptions) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.timer = setInterval(() => this.draw(), 80);
    process.stdout.on("resize", this.onResize);
    process.on("exit", this.onExit);
    // Stray console output would corrupt the frame: route it into the log tail.
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture =
      (level: string) =>
      (...args: unknown[]) =>
        this.pushLog(level, args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" "));
    console.log = capture("info");
    console.info = capture("info");
    console.warn = capture("warn");
    console.error = capture("error");
    this.restoreConsole = () => Object.assign(console, orig);
  }

  private onResize = () => {
    // Old lines re-wrap at the new width; repaint from a clean screen.
    process.stdout.write("\x1b[2J\x1b[H");
    this.lastHeight = 0;
    this.draw();
  };

  private onExit = () => {
    process.stdout.write("\x1b[?25h");
  };

  private pushLog(level: string, message: string) {
    for (const line of message.split("\n")) if (line.trim()) this.logs.push({ level, message: line.trim() });
    if (this.logs.length > 50) this.logs.splice(0, this.logs.length - 50);
  }

  private unit(id: string): UnitState {
    let u = this.units.get(id);
    if (!u) {
      u = { id, title: this.opts.unitTitles?.[id] ?? id, stages: new Map(), demos: new Map() };
      for (const s of UNIT_STAGES) u.stages.set(s, { status: "pending" });
      this.units.set(id, u);
    }
    return u;
  }

  emit: Emit = (e) => {
    const now = Date.now();
    switch (e.type) {
      case "book":
        this.book = e;
        for (const id of e.units) this.unit(id);
        break;
      case "stage": {
        const s = e.stage === "init" ? this.init : e.stage === "serve" ? null : this.unit(e.unit).stages.get(e.stage);
        if (!s) break;
        if (e.status === "start") Object.assign(s, { status: "running", t0: now, t1: undefined, detail: e.detail });
        else {
          s.status = e.status === "done" ? "done" : e.status === "skip" ? "skip" : "error";
          s.t1 = now;
          s.t0 ??= now;
          if (e.detail) s.detail = e.detail;
          if (e.status === "error") this.failures.push(`${e.unit} ${e.stage}${e.detail ? `: ${e.detail}` : ""}`);
        }
        break;
      }
      case "progress": {
        const s = e.stage === "init" ? this.init : this.unit(e.unit).stages.get(e.stage);
        if (s) Object.assign(s, { done: e.done, total: e.total, label: e.label });
        break;
      }
      case "plan": {
        const u = this.unit(e.unit);
        for (const d of e.demos) {
          const prev = u.demos.get(d.id);
          u.demos.set(d.id, { phase: "queued", ...prev, id: d.id, title: d.title, beats: d.beats });
        }
        break;
      }
      case "demo": {
        const u = this.unit(e.unit);
        // Until the plan event brings titles, show the id as words ("mod-vs-jump" → "Mod vs jump").
        const pretty = e.id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
        const d = u.demos.get(e.id) ?? { id: e.id, title: pretty, beats: e.beats ?? 0, phase: "queued" as DemoPhase };
        if (d.t0 === undefined && e.phase !== "queued") d.t0 = now;
        d.phase = e.phase;
        d.round = e.round;
        if (e.beats !== undefined) d.beats = e.beats;
        if (e.beatsPassed !== undefined) d.beatsPassed = e.beatsPassed;
        d.detail = e.detail;
        d.t1 = e.phase === "pass" || e.phase === "fail" ? now : undefined;
        u.demos.set(e.id, d);
        break;
      }
      case "cost":
        this.cost = e.total;
        break;
      case "log":
        this.pushLog(e.level, e.message);
        break;
      case "done":
        this.failures = [...new Set([...this.failures, ...e.failures])];
        break;
    }
  };

  // --- drawing -------------------------------------------------------------

  private spinner(offset = 0) {
    return color.accent(SPIN[(this.frame + offset) % SPIN.length]);
  }

  /** A soft highlight band sweeping across `text`. */
  private shimmer(text: string) {
    const chars = [...text];
    const span = chars.length + 10;
    const p = ((Date.now() - this.start) / 55) % span - 5;
    return chars.map((ch, i) => color.level(Math.max(0.35, 1 - Math.abs(i - p) / 5))(ch)).join("");
  }

  private bar(done: number, total: number, width = 18) {
    const f = total > 0 ? Math.round((done / total) * width) : 0;
    return color.accent("━".repeat(f)) + color.faint("━".repeat(width - f));
  }

  private glyph(status: StageStatus, offset = 0) {
    switch (status) {
      case "running":
        return this.spinner(offset);
      case "done":
        return color.fg("✓");
      case "skip":
        return color.dim("–");
      case "error":
        return color.red("✗");
      default:
        return color.faint("·");
    }
  }

  private elapsed(s: { t0?: number; t1?: number }) {
    if (s.t0 === undefined) return "";
    return color.dim(duration((s.t1 ?? Date.now()) - s.t0));
  }

  private stageLine(name: Stage, s: StageState, u: UnitState, width: number): string {
    let middle = "";
    if (s.status === "running") {
      if (name === "plan") middle = this.shimmer("planning demos");
      else if (s.total) middle = `${this.bar(s.done ?? 0, s.total)}  ${color.muted(`${s.done ?? 0}/${s.total}${s.label ? ` ${s.label}` : ""}`)}`;
      else if (name === "build" || name === "verify") {
        const demos = [...u.demos.values()];
        const n = demos.filter((d) => (name === "build" ? !["queued", "building", "typecheck", "fixing"].includes(d.phase) : d.phase === "pass" || d.phase === "fail")).length;
        middle = demos.length ? `${this.bar(n, demos.length)}  ${color.muted(`${n}/${demos.length}`)}` : color.muted(s.detail ?? "");
      } else middle = color.muted(s.detail ?? "");
    } else if (s.status !== "pending") {
      middle = color.dim(s.detail ?? (s.total ? `${s.total} ${s.label ?? ""}`.trim() : ""));
    }
    const left = `   ${this.glyph(s.status)} ${pad(s.status === "pending" ? color.faint(STAGE_LABEL[name]) : color.fg(STAGE_LABEL[name]), 10)} `;
    const right = this.elapsed(s);
    const room = width - vlen(left) - vlen(right) - 2;
    return left + pad(fit(middle, Math.max(4, room)), Math.max(4, room)) + "  " + right;
  }

  private demoPhase(d: DemoState): string {
    const r = d.round ? ` r${d.round}` : "";
    switch (d.phase) {
      case "queued":
        return color.faint("queued");
      case "building":
        return color.muted("writing code");
      case "typecheck":
        return color.muted("typechecking");
      case "fixing":
        return color.muted(`fixing types${r}`);
      case "verifying":
        return color.muted(`verifying${r}`);
      case "revising":
        return color.muted(`revising${r}`);
      case "pass":
        return color.fg("pass");
      case "fail":
        return color.red("fail");
    }
  }

  private demoLines(u: UnitState, width: number, maxRows: number): string[] {
    const demos = [...u.demos.values()];
    if (!demos.length) return [];
    const pass = demos.filter((d) => d.phase === "pass").length;
    const out = [`   ${color.muted(`${demos.length} demos`)}${pass ? color.dim(` · ${pass} pass`) : ""}`];
    const titleW = Math.min(36, Math.max(16, width - 44));
    // Keep active demos visible when the list is taller than the screen.
    const order = demos.length > maxRows ? [...demos].sort((a, b) => rank(a) - rank(b)) : demos;
    const shown = order.slice(0, Math.max(1, maxRows));
    shown.forEach((d, i) => {
      const g =
        d.phase === "pass" ? color.fg("✓") : d.phase === "fail" ? color.red("✗") : ACTIVE.includes(d.phase) ? this.spinner(i * 2) : color.faint("·");
      const title = d.phase === "queued" ? color.dim(d.title) : color.fg(d.title);
      const beats = d.beats ? (d.beatsPassed !== undefined ? `${d.beatsPassed}/${d.beats}` : `${d.beats}`) : "";
      const line = `   ${g} ${pad(fit(title, titleW), titleW)}  ${pad(this.demoPhase(d), 16)} ${padStart(color.dim(beats), 5)}  ${this.elapsed(d)}`;
      out.push(fit(line, width));
    });
    if (order.length > shown.length) out.push(`     ${color.dim(`+${order.length - shown.length} more`)}`);
    return out;
  }

  private unitSummary(u: UnitState, width: number): string {
    const stages = [...u.stages.values()];
    const err = stages.some((s) => s.status === "error");
    const finished = stages.every((s) => s.status === "done" || s.status === "skip");
    const started = stages.some((s) => s.status !== "pending");
    const demos = [...u.demos.values()];
    const pass = demos.filter((d) => d.phase === "pass").length;
    const g = err ? color.red("✗") : finished ? color.fg("✓") : started ? this.spinner() : color.faint("·");
    const t0 = stages.find((s) => s.t0)?.t0;
    const t1 = finished ? Math.max(...stages.map((s) => s.t1 ?? 0)) : undefined;
    const info = demos.length ? `${pass}/${demos.length} demos` : started ? "" : "queued";
    const line = `   ${g} ${pad(color.fg(fit(u.title, 34)), 34)}  ${pad(color.dim(info), 14)} ${t0 ? color.dim(duration((t1 ?? Date.now()) - t0)) : ""}`;
    return fit(line, width);
  }

  private render(final: boolean): string[] {
    const width = Math.max(40, Math.min(88, (process.stdout.columns ?? 80) - 1));
    const rows = Math.max(12, (process.stdout.rows ?? 30) - 1);
    const lines: string[] = [""];
    const b = this.book;
    lines.push(fit(`   ${color.bold(color.accent("yagami"))}  ${b ? color.fg(b.title) : color.muted("starting")}`, width));
    if (b) {
      const n = b.units.length;
      lines.push(fit(`   ${color.dim(`${b.domain} · ${b.kind === "text" ? "text pdf" : "scanned pdf"} · ${n} ${n === 1 ? "unit" : "units"}`)}`, width));
    }
    lines.push("");
    if (this.init.status !== "pending" && this.init.status !== "done") {
      lines.push(fit(`   ${this.glyph(this.init.status)} ${pad(color.fg("reading pdf"), 10)}  ${color.muted(this.init.detail ?? "")}`, width));
      lines.push("");
    }

    const units = [...this.units.values()];
    const isActive = (u: UnitState) => [...u.stages.values()].some((s) => s.status === "running");
    const active = units.find(isActive) ?? (final ? undefined : units.find((u) => [...u.stages.values()].some((s) => s.status === "pending")));
    const multi = units.length > 1;

    for (const u of units) {
      if (multi && u !== active) {
        lines.push(this.unitSummary(u, width));
        continue;
      }
      if (multi) lines.push(fit(`   ${color.muted(u.title)}`, width));
      for (const name of UNIT_STAGES) lines.push(this.stageLine(name, u.stages.get(name)!, u, width));
      const used = lines.length + (units.length - units.indexOf(u)) + 6;
      const demo = this.demoLines(u, width, rows - used);
      if (demo.length) lines.push("", ...demo);
      if (multi) lines.push("");
    }

    const warn = this.logs.filter((l) => l.level !== "info").slice(-2);
    if (warn.length && !final) {
      lines.push("");
      for (const l of warn) lines.push(fit(`   ${l.level === "error" ? color.red(l.message) : color.dim(l.message)}`, width));
    }
    lines.push("");
    lines.push(fit(`   ${color.dim(`${duration(Date.now() - this.start)} · $${this.cost.toFixed(2)}`)}`, width));
    return lines.slice(-rows);
  }

  private draw(final = false) {
    if (this.stopped) return;
    this.frame++;
    const lines = this.render(final);
    let out = "";
    if (this.lastHeight > 0) out += `\x1b[${this.lastHeight}A`;
    out += "\r\x1b[J" + lines.join("\n") + "\n";
    process.stdout.write(out);
    this.lastHeight = lines.length;
  }

  private stop() {
    clearInterval(this.timer);
    process.stdout.off("resize", this.onResize);
    this.restoreConsole();
  }

  finish(summary?: { url?: string; lines?: string[] }) {
    if (this.stopped) return;
    this.draw(true);
    this.stop();
    this.stopped = true;
    const demos = [...this.units.values()].flatMap((u) => [...u.demos.values()]);
    const pass = demos.filter((d) => d.phase === "pass").length;
    const out: string[] = [];
    const ok = this.failures.length === 0;
    out.push(
      `   ${ok ? color.fg("✓") : color.red("✗")} ${color.fg(`done in ${duration(Date.now() - this.start)}`)}${color.dim(` · $${this.cost.toFixed(2)} · ${pass}/${demos.length} demos pass`)}`,
    );
    for (const f of this.failures.slice(0, 6)) out.push(`     ${color.red(f)}`);
    for (const l of summary?.lines ?? []) out.push(`   ${l}`);
    if (summary?.url) out.push(`   ${color.accent("→")} ${color.fg(summary.url)}`);
    process.stdout.write(out.join("\n") + "\n\n\x1b[?25h");
  }

  abort(message?: string) {
    if (this.stopped) return;
    this.stop();
    this.stopped = true;
    process.stdout.write(`\n${message ? `   ${color.red(message)}\n` : ""}\x1b[?25h`);
  }
}

function rank(d: DemoState) {
  if (ACTIVE.includes(d.phase)) return 0;
  if (d.phase === "fail") return 1;
  if (d.phase === "queued") return 2;
  return 3;
}
