// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { runVercelBuild } from "../src/lib/vercel-build.js";

function buildApplication(): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", "build"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build failed (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}

await runVercelBuild({
  build: buildApplication,
  migrate: async () => {
    const { runMigrations } = await import("../src/lib/migrate.js");
    await runMigrations();
  },
});
