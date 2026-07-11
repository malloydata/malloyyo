// `malloyyo author` / `malloyyo test` — launch Claude Code wired to EXACTLY one
// malloyyo surface, deterministically:
//   author → the develop surface (compile/prettify/query any .malloy)
//   test   → the explore surface (the faithful claude.ai web preview)
//
// Each writes an ephemeral single-server MCP config and execs
// `claude --strict-mcp-config --mcp-config <cfg>`, so the session gets ONLY that
// surface — never both tool sets at once (which would break the web-mirror
// fidelity), and never the wrong cousin server (malloy-cli). The two modes are
// separate sessions on purpose; a nice loop is author in one pane, test in
// another.
//
// Note: --strict-mcp-config also drops your OTHER MCP servers for the session
// (that's the point for `test` — the web only has the malloyyo connector). For
// day-to-day authoring that keeps your other servers, use `malloyyo init` +
// `cd <repo> && claude` instead (an additive .mcp.json).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Mode = "author" | "test";

const SURFACE_FLAG: Record<Mode, string> = { author: "--develop", test: "--explore" };
const SERVER_KEY: Record<Mode, string> = { author: "malloyyo_author", test: "malloyyo_test" };

export async function launchCmd(mode: Mode, opts: { root?: string }): Promise<void> {
  const root = path.resolve(opts.root ?? process.cwd());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-launch-"));
  const cfgPath = path.join(tmpDir, "mcp.json");
  const cfg = {
    mcpServers: {
      // Absolute -C: an ephemeral config, so pinning the root is robust.
      [SERVER_KEY[mode]]: { command: "malloyyo", args: ["mcp", SURFACE_FLAG[mode], "-C", root] },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const label = mode === "author" ? "AUTHOR (compile/edit)" : "TEST (claude.ai web preview)";
  process.stderr.write(`▶ launching Claude in ${label} mode over ${root}\n`);

  const child = spawn("claude", ["--strict-mcp-config", "--mcp-config", cfgPath], {
    stdio: "inherit",
    cwd: root,
  });
  await new Promise<void>((resolve) => {
    child.on("error", (e) => {
      process.stderr.write(
        `✗ could not launch \`claude\`: ${e.message}\n  (is Claude Code installed and on PATH?)\n`,
      );
      resolve();
    });
    child.on("exit", () => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
