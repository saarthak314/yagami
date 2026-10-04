import fs from "node:fs";
import { runBook } from "./run";
import type { DemoPlan } from "../src/types";
const files = process.argv.slice(2);
const NOTE = "The reader now has light and dark site themes. Remove every hard-coded colour literal (hex, rgb(), rgba()) from this demo: use only the kit's theme.* colours (bg, fg, muted, faint, grid, line, accent, accent2), sequential()/diverging() ramps and contrastText(). For a set of distinct series/head colours, derive them from the ramps or from theme.accent/accent2/fg/muted rather than fixed hex values. Translucent fills: draw with ctx.globalAlpha and a theme colour. Keep the layout and behaviour otherwise identical.";
const jobs = new Map<string, { book: string; unit: string; ids: string[] }>();
for (const f of files) {
  const [book, unit, file] = f.split("/");
  const plan = JSON.parse(fs.readFileSync(`src/demos/${book}/${unit}/plan.json`, "utf8")) as DemoPlan;
  const d = plan.demos.find((x) => `${x.component}.tsx` === file);
  if (!d) continue;
  const k = `${book}/${unit}`;
  if (!jobs.has(k)) jobs.set(k, { book, unit, ids: [] });
  jobs.get(k)!.ids.push(d.id);
}
await Promise.all([...jobs.values()].map(async (j) => {
  const r = await runBook(j.book, { units: [j.unit], steps: ["verify"], only: j.ids, note: NOTE }, () => {});
  console.log("RESULT", j.book, j.unit, j.ids.join(","), r.failures.length ? "FAIL " + r.failures.join(" | ") : "PASS", "$" + r.cost.toFixed(2));
}));
