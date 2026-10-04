// Arrow-key multi-select (used to pick textbook chapters). Zero dependencies.

import { color } from "./ui";

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
  selected?: boolean;
}

/** Resolves with the selected ids, or null if the user aborts (Ctrl-C / Esc). */
export function pick(title: string, items: PickItem[]): Promise<string[] | null> {
  const stdin = process.stdin;
  const out = process.stdout;
  const sel = new Set(items.filter((i) => i.selected).map((i) => i.id));
  let cursor = 0;
  let top = 0;
  let height = 0;
  const rows = () => Math.max(5, Math.min(items.length, (out.rows ?? 24) - 6));

  const draw = () => {
    const n = rows();
    if (cursor < top) top = cursor;
    if (cursor >= top + n) top = cursor - n + 1;
    const lines = [`   ${color.fg(title)}`, `   ${color.dim("↑↓ move · space select · a all · enter confirm")}`, ""];
    for (let i = top; i < Math.min(items.length, top + n); i++) {
      const it = items[i];
      const on = sel.has(it.id);
      const mark = on ? color.accent("◆") : color.faint("◇");
      const label = i === cursor ? color.fg(it.label) : on ? color.muted(it.label) : color.dim(it.label);
      lines.push(`  ${i === cursor ? color.accent("›") : " "} ${mark} ${label}${it.hint ? `  ${color.faint(it.hint)}` : ""}`);
    }
    if (items.length > n) lines.push(`     ${color.faint(`${top + 1}–${Math.min(items.length, top + n)} of ${items.length}`)}`);
    lines.push("", `   ${color.dim(`${sel.size} selected`)}`);
    out.write((height ? `\x1b[${height}A` : "") + "\r\x1b[J" + lines.join("\n") + "\n");
    height = lines.length;
  };

  return new Promise((resolve) => {
    const done = (v: string[] | null) => {
      stdin.off("data", onKey);
      stdin.setRawMode?.(false);
      stdin.pause();
      out.write("\x1b[?25h");
      resolve(v);
    };
    const onKey = (buf: Buffer) => {
      const k = buf.toString();
      if (k === "\x03" || k === "\x1b") return done(null);
      if (k === "\r" || k === "\n") return done(items.filter((i) => sel.has(i.id)).map((i) => i.id));
      if (k === "\x1b[A" || k === "k") cursor = (cursor - 1 + items.length) % items.length;
      else if (k === "\x1b[B" || k === "j") cursor = (cursor + 1) % items.length;
      else if (k === " ") {
        const id = items[cursor].id;
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
      } else if (k === "a") {
        if (sel.size === items.length) sel.clear();
        else for (const i of items) sel.add(i.id);
      }
      draw();
    };
    out.write("\x1b[?25l");
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onKey);
    draw();
  });
}
