// The reader site: serve it in the foreground until ctrl-c.

import { spawn } from "node:child_process";
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

function open(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // no opener; the URL is printed anyway
  }
}

/**
 * Open `url`, serving the site if it isn't already running. Resolves only when
 * the server stops (ctrl-c), or right away if another yagami is serving it.
 */
export async function serve(url: string, say: (line: string) => void): Promise<void> {
  if (await siteUp()) {
    say(`${url}  (already running)`);
    open(url);
    return;
  }
  if (await portBusy()) throw new Error("port 5190 is in use by another program");
  const child = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "--clearScreen", "false"], { stdio: "ignore" });
  for (let i = 0; i < 60 && !(await siteUp()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await siteUp())) {
    child.kill();
    throw new Error("the site did not start");
  }
  say(`${url}  (ctrl-c to stop)`);
  open(url);
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise((r) => child.on("exit", r));
}
