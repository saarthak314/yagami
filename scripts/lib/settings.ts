// User settings made from the site's "model" panel: which provider to use and pasted API keys.
// Stored outside the repo in ~/.config/yagami/settings.json (YAGAMI_SETTINGS overrides the path),
// readable only by the user. Keys apply to this process (and the builds it starts) unless the same
// variable is already set in the environment, which always wins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "./providers/types";

export interface Settings {
  /** Chosen provider; unset = the first one set up (see activeProvider). */
  provider?: ProviderId;
  keys?: { anthropic?: string; openai?: string };
}

const ENV_OF = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;
export type KeyProvider = keyof typeof ENV_OF;

/** The environment as the process started (before saved keys were applied): it tells a key's source. */
const startEnv = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };

export function settingsPath(): string {
  return process.env.YAGAMI_SETTINGS ?? path.join(os.homedir(), ".config", "yagami", "settings.json");
}

export function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(s: Settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Put saved keys into process.env where the environment doesn't set them (call once at startup). */
export function applySettings(): void {
  const s = readSettings();
  for (const k of Object.keys(ENV_OF) as KeyProvider[]) {
    if (startEnv[k]) continue;
    if (s.keys?.[k]) process.env[ENV_OF[k]] = s.keys[k];
    else delete process.env[ENV_OF[k]];
  }
}

/** Where a key comes from: the environment, the saved settings, or nowhere. */
export function keySource(k: KeyProvider): "env" | "saved" | null {
  if (startEnv[k]) return "env";
  return readSettings().keys?.[k] ? "saved" : null;
}

/** The last four characters of the key in use, for display ("…a1b2"). */
export function keyHint(k: KeyProvider): string | null {
  const v = startEnv[k] ?? readSettings().keys?.[k];
  return v ? `…${v.slice(-4)}` : null;
}

export function saveKey(k: KeyProvider, key: string | null): void {
  const s = readSettings();
  const keys = { ...(s.keys ?? {}) };
  if (key) keys[k] = key;
  else delete keys[k];
  writeSettings({ ...s, keys });
  applySettings();
}

export function saveProvider(p: ProviderId | null): void {
  const s = readSettings();
  if (p) s.provider = p;
  else delete s.provider;
  writeSettings(s);
}
