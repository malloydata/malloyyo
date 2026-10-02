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
//   4. Write .devcontainer/devcontainer.json, so the repo can be opened as a
//      GitHub Codespace on the prebuilt image that already has all of the
//      above installed — the CLI, Claude, the Malloy extension, gcloud.
//
// The .mcp.json is the guaranteed fix; the index.malloy is a best-effort
// scaffold to review (validate it with `malloyyo mcp --develop` / `dashboard
// dev`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATASETS_DIR, developSurface, type DevelopHost } from "@malloyyo/mcp-engine";

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

/**
 * The repo skeleton: connections, and the directory datasets live in.
 *
 * NO DATASET. A repo publishes one dataset per directory under `datasets/`, and
 * which datasets a repo has is a modelling decision — `claude` at the repo root
 * makes them (see the malloyyo-datasets skill). Scaffolding one here would be a
 * guess at a name, and a wrong name publishes a dataset under the wrong name.
 *
 * Writes nothing that already exists. An `index.malloy` at the root means a repo
 * built the old way; it is left exactly as it is, and `lint` and `publish` are
 * where the conversion gets explained.
 */
function scaffoldRepo(root: string): { notes: string[]; oldLayout?: true } {
  const notes: string[] = [];

  if (fs.existsSync(path.join(root, "index.malloy"))) {
    notes.push("• index.malloy at the root — the old single-dataset layout, left as-is");
    notes.push("  (run `malloyyo lint` here for how to convert it)");
    return { notes, oldLayout: true };
  }

  const configPath = path.join(root, "malloy-config.json");
  if (fs.existsSync(configPath)) {
    notes.push("• malloy-config.json exists — left as-is");
  } else {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ connections: { duckdb: { is: "duckdb" } } }, null, 2) + "\n",
    );
    notes.push("✓ wrote malloy-config.json — DuckDB to start; add connections as you need them");
  }

  const datasetsDir = path.join(root, DATASETS_DIR);
  if (fs.existsSync(datasetsDir)) {
    const have = fs
      .readdirSync(datasetsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    notes.push(
      have.length
        ? `• ${DATASETS_DIR}/ exists — ${have.length} dataset(s): ${have.join(", ")}`
        : `• ${DATASETS_DIR}/ exists but is empty — ask claude to add a dataset`,
    );
  } else {
    fs.mkdirSync(datasetsDir, { recursive: true });
    // git tracks files, not directories, so the shape only survives a commit
    // if something is in it.
    fs.writeFileSync(
      path.join(datasetsDir, ".gitkeep"),
      "# Each directory here is a dataset, named after the directory.\n",
    );
    notes.push(`✓ created ${DATASETS_DIR}/ — one directory per dataset`);
  }
  return { notes };
}

/** Resolve something inside the bundled templates/ directory.

    The templates ride in dist/templates/ (copied there at build time by
    copy-frame-src.mjs), next to this file's bundle (dist/index.js) — resolve
    them relative to import.meta.url, same as the frame runtime. Dev
    (tsx src/index.ts) resolves to src/, where they live directly. */
function templatePath(...parts: string[]): string | undefined {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(distDir, "templates", ...parts),
    path.join(distDir, "..", "src", "templates", ...parts),
  ].find((p) => fs.existsSync(p));
}

/** Copy the bundled Claude skill templates into the project's .claude/skills/.
    Existing skill directories are left untouched so a re-init never clobbers
    local edits.

    Those two facts used to be in tension: a skill was a few hundred lines of
    procedure, copied per repo and then frozen — never updated by a later CLI,
    with nothing to tell a reader which vintage they were looking at. The
    skills are now STUBS. Each one carries a description (the trigger, which is
    what a copied file is actually for) and a pointer to the `yo_help` topic
    holding the procedure — `site/data-site`, `site/auto-update`. The content
    ships in the engine and updates with the installed CLI, so the copy has
    nothing in it that can go stale, and never clobbering it stays safe. */
function installSkills(root: string): { wrote: string[]; skipped: string[]; note?: string } {
  const srcSkills = templatePath("skills");
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

/** Write .devcontainer/devcontainer.json — what makes this repo openable as a
    GitHub Codespace on the prebuilt Malloyyo image.
    ghcr.io/malloydata/malloyyo-devcontainer carries the CLI, Claude Code, the
    Malloy and Claude VS Code extensions, Node, Playwright/Chromium and gcloud,
    so a codespace on it is a pull rather than a multi-minute build, and the
    repo needs no per-machine setup at all.

    Copied verbatim from the bundled template (comments and all — the file is
    JSONC and meant to be read and edited), and NEVER over an existing one:
    a repo that has tuned its container, added a feature or pinned a digest
    keeps what it has. That also makes this safe as the container's own
    postCreateCommand, which is where it usually runs from the second time on.

    Exported for the tests. */
export function installDevcontainer(root: string): { wrote: boolean; note: string } {
  const dest = path.join(root, ".devcontainer", "devcontainer.json");
  if (fs.existsSync(dest)) {
    return { wrote: false, note: ".devcontainer/devcontainer.json exists — left as-is" };
  }
  const src = templatePath("devcontainer", "devcontainer.json");
  if (!src) return { wrote: false, note: "no devcontainer template found — skipped" };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return {
    wrote: true,
    note: "wrote .devcontainer/devcontainer.json — commit it, then Code → Codespaces on GitHub",
  };
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

  const repo = scaffoldRepo(root);
  for (const note of repo.notes) console.log(note);

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

  const dev = installDevcontainer(root);
  console.log(`${dev.wrote ? "✓" : "•"} ${dev.note}`);

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
  if (repo.oldLayout) {
    // This repo publishes one dataset from its root, and the flags that address
    // it are the single-dataset ones. `lint` is where converting is explained.
    console.log("  claude              # author mode");
    console.log("  malloyyo lint                        # what this repo publishes");
    console.log("  malloyyo dashboard dev               # see it render");
    console.log("  malloyyo publish --dataset <name>");
    return;
  }
  console.log("  claude              # author mode — ask it to add a dataset");
  console.log("");
  console.log("Once a dataset exists:");
  console.log("  malloyyo lint                        # what this repo publishes");
  console.log("  malloyyo dashboard dev -C datasets/<name>   # see it render");
  console.log("  malloyyo publish --repo <owner/name> --create-datasets");
}
