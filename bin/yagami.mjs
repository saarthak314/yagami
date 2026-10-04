#!/usr/bin/env node
// Shim: run the TypeScript CLI through tsx from the repo root, remembering the
// caller's working directory (PDF paths are resolved against it).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "bin/yagami.ts"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, YAGAMI_CWD: process.cwd() },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {});
child.on("exit", (code, signal) => process.exit(signal ? 130 : (code ?? 0)));
