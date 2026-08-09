// `malloyyo init` — make a model repo "just work" when you fire off Claude:
//   1. Write .mcp.json so `cd <repo> && claude` connects the AUTHOR server
//      (malloyyo mcp --develop) — named `malloyyo_author`, so the mode shows in
//      every tool prefix (mcp__malloyyo_author__…) and can't be confused with
//      the core malloy-cli.
//   2. Scaffold index.malloy (the entry model the dashboard/publish tooling
//      requires) if it's missing, re-exporting the repo's models — so the
//      "No index.malloy" landmine doesn't hit every authoring session.
//   3. Pre-approve the author server's tools in .claude/settings.json, so the
//      first compile/query doesn't stop for a permission prompt. Merged, never
//      clobbered — the file is hand-edited.
//
// The .mcp.json is the guaranteed fix; the index.malloy is a best-effort
// scaffold to review (validate it with `malloyyo mcp --develop` / `dashboard
// dev`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { developSurface, type DevelopHost } from "@malloyyo/mcp-engine";

/** The server KEY is the tool prefix: mcp__<key>__<tool>. */
const AUTHOR_SERVER = "malloyyo_author";

const AUTHOR_MCP = {
  mcpServers: {
    // No -C: the server roots at the launch cwd (the project dir), so this file
    // is portable/committable — no absolute paths baked in.
    [AUTHOR_SERVER]: { command: "malloyyo", args: ["mcp", "--develop"] },
  },
};

/**
 * The permission rules that pre-approve the author server's tools.
 *
 * DERIVED from the surface, never hand-listed: a hand-written list is exactly
 * what rotted before — settings.json allowed `mcp__malloyyo-local__*` /
 * `mcp__malloy__*` from an older naming scheme, matched nothing once the server
 * became `malloyyo_author`, and so every call still prompted. Reading the names
 * off developSurface() means adding a tool to the engine updates this for free.
 *
 * The stub host is never invoked: developSurface only closes over it, and the
 * handlers (the sole callers) don't run while we're listing names.
 */
export function authorToolPermissions(): string[] {
  const stub = {
    withRuntime: () => Promise.reject(new Error("unused: listing tool names only")),
  } as unknown as DevelopHost;
  return developSurface(stub)
    .tools.map((t) => `mcp__${AUTHOR_SERVER}__${t.name}`)
    .sort();
}

/**
 * Merge the author tool rules into a parsed .claude/settings.json.
 *
 * Pure, and deliberately conservative: unrelated keys and existing allow
 * entries are preserved, and anything unexpected is reported rather than
 * overwritten — this file is hand-edited and losing it would be worse than
 * leaving a permission prompt in place.
 */
export function withAuthorPermissions(
  input: unknown,
): { settings: Record<string, unknown>; added: string[] } | { error: string } {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (input !== undefined && !isPlainObject(input)) {
    return { error: ".claude/settings.json isn't a JSON object" };
  }
  const settings: Record<string, unknown> = input ?? {};

  const rawPerms = settings.permissions ?? {};
  if (!isPlainObject(rawPerms)) return { error: `"permissions" isn't an object` };

  const rawAllow = rawPerms.allow;
  if (rawAllow !== undefined && !Array.isArray(rawAllow)) {
    return { error: `"permissions.allow" isn't an array` };
  }
  const allow = (rawAllow ?? []) as unknown[];

  const added = authorToolPermissions().filter((rule) => !allow.includes(rule));
  if (added.length === 0) return { settings, added };

  settings.permissions = { ...rawPerms, allow: [...allow, ...added] };
  return { settings, added };
}

/** Write the merged permissions back, creating .claude/settings.json if absent. */
function allowAuthorTools(root: string): { added: string[]; note?: string } {
  const file = path.join(root, ".claude", "settings.json");

  let existing: unknown;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { added: [], note: ".claude/settings.json isn't valid JSON — left as-is" };
    }
  }

  const merged = withAuthorPermissions(existing);
  if ("error" in merged) return { added: [], note: `${merged.error} — left as-is` };
  if (merged.added.length === 0) return { added: [] };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged.settings, null, 2) + "\n");
  return { added: merged.added };
}

/** Top-level exportable names in a .malloy file: sources, queries, and givens.
    Heuristic (no compile) — good enough to scaffold; the author reviews it. */
function exportableNames(src: string): string[] {
  const names = new Set<string>();
  // Strip line comments so `// query: foo` etc. don't match.
  const code = src.replace(/\/\/[^\n]*/g, "");
  for (const m of code.matchAll(/^\s*(?:source|query)\s*:\s*([A-Za-z_]\w*)\s+is\b/gm)) {
    names.add(m[1]);
  }
  // givens: `NAME :: filter<…> is …` (the `::` type annotation is distinctive).
  for (const m of code.matchAll(/^\s*([A-Za-z_]\w*)\s*::/gm)) {
    names.add(m[1]);
  }
  return [...names];
}

function scaffoldIndex(root: string): { wrote: boolean; note: string } {
  const indexPath = path.join(root, "index.malloy");
  if (fs.existsSync(indexPath)) {
    return { wrote: false, note: "index.malloy already exists — left as-is" };
  }
  const models = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".malloy") && f !== "index.malloy")
    .sort();
  if (models.length === 0) {
    return { wrote: false, note: "no .malloy files found — skipped index.malloy" };
  }
  const blocks: string[] = [
    "// Generated by `malloyyo init` — the entry model. `dashboard dev`, `lint`,",
    "// `malloyyo test`, and the hosted app only see what THIS file exports.",
    "// Review the re-exports below (add givens / suggest queries your dashboards",
    "// reference), then validate with `malloyyo mcp --develop` or `dashboard dev`.",
    "",
  ];
  let anyNames = false;
  for (const file of models) {
    const names = exportableNames(fs.readFileSync(path.join(root, file), "utf8"));
    if (names.length === 0) {
      blocks.push(`// ${file}: no top-level source/query/given detected — add exports by hand`);
      continue;
    }
    anyNames = true;
    const list = names.join(", ");
    blocks.push(`import { ${list} } from './${file}'`);
    blocks.push(`export { ${list} }`);
    blocks.push("");
  }
  fs.writeFileSync(indexPath, blocks.join("\n") + "\n");
  return {
    wrote: true,
    note: anyNames
      ? `wrote index.malloy re-exporting ${models.length} model file(s) — REVIEW it`
      : "wrote index.malloy skeleton — no exports detected, fill them in by hand",
  };
}

/** Copy the bundled Claude skill templates into the project's .claude/skills/.
    The templates ride in dist/templates/ (copied there at build time by
    copy-frame-src.mjs), next to this file's bundle (dist/index.js) — resolve
    them relative to import.meta.url, same as the frame runtime. Existing skill
    directories are left untouched so a re-init never clobbers local edits. */
function installSkills(root: string): { wrote: string[]; skipped: string[]; note?: string } {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  // Dev (tsx src/index.ts) resolves to src/, where templates live directly;
  // a published install resolves to dist/, where the build copied them.
  const candidates = [
    path.join(distDir, "templates", "skills"),
    path.join(distDir, "..", "src", "templates", "skills"),
  ];
  const srcSkills = candidates.find((p) => fs.existsSync(p));
  if (!srcSkills) return { wrote: [], skipped: [], note: "no skill templates found — skipped" };

  const destSkills = path.join(root, ".claude", "skills");
  fs.mkdirSync(destSkills, { recursive: true });
  const wrote: string[] = [];
  const skipped: string[] = [];
  for (const name of fs.readdirSync(srcSkills)) {
    const from = path.join(srcSkills, name);
    if (!fs.statSync(from).isDirectory()) continue;
    const to = path.join(destSkills, name);
    if (fs.existsSync(to)) {
      skipped.push(name);
      continue;
    }
    fs.cpSync(from, to, { recursive: true });
    wrote.push(name);
  }
  return { wrote, skipped };
}

export async function initCmd(dir: string): Promise<void> {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }

  const mcpPath = path.join(root, ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    // Don't clobber a hand-tuned config; report what a fresh one would be.
    console.log(`• .mcp.json exists — leaving it. For author-by-default it should be:`);
    console.log(`    ${JSON.stringify(AUTHOR_MCP.mcpServers.malloyyo_author)}`);
    console.log(`  (server key "malloyyo_author", command "malloyyo mcp --develop").`);
  } else {
    fs.writeFileSync(mcpPath, JSON.stringify(AUTHOR_MCP, null, 2) + "\n");
    console.log(`✓ wrote .mcp.json — \`cd ${dir} && claude\` now opens in AUTHOR mode`);
  }

  const idx = scaffoldIndex(root);
  console.log(`${idx.wrote ? "✓" : "•"} ${idx.note}`);

  const sk = installSkills(root);
  if (sk.note) {
    console.log(`• ${sk.note}`);
  } else {
    if (sk.wrote.length) {
      console.log(`✓ installed skill(s) into .claude/skills/: ${sk.wrote.join(", ")}`);
    }
    if (sk.skipped.length) {
      console.log(`• skill(s) already present — left as-is: ${sk.skipped.join(", ")}`);
    }
  }

  const perms = allowAuthorTools(root);
  if (perms.note) {
    console.log(`• ${perms.note}`);
  } else if (perms.added.length) {
    console.log(
      `✓ pre-approved ${perms.added.length} author tool(s) in .claude/settings.json` +
        ` — no permission prompt on first use`,
    );
  } else {
    console.log(`• author tools already allowed in .claude/settings.json`);
  }

  console.log("");
  console.log("Next:");
  console.log("  claude              # author mode (mcp__malloyyo_author__* tools)");
  console.log("  malloyyo test       # preview exactly what claude.ai web will see");
  console.log("  malloyyo dashboard dev   # see dashboards render in a browser");
}
