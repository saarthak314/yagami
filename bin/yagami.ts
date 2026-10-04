// yagami — turn a PDF (paper or textbook, mostly maths and CS) into a reader
// with live, generated demos beside the original pages.
//
//   yagami <file.pdf>               make the site for a PDF and open it
//   yagami                          open the site
//   yagami fix <demo> "<problem>"   fix a demo by describing what's wrong

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_CWD = process.env.YAGAMI_CWD ?? process.cwd();
process.chdir(ROOT);

const { color, createUi } = await import("../cli/ui");
const { bookUrl, serve, BASE } = await import("../cli/server");
const { pick } = await import("../cli/picker");
const books = await import("../scripts/books");
const { runBook } = await import("../scripts/run");
type BookConfig = import("../src/types").BookConfig;
type DemoPlan = import("../src/types").DemoPlan;

const HELP = `
  ${color.bold(color.accent("yagami"))}  ${color.muted("PDF in, explainer out")}

    yagami <file.pdf>               make the site for a PDF and open it
    yagami                          open the site
    yagami fix <demo> "<problem>"   fix a demo by describing what's wrong
`;

const say = (line: string) => console.log(`   ${color.accent("→")} ${line}`);

function fail(msg: string): never {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
  console.error(`\n   ${color.red("✗")} ${msg}\n`);
  process.exit(1);
}

const sha1 = (file: string) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

function slugify(s: string): string {
  const stop = new Set(["a", "an", "the", "of", "on", "for", "and", "in", "to", "with"]);
  const words = s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").split(/[\s_-]+/).filter(Boolean);
  return (words.filter((w) => !stop.has(w)).slice(0, 5).join("-") || "book").slice(0, 48);
}

function shortTitle(title: string, max = 34) {
  if (title.length <= max) return title;
  return title.slice(0, max).replace(/\s+\S*$/, "").replace(/[:,;\s-]+$/, "") + "…";
}

/** Run the pipeline with the live UI, then serve the result. */
async function run(book: BookConfig, opts: Parameters<typeof runBook>[1], unit?: string) {
  const ui = createUi({ unitTitles: Object.fromEntries(book.units.map((u) => [u.id, u.title])) });
  process.once("SIGINT", () => {
    ui.abort("cancelled");
    process.exit(130);
  });
  try {
    await runBook(book.slug, opts, ui.emit);
  } catch (e) {
    ui.abort((e as Error).message);
    process.exit(1);
  }
  ui.finish();
  process.removeAllListeners("SIGINT");
  await serve(bookUrl(book.slug, unit), say);
}

// ---------------------------------------------------------------------------

async function make(file: string) {
  const pdf = path.resolve(USER_CWD, file);
  if (!fs.existsSync(pdf)) fail(`no such file: ${file}`);
  for (const bin of ["pdfinfo", "pdftotext", "pdftoppm"])
    if (spawnSync("which", [bin]).status !== 0) fail(`${bin} not found (install poppler: brew install poppler)`);

  const hash = sha1(pdf);
  const existing = books.listBooks().find((b) => fs.existsSync(b.source.pdf) && sha1(b.source.pdf) === hash);
  let book: BookConfig;

  if (existing) book = existing;
  else {
    const src = books.detectSource(pdf);
    const units = books.suggestUnits(pdf).map((u) => ({ ...u, title: u.title || src.title }));
    const domain = await books.detectDomain(books.sampleText(pdf));
    let slug = slugify(src.title);
    for (let n = 2; fs.existsSync(path.join("books", slug)); n++) slug = `${slugify(src.title)}-${n}`;
    const dir = path.join("books", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(pdf, path.join(dir, "source.pdf"));
    book = {
      slug,
      title: src.title,
      short: shortTitle(src.title),
      ...(src.author ? { subtitle: src.author } : {}),
      source: { pdf: path.join(dir, "source.pdf"), kind: src.kind },
      domain,
      recolor: src.kind === "text" ? "lightness" : "invert",
      units,
    };
    fs.writeFileSync(path.join(dir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  }

  console.log(`\n   ${color.fg(book.title)} ${color.dim(`· ${book.domain} · ${book.units.length > 1 ? `${book.units.length} chapters` : "paper"}`)}\n`);

  // Long textbooks: choose chapters (others can be built later by running again).
  let selected = book.units.map((u) => u.id);
  if (book.units.length > 6 && process.stdin.isTTY) {
    const built = new Set(book.units.filter((u) => fs.existsSync(path.join("src/demos", book.slug, u.id, "plan.json"))).map((u) => u.id));
    const first = new Set(book.units.slice(0, 3).map((u) => u.id));
    const picked = await pick(
      "Which chapters?",
      book.units.map((u) => ({ id: u.id, label: u.title, hint: `pp. ${u.pages[0]}–${u.pages[1]}`, selected: built.size ? built.has(u.id) : first.has(u.id) })),
    );
    if (!picked?.length) fail("no chapters selected");
    selected = picked;
    console.log("");
  } else if (book.units.length > 6) selected = selected.slice(0, 3);

  await run(book, { units: selected }, selected[0]);
}

async function open() {
  if (!books.listBooks().length) {
    console.log(HELP);
    return;
  }
  console.log("");
  await serve(BASE, say);
}

async function fix(query: string | undefined, problem: string | undefined) {
  if (!query || !problem) fail('usage: yagami fix <demo> "<problem>"');
  // Find the demo by id or by words of its title, across every book.
  const words = query.toLowerCase().split(/\s+/);
  const hits: { book: BookConfig; unit: string; id: string; title: string }[] = [];
  for (const book of books.listBooks())
    for (const u of book.units) {
      const f = path.join("src/demos", book.slug, u.id, "plan.json");
      if (!fs.existsSync(f)) continue;
      for (const d of (JSON.parse(fs.readFileSync(f, "utf8")) as DemoPlan).demos) {
        const hay = `${d.id} ${d.title}`.toLowerCase();
        if (d.id === query || words.every((w) => hay.includes(w))) hits.push({ book, unit: u.id, id: d.id, title: d.title });
      }
    }
  if (!hits.length) fail(`no demo matches "${query}"`);
  if (hits.length > 1) fail(`"${query}" matches several demos; be more specific:\n${hits.map((h) => `     ${h.title}  ${color.dim(h.book.short)}`).join("\n")}`);
  const h = hits[0];
  console.log(`\n   ${color.fg(h.title)} ${color.dim(`· ${h.book.short}`)}\n`);
  await run(h.book, { units: [h.unit], steps: ["verify"], only: [h.id], note: problem }, h.unit);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd) await open();
  else if (cmd === "-h" || cmd === "--help" || cmd === "help") console.log(HELP);
  else if (cmd === "fix") await fix(rest[0], rest.slice(1).join(" ") || undefined);
  else if (cmd.toLowerCase().endsWith(".pdf")) await make(cmd);
  else fail(`not a PDF: ${cmd}\n${HELP}`);
} catch (e) {
  fail((e as Error).message);
}
