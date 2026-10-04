// Apply a site theme: CSS variables for the UI, the demo kit's colours (updated
// in place, so running demos recolour on their next frame), code colours, and
// the filter that re-tones the page images.

import { setCodeTheme, theme as kitTheme } from "../demo/kit";
import { DEFAULT_THEME, THEME_KEY, THEMES, paletteFor, rgbOf, type Palette, type ThemeId } from "./themes";

/** Page images are baked for yagami dark: paper #0a0a0a (10), ink #ededed (237). */
const PAPER = 10;
const INK = 237;

function rgba(hex: string, a: number) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * SVG filter mapping the baked page tones onto the theme: per channel, a line
 * through (paper → bg) and (ink → fg). Light themes invert each channel, which
 * would turn hues around, so a 180° hue rotation first keeps figure colours.
 */
function pageFilter(p: Palette): string {
  const [br, bgc, bb] = rgbOf(p.bg);
  const [fr, fg, fb] = rgbOf(p.fg);
  const fn = (b: number, f: number) => {
    const slope = (f - b) / (INK - PAPER);
    const intercept = (b - slope * PAPER) / 255;
    return `type="linear" slope="${slope.toFixed(5)}" intercept="${intercept.toFixed(5)}"`;
  };
  return `<filter id="page-tone" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${
    p.dark ? "" : '<feColorMatrix type="hueRotate" values="180"/>'
  }<feComponentTransfer><feFuncR ${fn(br, fr)}/><feFuncG ${fn(bgc, fg)}/><feFuncB ${fn(bb, fb)}/></feComponentTransfer></filter>`;
}

function ensureFilter(p: Palette) {
  let svg = document.getElementById("yagami-filters") as SVGSVGElement | null;
  if (!svg) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.id = "yagami-filters";
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("width", "0");
    el.setAttribute("height", "0");
    el.style.position = "absolute";
    document.body.appendChild(el);
    svg = el;
  }
  svg.innerHTML = pageFilter(p);
}

export function applyTheme(id: string | null | undefined): Palette {
  const p = paletteFor(id);
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--bg": p.bg,
    "--surface": p.raised,
    "--bg-hover": p.hover,
    "--border": p.border,
    "--border-strong": p.borderStrong,
    "--fg": p.fg,
    "--muted": p.muted,
    "--faint": p.faint,
    "--accent": p.accent,
    "--accent-soft": rgba(p.accent, p.dark ? 0.08 : 0.07),
    "--accent-flash": rgba(p.accent, p.dark ? 0.24 : 0.18),
    "--line": p.line,
    "--line-strong": p.lineStrong,
    "--disabled": p.dark ? p.line : p.lineStrong,
    "--scrim": p.dark ? "rgba(0, 0, 0, 0.6)" : rgba(p.fg, 0.24),
    "--scrim-soft": p.dark ? "rgba(0, 0, 0, 0.4)" : rgba(p.fg, 0.16),
    "--shadow": p.dark ? "rgba(0, 0, 0, 0.5)" : rgba(p.fg, 0.14),
    "--selection": rgba(p.accent, p.dark ? 0.32 : 0.22),
    // yagami dark is what the pages are baked for: no filter at all.
    "--page-filter": p.id === DEFAULT_THEME ? "none" : "url(#page-tone)",
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = p.id;
  root.style.colorScheme = p.dark ? "dark" : "light";
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", p.dark ? "dark" : "light");

  Object.assign(kitTheme as unknown as Record<string, string>, {
    bg: p.bg,
    fg: p.fg,
    muted: p.muted,
    faint: p.faint,
    grid: p.grid,
    accent: p.accent,
    accent2: p.accent2,
    line: p.line,
  });
  setCodeTheme(p.id);
  if (p.id !== DEFAULT_THEME) ensureFilter(p);
  return p;
}

export function savedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && THEMES.some((t) => t.id === v)) return v as ThemeId;
  } catch {
    // storage unavailable
  }
  return DEFAULT_THEME;
}

/** Apply and remember; notifies listeners (Help, palette) through a DOM event. */
export function setTheme(id: ThemeId) {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent("yagami:theme", { detail: id }));
}
