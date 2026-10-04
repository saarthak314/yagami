// Site themes: one palette drives the UI (CSS variables), the demo canvas
// (the kit's `theme` object), code listings (draw.code) and the page tone.

export type ThemeId = "yagami-dark" | "yagami-light" | "gruvbox-dark" | "gruvbox-light" | "catppuccin-mocha" | "catppuccin-latte";

export type CodeColors = Record<"plain" | "keyword" | "type" | "string" | "number" | "comment" | "function" | "operator" | "punct" | "preproc", string>;

export interface Palette {
  id: ThemeId;
  label: string;
  dark: boolean;
  bg: string;
  /** Raised surfaces: popovers, cards, the demo sheet. */
  raised: string;
  hover: string;
  border: string;
  borderStrong: string;
  fg: string;
  muted: string;
  faint: string;
  /** Faint guide lines on demo stages (grids, out-of-range cells). */
  grid: string;
  accent: string;
  accent2: string;
  /** Cell outlines, scrollbar thumbs, control borders. */
  line: string;
  lineStrong: string;
  code: CodeColors;
}

export const THEMES: Palette[] = [
  {
    id: "yagami-dark",
    label: "yagami dark",
    dark: true,
    bg: "#0a0a0a",
    raised: "#0f0f0f",
    hover: "#1a1a1a",
    border: "#1f1f1f",
    borderStrong: "#262626",
    fg: "#ededed",
    muted: "#a1a1a1",
    faint: "#6b6b6b",
    grid: "#1f1f1f",
    accent: "#52a8ff",
    accent2: "#f5a623",
    line: "#2e2e2e",
    lineStrong: "#3d3d3d",
    code: {
      plain: "#ededed",
      keyword: "#f75f8f",
      type: "#52a8ff",
      string: "#62c073",
      number: "#52a8ff",
      comment: "#8f8f8f",
      function: "#c472fb",
      operator: "#ededed",
      punct: "#a1a1a1",
      preproc: "#f75f8f",
    },
  },
  {
    id: "yagami-light",
    label: "yagami light",
    dark: false,
    bg: "#ffffff",
    raised: "#fafafa",
    hover: "#f2f2f2",
    border: "#eaeaea",
    borderStrong: "#e0e0e0",
    fg: "#171717",
    muted: "#4d4d4d",
    faint: "#8f8f8f",
    grid: "#ebebeb",
    accent: "#0068d6",
    accent2: "#ab570a",
    line: "#d4d4d4",
    lineStrong: "#c2c2c2",
    code: {
      plain: "#171717",
      keyword: "#c41562",
      type: "#0068d6",
      string: "#297a3a",
      number: "#0068d6",
      comment: "#6f6f6f",
      function: "#7d00cc",
      operator: "#171717",
      punct: "#666666",
      preproc: "#c41562",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    dark: true,
    bg: "#282828",
    raised: "#32302f",
    hover: "#3c3836",
    border: "#3c3836",
    borderStrong: "#504945",
    fg: "#ebdbb2",
    muted: "#bdae93",
    faint: "#7c6f64",
    grid: "#3c3836",
    accent: "#83a598",
    accent2: "#fe8019",
    line: "#504945",
    lineStrong: "#665c54",
    code: {
      plain: "#ebdbb2",
      keyword: "#fb4934",
      type: "#fabd2f",
      string: "#b8bb26",
      number: "#d3869b",
      comment: "#928374",
      function: "#8ec07c",
      operator: "#fe8019",
      punct: "#a89984",
      preproc: "#8ec07c",
    },
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    dark: false,
    bg: "#fbf1c7",
    raised: "#f2e5bc",
    hover: "#ebdbb2",
    border: "#ebdbb2",
    borderStrong: "#d5c4a1",
    fg: "#3c3836",
    muted: "#665c54",
    faint: "#928374",
    grid: "#ebdbb2",
    accent: "#076678",
    accent2: "#af3a03",
    line: "#d5c4a1",
    lineStrong: "#bdae93",
    code: {
      plain: "#3c3836",
      keyword: "#9d0006",
      type: "#b57614",
      string: "#79740e",
      number: "#8f3f71",
      comment: "#928374",
      function: "#427b58",
      operator: "#af3a03",
      punct: "#7c6f64",
      preproc: "#427b58",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    dark: true,
    bg: "#1e1e2e",
    raised: "#181825",
    hover: "#313244",
    border: "#313244",
    borderStrong: "#45475a",
    fg: "#cdd6f4",
    muted: "#a6adc8",
    faint: "#6c7086",
    grid: "#313244",
    accent: "#89b4fa",
    accent2: "#fab387",
    line: "#45475a",
    lineStrong: "#585b70",
    code: {
      plain: "#cdd6f4",
      keyword: "#cba6f7",
      type: "#f9e2af",
      string: "#a6e3a1",
      number: "#fab387",
      comment: "#7f849c",
      function: "#89b4fa",
      operator: "#89dceb",
      punct: "#9399b2",
      preproc: "#f5c2e7",
    },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    dark: false,
    bg: "#eff1f5",
    raised: "#e6e9ef",
    hover: "#dce0e8",
    border: "#ccd0da",
    borderStrong: "#bcc0cc",
    fg: "#4c4f69",
    muted: "#6c6f85",
    faint: "#9ca0b0",
    grid: "#dce0e8",
    accent: "#1e66f5",
    accent2: "#fe640b",
    line: "#bcc0cc",
    lineStrong: "#acb0be",
    code: {
      plain: "#4c4f69",
      keyword: "#8839ef",
      type: "#df8e1d",
      string: "#40a02b",
      number: "#fe640b",
      comment: "#8c8fa1",
      function: "#1e66f5",
      operator: "#04a5e5",
      punct: "#7c7f93",
      preproc: "#ea76cb",
    },
  },
];

export const DEFAULT_THEME: ThemeId = "yagami-dark";
export const THEME_KEY = "yagami.theme";

export function paletteFor(id: string | null | undefined): Palette {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** "#rrggbb" → "r, g, b" for rgba(var(--x-rgb), a) style use. */
export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Line highlight behind the executing line in code listings. */
export function lineHighlight(p: Palette): string {
  const [r, g, b] = rgbOf(p.accent);
  return `rgba(${r}, ${g}, ${b}, ${p.dark ? 0.14 : 0.12})`;
}
