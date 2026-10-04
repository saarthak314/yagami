// Chapter picker: arrows move, space toggles, a all/none, enter builds, esc
// cancels. Zero dependencies.

import { color, fit, onKeys, termWidth, visible } from "./ui";

export interface PickItem {
  id: string;
  label: string;
  /** Page range, for the selection total. */
  pages: [number, number];
  /** Already built (shown with a quiet mark). */
  built?: boolean;
  selected?: boolean;
}

/** Resolves with the selected ids, or null if the user cancels (esc / q / ctrl-c). */
export function pick(title: string, items: PickItem[]): Promise<string[] | null> {
  const out = process.stdout;
  const sel = new Set(items.filter((i) => i.selected).map((i) => i.id));
  let cursor = Math.max(0, items.findIndex((i) => i.selected));
  let top = 0;
  let height = 0;
  let hint = "";

  const range = (it: PickItem) => `pp. ${it.pages[0]}–${it.pages[1]}`;
  const rangeW = Math.max(...items.map((i) => range(i).length));

  const draw = () => {
    const width = termWidth();
    // Rows for items: the terminal minus title, blank, two "more" rows, blank, footer.
    const n = Math.max(3, Math.min(items.length, (out.rows ?? 24) - 7));
    top = Math.min(top, Math.max(0, items.length - n));
    if (cursor < top) top = cursor;
    if (cursor >= top + n) top = cursor - n + 1;
    const labelW = Math.max(10, Math.min(52, width - rangeW - 14));
    const lines = [fit(`  ${color.fg(title)}`, width), ""];
    lines.push(top > 0 ? `    ${color.faint(`↑ ${top} more`)}` : "");
    for (let i = top; i < Math.min(items.length, top + n); i++) {
      const it = items[i];
      const on = sel.has(it.id);
      const here = i === cursor;
      const mark = on ? color.accent("●") : color.faint("○");
      const text = fit(it.label.toLowerCase(), labelW);
      const label = here ? color.fg(text) : on ? color.muted(text) : color.dim(text);
      const gap = " ".repeat(Math.max(1, labelW - visible(text).length + 2));
      lines.push(fit(`${here ? color.accent("›") : " "} ${mark} ${label}${gap}${color.faint(range(it).padStart(rangeW))}${it.built ? color.dim("  built") : ""}`, width));
    }
    const below = items.length - (top + n);
    lines.push(below > 0 ? `    ${color.faint(`↓ ${below} more`)}` : "");
    const chosen = items.filter((i) => sel.has(i.id));
    const pages = chosen.reduce((s, i) => s + i.pages[1] - i.pages[0] + 1, 0);
    const count = hint ? color.red(hint) : color.dim(chosen.length ? `${chosen.length} selected · ${pages} pages` : "none selected");
    // Keys in priority order: what you need to finish first.
    const keys = ["enter build", "esc cancel", "space select", sel.size === items.length ? "a none" : "a all", "↑↓ move"];
    let keyText = "";
    for (const k of keys) {
      const next = keyText ? `${keyText} · ${k}` : k;
      if (visible(count).length + 4 + next.length > width - 2) break;
      keyText = next;
    }
    lines.push("", `  ${count}  ${color.faint(keyText)}`);
    out.write((height ? `\x1b[${height}A\r` : "") + lines.map((l) => `${l}\x1b[K`).join("\n") + "\n\x1b[J");
    height = lines.length;
  };

  return new Promise((resolve) => {
    out.write("\x1b[?25l");
    const done = (v: string[] | null) => {
      stop();
      out.off("resize", onResize);
      // Collapse the list into one line saying what was chosen.
      const what = v === null ? color.dim("cancelled") : color.dim(`${v.length} ${v.length === 1 ? "chapter" : "chapters"}: ${v.join(", ")}`);
      out.write(`\x1b[${height}A\r\x1b[J${fit(`  ${color.fg(title)}  ${what}`, termWidth())}\n\x1b[?25h`);
      resolve(v);
    };
    const onResize = () => {
      // The old frame re-wraps on resize: repaint from a clean screen.
      out.write("\x1b[2J\x1b[H");
      height = 0;
      draw();
    };
    const stop = onKeys((k) => {
      if (k === "\x03" || k === "\x1b" || k === "q") return done(null);
      if (k === "\r" || k === "\n") {
        if (sel.size) return done(items.filter((i) => sel.has(i.id)).map((i) => i.id));
        hint = "select at least one";
        return draw();
      }
      hint = "";
      if (k === "\x1b[A" || k === "k") cursor = (cursor - 1 + items.length) % items.length;
      else if (k === "\x1b[B" || k === "j") cursor = (cursor + 1) % items.length;
      else if (k === " ") {
        const id = items[cursor].id;
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
      } else if (k === "a") {
        if (sel.size === items.length) sel.clear();
        else for (const i of items) sel.add(i.id);
      } else return;
      draw();
    });
    out.on("resize", onResize);
    draw();
  });
}
