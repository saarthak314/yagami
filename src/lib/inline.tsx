// Renderer for the InlineMd subset defined in src/types.ts:
// plain text, *italic*, **bold**, $inline LaTeX$, escapes \* and \$.

import katex from "katex";
import { memo, type ReactNode } from "react";

const cache = new Map<string, string>();

export function tex(latex: string, displayMode = false): string {
  const key = (displayMode ? "D" : "I") + latex;
  let html = cache.get(key);
  if (html === undefined) {
    html = katex.renderToString(latex, { displayMode, throwOnError: false, strict: "ignore", output: "html" });
    cache.set(key, html);
  }
  return html;
}

export function Tex({ latex, display = false, className }: { latex: string; display?: boolean; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: tex(latex, display) }} />;
}

type Node = string | { k: "i" | "b"; c: Node[] } | { k: "m"; s: string };

function parse(src: string): Node[] {
  let i = 0;
  const parseUntil = (close: string | null): Node[] => {
    const out: Node[] = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push(buf);
      buf = "";
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\" && (src[i + 1] === "*" || src[i + 1] === "$")) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (close && src.startsWith(close, i) && !(close === "*" && src[i + 1] === "*")) {
        i += close.length;
        flush();
        return out;
      }
      if (ch === "$") {
        const end = findMathEnd(src, i + 1);
        if (end > i) {
          flush();
          out.push({ k: "m", s: src.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (src.startsWith("**", i) && src.indexOf("**", i + 2) > 0) {
        flush();
        i += 2;
        out.push({ k: "b", c: parseUntil("**") });
        continue;
      }
      if (ch === "*" && close !== "*" && hasCloser(src, i + 1)) {
        flush();
        i += 1;
        out.push({ k: "i", c: parseUntil("*") });
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  };
  return parseUntil(null);
}

function findMathEnd(src: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "$") return j;
  }
  return -1;
}

/** A single `*` opens italics only if a matching single `*` follows (so a lone footnote marker stays literal). */
function hasCloser(src: string, from: number): boolean {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "$") {
      const e = findMathEnd(src, j + 1);
      if (e > 0) j = e;
      continue;
    }
    if (src[j] === "*") return src[j + 1] !== "*" && j > from;
  }
  return false;
}

function render(nodes: Node[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = key + i;
    if (typeof n === "string") return n;
    if (n.k === "m") return <Tex key={k} latex={n.s} />;
    if (n.k === "b") return <strong key={k}>{render(n.c, k + ".")}</strong>;
    return <em key={k}>{render(n.c, k + ".")}</em>;
  });
}

export const Inline = memo(function Inline({ md }: { md: string }) {
  return <>{render(parse(md))}</>;
});
