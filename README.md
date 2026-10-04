# yagami

PDF in, explainer out. Give it a paper or a textbook (mostly maths and CS) and it builds a reader: the original pages,
with a live, interactive demo beside whatever paragraph you are reading. As you scroll, the demo follows the text.

```
yagami paper.pdf
```

## Install

Requires Node 22+, poppler (`pdftoppm`, `pdftotext`, `pdfinfo`), and tesseract for scanned PDFs.

```
brew install poppler tesseract      # macOS
npm install
npx playwright install chromium     # used to check every demo
npm link                            # puts `yagami` on your PATH
export ANTHROPIC_API_KEY=...
```

## Usage

```
yagami <file.pdf>               make the site for a pdf and open it
yagami                          open the site
yagami fix <demo> "<problem>"   fix a demo by describing what's wrong
```

Everything else is automatic: title, subject, chapters, and whether the PDF is a scan. For a long textbook you pick
the chapters to build (arrows, space, `a` for all, enter); run it again later to add more. Running the same command
again only redoes what changed, so it is also how you resume a stopped run.

While it runs, the terminal shows each step and every demo as it is written, typechecked and tested, with the elapsed
time and cost. Keys: `o` opens the site (pages are readable before the demos finish), `d` shows details, `q` stops.
When it finishes, any demo that failed comes with the `yagami fix` command to repair it.

`<demo>` is any part of a demo's title, e.g. `yagami fix "closed path" "the triangle readouts stay at zero"`.

## The reader

- **Library**: every book you've built, with a continue-reading shortcut. Drop a PDF on it (or choose a file) to build
  a new book from the browser: it shows what it found, lets you pick chapters for long books, says what it will
  cost, then builds with live progress. Pages are readable as soon as they're ready, the build keeps going if you
  close the tab, and a stopped build can be resumed.
- **Reading**: pages on the left, demo on the right (drag the divider to resize). The paragraph a demo explains is
  highlighted; markers in the margin jump to each step.
- **Getting around**: contents (`t`), search across books, sections and demos (`⌘k`), zoom (`+`/`−`).
- **Demos**: step with `j`/`k`, play/pause with `space`, pin with `h`, focus with `f`, hide with `d`.
- **Themes**: yagami dark/light, gruvbox dark/light and catppuccin mocha/latte, from the theme button. They recolour
  the pages, demos and code listings.
- **Phone**: full-width pages with the demo in a bottom sheet.

## How it works

1. **Pages.** Each page is rendered and recoloured to the theme (figure colours keep their hue), with sharper
   variants for zoom and high-DPI screens. The text is never re-typeset; you read the original pages.
2. **Anchors.** Paragraphs, headings, equations, figures and tables are located from the PDF's text layer (or with
   local OCR for scans), including two-column layouts. No model is involved.
3. **Plan.** Short units (up to 8 pages) are split into groups of sections and each group's demos are written
   directly, all groups in parallel; longer units get a short outline first. Each demo is tied to specific
   paragraphs and made in parallel: if it fits one of the built-in templates (function plot,
   simulation, vector diagram, matrix operations, random experiment, table, algorithm step-through) the model only
   writes its settings; otherwise it writes a small React component against a shared drawing kit.
4. **Check.** Every demo is opened in headless Chromium at every step and checked by code first (errors, blank
   stage, broken or wrong readouts against values the text pins down, clipped or overlapping labels); problems go
   straight back to the model. A model review of one contact sheet runs only when the code checks can't judge it.
   Demos stream through these stages independently, so the first ones are ready while others are still being made.

Model: Claude Sonnet 5.5 for every demo step (medium effort for first drafts, low for small fixes). A short paper
typically takes 20–30 seconds and about 20 cents; spend is shown live and logged to `work/usage.jsonl`.

## Layout

```
bin/, cli/                    the command-line tool
scripts/                      pipeline (pages, anchors, plan, build, verify)
src/                          the reader
src/demo/kit.tsx              the drawing kit every demo uses
src/demo/reference/           hand-written example demos the generator follows
```

Your books stay local and are git-ignored: `books/<slug>/` (the PDF and its config), `src/demos/<slug>/` (the
generated demos), `public/books/` (page images) and `work/` (caches). Book text is only used as model input for
planning; captions and demo specs are written fresh. The site shows page images made from your PDFs; only publish it
if you have the rights to that material.
