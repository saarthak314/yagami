# yagami

PDF in, explainer out. Give it a paper or a textbook (mostly maths and CS) and it builds a reader: the original pages
on the right, and on the left a live, interactive demo for whatever paragraph you are reading. As you scroll, the demo
follows the text.

```
yagami paper.pdf
```

The terminal shows the run as it happens (pages, anchors, the demo plan, then each demo being written, typechecked
and checked in a headless browser) and opens the finished book in your browser.

## Install

Requires Node 22+, poppler (`pdftoppm`, `pdftotext`, `pdfinfo`) and, for scanned PDFs, tesseract.

```
brew install poppler tesseract      # macOS
npm install
npx playwright install chromium     # used to check every demo
npm link                            # puts `yagami` on your PATH
export ANTHROPIC_API_KEY=...
```

## Usage

```
yagami <file.pdf>               make the site for a PDF and open it
yagami                          open the site
yagami fix <demo> "<problem>"   fix a demo by describing what's wrong
```

Everything else is automatic: title, subject, chapters, and whether the PDF is a scan. For a long textbook you pick
the chapters to build; run it again later to add more. Re-running only redoes what changed.

`<demo>` is any part of a demo's title, e.g. `yagami fix "closed path" "the triangle readouts stay at zero"`.

In the reader: `j`/`k` step through demos, `space` plays/pauses, `h` holds the current demo, `?` lists shortcuts. The
theme button in the header switches between yagami dark/light, gruvbox dark/light and catppuccin mocha/latte, which
recolours the pages, demos and code listings.

## How it works

1. **Pages.** Each page is rendered and recoloured for a dark reader (hue kept for colour figures, plain inversion for
   black-and-white scans). The text is never re-typeset; you read the original pages.
2. **Anchors.** Paragraphs, headings, equations, figures and tables are located from the PDF's text layer (or with
   local OCR for scans), including two-column layouts. No model is involved.
3. **Plan.** A model reads the unit (text plus page images) and proposes demos, each tied to specific paragraphs, with
   presets, controls and readouts that let you check an equation or algorithm numerically.
4. **Build and verify.** Each demo is written as a small React component against a shared drawing kit, typechecked,
   then screenshotted at every step in headless Chromium and reviewed; failures go back for revision. Demos stream
   through these stages independently, so the first ones are done while others are still being planned.

Models: Claude Opus for planning, Claude Sonnet for writing and reviewing demos. A paper typically takes a few
minutes and a few dollars; spend is shown live and logged to `work/usage.jsonl`.

## Layout

```
books/<slug>/book.json        config written by `yagami <file.pdf>` (editable)
src/demos/<slug>/<unit>/      generated demos and their plan
src/demo/kit.tsx              the drawing kit every demo uses
scripts/                      pipeline (content, demos, orchestration)
cli/, bin/                    the command-line tool
```

PDFs and everything derived from them (`work/`, `public/books/`) are git-ignored. Book text is only used as model
input for planning; captions and demo specs are written fresh. The site shows page images made from
your PDFs; only publish it if you have the rights to that material.
