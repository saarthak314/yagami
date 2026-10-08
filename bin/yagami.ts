// yagami — turn a PDF (paper or textbook, mostly maths and CS) into a reader
// with live, generated demos beside the original pages.
//
//   yagami <file.pdf>               make the site for a PDF and open it
//   yagami                          open the site
//   yagami fix <demo> "<problem>"   fix a demo by describing what's wrong

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_CWD = process.env.YAGAMI_CWD ?? process.cwd();
process.chdir(ROOT);

const { color, createUi, fit, humanize, paint, servingLine, termWidth } = await import("../cli/ui");
const { BASE, bookUrl, openUrl, startSite } = await import("../cli/server");
type Site = import("../cli/server").Site;
const { pick } = await import("../cli/picker");
const { listBooks, draftBook, startBook, builtUnits, defaultUnits } = await import("../scripts/create-book");
type BookConfig = import("../src/types").BookConfig;
type DemoPlan = import("../src/types").DemoPlan;

const VERSION = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;

const BRAND = `  ${color.bold(color.accent("yagami"))}  ${color.dim("pdf in, explainer out")}`;

const USAGE = [
  `  ${color.fg("yagami <file.pdf>")}       ${color.dim("make the site for a pdf, open it")}`,
  `  ${color.fg("yagami")}                  ${color.dim("open the site")}`,
  `  ${color.fg('yagami fix <demo> "<problem>"')}`,
  `                          ${color.dim("fix a demo: say what's wrong")}`,
  "",
  `  ${color.dim("e.g.")} ${color.muted("yagami ~/papers/attention.pdf")}`,
  `       ${color.muted('yagami fix "label smoothing" "legend too big"')}`,
  "",
  `  ${color.dim("while it runs: o open · d details · q quit")}`,
  `  ${color.dim("models: an anthropic or openai key, or a claude or chatgpt subscription")}`,
  `  ${color.dim("(YAGAMI_PROVIDER = anthropic · claude-sub · openai · openai-sub)")}`,
].join("\n");

const HELP = `\n${BRAND}\n\n${USAGE}\n`;

/** Print one error line and exit. `spaced` adds a blank line before it (skip it right after a screen that already ends with one). */
function fail(msg: string, spaced = true): never {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
  console.error(paint(`${spaced ? "\n" : ""}  ${color.red("✗")} ${msg}\n`));
  process.exit(1);
}

const has = (bin: string) => spawnSync("which", [bin]).status === 0;

// ---------------------------------------------------------------------------
// Preflight: everything that would fail later, checked before slow or paid work
// ---------------------------------------------------------------------------

async function preflightModels() {
  const { providerStatus } = await import("../scripts/lib/claude");
  let st: ReturnType<typeof providerStatus>;
  try {
    st = providerStatus();
  } catch (e) {
    fail((e as Error).message);
  }
  if (!st.ready) fail(`no model access (${st.provider}) — ${st.how}`);
  const { chromium } = await import("playwright");
  if (!fs.existsSync(chromium.executablePath())) fail("headless chromium is missing — run: npx playwright install chromium");
}

async function preflightPdf(file: string): Promise<string> {
  const pdf = path.resolve(USER_CWD, file);
  if (!fs.existsSync(pdf)) fail(`no such file: ${file}`);
  if (!fs.statSync(pdf).isFile()) fail(`not a file: ${file}`);
  const head = Buffer.alloc(5);
  try {
    const fd = fs.openSync(pdf, "r");
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
  } catch {
    fail(`can't read ${file}`);
  }
  if (head.toString() !== "%PDF-") fail(`not a pdf: ${file}`);
  const missing = ["pdfinfo", "pdftotext", "pdftoppm"].filter((b) => !has(b));
  if (missing.length) fail(`${missing.join(", ")} not found — install poppler (macOS: brew install poppler)`);
  await preflightModels();
  return pdf;
}

/** An instant first line while the pdf is read (hashing a big pdf blocks for a moment). */
function reading(name: string) {
  if (!process.stdout.isTTY) return () => {};
  process.stdout.write(`\n${fit(`  ${color.accent("⠋")} ${color.dim(`reading ${name}`)}`, termWidth())}\x1b[K`);
  // Erase it again; the live view starts on the same row.
  return () => process.stdout.write("\r\x1b[K\x1b[1A");
}

// ---------------------------------------------------------------------------
// One run: live view while the pipeline works, then serve the result
// ---------------------------------------------------------------------------

interface RunSpec {
  book: BookConfig;
  title: string;
  meta: string;
  units: string[];
  opts: Parameters<typeof import("../scripts/run").runBook>[1];
  fix?: boolean;
  /** Work before the pipeline (e.g. detecting the subject); may update the header. */
  before?: (ui: { header: (meta: string) => void; emit: import("../scripts/lib/events").Emit }) => Promise<void>;
}

async function run(spec: RunSpec) {
  const url = bookUrl(spec.book.slug, spec.units[0]);
  let site: Site | undefined;
  const quit = () => {
    ui.abort();
    site?.stop();
    process.exit(130);
  };
  const ui = createUi({
    unitTitles: Object.fromEntries(spec.book.units.map((u) => [u.id, u.title])),
    canOpen: () => !!site?.up,
    onOpen: (pagesReady) => {
      if (!pagesReady) return "pages aren't ready yet";
      openUrl(url);
      return "opened in your browser";
    },
    onQuit: quit,
    fix: spec.fix,
    pagesReady: fs.existsSync(path.join("public/books", spec.book.slug, "units", `${spec.units[0]}.json`)),
  });
  process.once("SIGINT", quit);
  ui.header(spec.title, spec.meta);
  const siteReady = startSite().then((s) => {
    site = s;
    if (!s.up) ui.emit({ type: "log", level: "warn", message: `site unavailable: ${s.error ?? "it did not start"}` });
    return s;
  });

  try {
    if (spec.before) await spec.before({ header: (meta) => ui.header(spec.title, meta), emit: ui.emit });
    const { runBook } = await import("../scripts/run");
    await runBook(spec.book.slug, spec.opts, ui.emit);
  } catch (e) {
    ui.abort(humanize((e as Error).message));
    site?.stop();
    process.exit(1);
  }
  await siteReady;
  // The URL is printed once: by the serving line, or here when there's nothing to serve.
  ui.finish();
  process.removeListener("SIGINT", quit);
  await serveUntilQuit(url, site!, true);
}

async function serveUntilQuit(url: string, site: Site, afterRun = false) {
  // After a run the screen already shows why (a quiet note), so don't repeat the reason.
  if (!site.up) fail(`can't serve the site${afterRun ? "" : `: ${site.error ?? "it did not start"}`} — free port 5190, then run: yagami`, false);
  openUrl(url);
  if (!site.owned) {
    console.log(`  ${color.accent("→")} ${color.fg(`already open at ${url}`)}\n    ${color.dim("another yagami is serving it")}\n`);
    process.exit(0);
  }
  await servingLine(url, () => openUrl(url));
  site.stop();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function make(file: string) {
  const pdf = await preflightPdf(file);
  const done = reading(path.basename(pdf));

  // The book made from this PDF before, or a proposed new one (fast; nothing written yet).
  const { book, pages, fresh } = draftBook(pdf);
  if (fresh && book.source.kind === "scanned" && !has("tesseract")) {
    done();
    fail("tesseract not found — it reads scanned pdfs (macOS: brew install tesseract)");
  }
  done();

  // Long textbooks: choose chapters (others can be added later by running again).
  let selected = book.units.map((u) => u.id);
  if (book.units.length > 6) {
    const built = builtUnits(book);
    const preset = new Set(defaultUnits(book));
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log("");
      const picked = await pick(
        `${book.title.toLowerCase()} · which chapters?`,
        book.units.map((u) => ({ id: u.id, label: u.title, pages: u.pages, built: built.has(u.id), selected: preset.has(u.id) })),
      );
      if (picked === null) {
        console.log("");
        process.exit(0);
      }
      selected = picked;
    } else selected = [...preset];
  }

  const meta = (domain?: string) =>
    [
      book.units.length > 1 ? `book · ${selected.length} of ${book.units.length} chapters` : "paper",
      `${pages} pages`,
      book.source.kind === "text" ? "text pdf" : "scanned pdf",
      domain,
    ]
      .filter(Boolean)
      .join(" · ");

  const opts: RunSpec["opts"] = { units: selected };
  await run({
    book,
    title: book.title,
    meta: meta(fresh ? undefined : book.domain),
    units: selected,
    opts,
    before: fresh
      ? async ({ header, emit }) => {
          // Ask a model which subject this is while the pages are prepared; planning waits for it.
          emit({ type: "stage", unit: "", stage: "init", status: "start", detail: "detecting the subject" });
          const { domain } = startBook(pdf, book);
          opts.domain = domain;
          void domain.then((d) => {
            emit({ type: "stage", unit: "", stage: "init", status: "done" });
            header(meta(d));
          });
        }
      : undefined,
  });
}

async function open() {
  if (!listBooks().length) {
    console.log(`\n${BRAND}\n\n  ${color.fg("your library is empty")} ${color.dim("— add a paper or textbook:")}\n\n${USAGE}\n`);
    return;
  }
  console.log(`\n${BRAND}\n`);
  const site = await startSite();
  await serveUntilQuit(BASE, site);
}

async function fix(query: string | undefined, problem: string | undefined) {
  if (!query || !problem) fail(`usage: yagami fix <demo> "<problem>"\n    ${color.dim('e.g. yagami fix "label smoothing" "the legend covers the curve"')}`);
  // Find the demo by id or by words of its title, across every book.
  const words = query.toLowerCase().split(/\s+/);
  const hits: { book: BookConfig; unit: string; id: string; title: string }[] = [];
  for (const book of listBooks())
    for (const u of book.units) {
      const f = path.join("src/demos", book.slug, u.id, "plan.json");
      if (!fs.existsSync(f)) continue;
      for (const d of (JSON.parse(fs.readFileSync(f, "utf8")) as DemoPlan).demos) {
        const hay = `${d.id} ${d.title}`.toLowerCase();
        if (d.id === query || words.every((w) => hay.includes(w))) hits.push({ book, unit: u.id, id: d.id, title: d.title });
      }
    }
  if (!hits.length) fail(`no demo matches "${query}"\n    ${color.dim("demo titles are shown above each demo in the site — run: yagami")}`);
  if (hits.length > 1) {
    const w = termWidth();
    const titleW = Math.min(44, Math.max(...hits.map((h) => h.title.length)));
    const list = hits
      .slice(0, 8)
      .map((h) => fit(`    ${h.title.toLowerCase().padEnd(titleW)}  ${color.dim(h.book.short.toLowerCase())}`, w))
      .join("\n");
    const more = hits.length > 8 ? `\n    ${color.dim(`+${hits.length - 8} more`)}` : "";
    fail(`"${query}" matches ${hits.length} demos — use more of the title:\n${list}${more}\n    ${color.dim(`e.g. yagami fix "${hits[0].title.toLowerCase()}" "${problem}"`)}`);
  }
  await preflightModels();
  const h = hits[0];
  const said = problem.length > 48 ? `${problem.slice(0, 47)}…` : problem;
  await run({
    book: h.book,
    title: h.title,
    meta: `fixing “${said}” · ${h.book.short.toLowerCase()}`,
    units: [h.unit],
    opts: { units: [h.unit], steps: ["verify"], only: [h.id], note: problem },
    fix: true,
  });
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd) await open();
  else if (cmd === "-h" || cmd === "--help" || cmd === "help") console.log(HELP);
  else if (cmd === "-v" || cmd === "--version") console.log(`yagami ${VERSION}`);
  else if (cmd.startsWith("-")) fail(`unknown option: ${cmd} — see yagami --help`);
  else if (cmd === "fix") await fix(rest[0], rest.slice(1).join(" ") || undefined);
  else if (rest.length) fail(`one pdf at a time — see yagami --help`);
  else await make(cmd);
} catch (e) {
  fail(humanize((e as Error).message));
}
