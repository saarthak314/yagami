// The reader site: started in the background as soon as a run begins (so `o`
// works while demos are still being made), then kept up until the user quits.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export const BASE = "http://127.0.0.1:5190"; // vite.config.ts (strictPort)

/** True when our site answers on the port (another project may hold it). */
async function siteUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(800) });
    return res.ok && (await res.text()).includes("/src/main.tsx");
  } catch {
    return false;
  }
}

async function portBusy(): Promise<boolean> {
  try {
    await fetch(`${BASE}/`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

export function bookUrl(slug: string, unit?: string) {
  return `${BASE}/#/${slug}${unit ? `/${unit}` : ""}`;
}

export function openUrl(url: string) {
  if (process.env.YAGAMI_NO_OPEN) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // no opener; the URL is printed anyway
  }
}

export interface Site {
  /** The site answers. */
  up: boolean;
  /** We started it (and stop it on quit); false when another yagami is serving. */
  owned: boolean;
  error?: string;
  stop(): void;
}

/** Start the dev server unless ours is already running. Never throws. */
export async function startSite(): Promise<Site> {
  if (await siteUp()) return { up: true, owned: false, stop() {} };
  if (await portBusy()) return { up: false, owned: false, error: "port 5190 is used by another program", stop() {} };
  const child: ChildProcess = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "--clearScreen", "false"], { stdio: "ignore" });
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", stop);
  for (let i = 0; i < 60; i++) {
    if (await siteUp()) return { up: true, owned: true, stop };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  return { up: false, owned: false, error: "the site did not start", stop() {} };
}
