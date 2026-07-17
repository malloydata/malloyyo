// `malloyyo mcp` — the local stdio MCP server, rooted at cwd (or --root),
// serving the EXPLORE (test-window) surface: what a real consumer gets, run
// locally over the model in the current directory. This is the fox's "test"
// window — the same engine `exploreSurface` the hosted /mcp serves, so what
// you test locally is congruent with production.
//
// (A develop surface is intentionally NOT shipped here — the engine can build
// one, but this PR ships explore only.)
//
// This file is the HOST: it owns runtime construction and lifecycle (the
// engine is pure logic over an injected Runtime). Connections live on a
// launch-time MalloyConfig and are IDLED after every call (mirroring
// malloy-cli) so a co-running process can share the same DuckDB files while
// schema caches survive between calls.
//
// stdio discipline: the MCP protocol owns stdout. Never console.log here.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MalloyConfig,
  Runtime,
  discoverConfig,
  type URLReader,
} from "@malloydata/malloy";
import {
  codeProblem,
  compile,
  developSurface,
  exploreSurface,
  gateConfigProblems,
  mapProblems,
  modelCatalogEntry,
  modelGuidanceTopics,
  prepareSource,
  renderInstructions,
  type BoundModel,
  type DevelopHost,
  type ExploreHost,
  type ModelEntry,
  type Problem,
  type SourceInput,
  type ToolSurface,
} from "@malloyyo/mcp-engine";
import { attachSurface } from "@malloyyo/mcp-engine/mcp-sdk";

const ENTRY = "index.malloy";

/**
 * The two local windows, chosen at launch (see `malloyyo mcp --develop/--explore`).
 * The mode is announced in the server NAME (so it lands in every tool prefix,
 * e.g. mcp__malloyyo_author__compile) and reinforced by a short instructions
 * stub. Full authoring guidance lives in yo_help topics, NOT here — the old
 * 18KB DASHBOARD_GUIDANCE blob overran the client's ~2KB instructions cap and
 * got truncated. yo_help is the one channel that never clips.
 */
type Mode = "develop" | "explore";

const MODE_STUB: Record<Mode, string> = {
  develop:
    "\n\n# DEVELOP (author) mode\n" +
    "You can author this Malloy model — compile / compile_file / prettify / query the files " +
    "in this project (any .malloy path; no index.malloy required). For how-to, call yo_help — " +
    "start with `dashboards/authoring`, then `dashboards/grid-layout`, `dashboards/vega-charts`, " +
    "and the `develop/*` topics. To preview exactly what claude.ai web will see, relaunch as " +
    "`malloyyo test`.",
  explore:
    "\n\n# TEST (explore) mode\n" +
    "This mirrors the claude.ai web experience — the same tools a hosted consumer gets, over " +
    "this project's published entry model (index.malloy). Call yo_help for guidance. To author " +
    "the model (compile / edit / dashboards), relaunch as `malloyyo author`.",
};

type WithRuntime = <T>(input: SourceInput, fn: (m: BoundModel) => Promise<T>) => Promise<T>;

/** A loaded config plus any problems it carries (parse/schema/overlay). */
interface LoadedConfig {
  config: MalloyConfig;
  problems: Problem[];
}

function defaultConfig(rootUrl: URL): MalloyConfig {
  return new MalloyConfig({ includeDefaultConnections: true } as never, {
    rootDirectory: rootUrl.toString(),
  });
}

/**
 * Launch-time config via core's own discovery (never replicate it host-side):
 * `discoverConfig` finds `malloy-config.json` (or the not-checked-in
 * `malloy-config-local.json`, which supersedes it) and binds rootDirectory so
 * the test window resolves exactly what the server will. No config → defaults
 * (a bare DuckDB world), mirroring the hosted fallback. Config-file errors come
 * from two channels — a throw from discoverConfig, and `config.log` — and both
 * are surfaced as problems (a silently-dropped config error yields a misleading
 * field-not-found cascade).
 */
async function loadConfig(root: string, reader: URLReader): Promise<LoadedConfig> {
  const rootUrl = url.pathToFileURL(root + path.sep);
  let discovered: MalloyConfig | null;
  try {
    discovered = await discoverConfig(rootUrl, rootUrl, reader);
  } catch (e) {
    return {
      config: defaultConfig(rootUrl),
      problems: [codeProblem("config-validation", e instanceof Error ? e.message : String(e))],
    };
  }
  if (discovered) {
    const log = discovered.log ?? [];
    return { config: discovered, problems: mapProblems([...log]) };
  }
  return { config: defaultConfig(rootUrl), problems: [] };
}

/** The host's base reader: local files only. */
function fsReader(): URLReader {
  return {
    readURL: async (u: URL) => {
      if (u.protocol !== "file:") {
        throw new Error(`unsupported URL scheme for import: ${u.href}`);
      }
      return fs.promises.readFile(u, "utf8");
    },
  };
}

/** Resolve an agent-supplied path/URI against the project root, and keep it
    inside the root — this server serves THIS project, not the disk. */
function resolveUnderRoot(root: string, p: string): string {
  const abs = p.includes("://")
    ? path.resolve(decodeURIComponent(new URL(p).pathname))
    : path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path is outside the project root: ${p}`);
  }
  return abs;
}

/** Live config: re-discover when malloy-config(.local).json changes (one stat
    per file per call) so a fox can edit config mid-session without a restart. */
function makeConfigSource(root: string): () => Promise<LoadedConfig> {
  let cached: { sig: string; loaded: LoadedConfig } | undefined;
  const signature = (): string =>
    ["malloy-config.json", "malloy-config-local.json"]
      .map((name) => {
        try {
          const st = fs.statSync(path.join(root, name));
          return `${name}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${name}:absent`;
        }
      })
      .join("|");
  return async () => {
    const sig = signature();
    if (cached?.sig !== sig) {
      cached = { sig, loaded: await loadConfig(root, fsReader()) };
    }
    return cached.loaded;
  };
}

/** Per-call lease: resolve input → runtime over the current config → fn →
    idle connections (schema caches survive; file locks release). */
function makeWithRuntime(root: string, currentConfig: () => Promise<LoadedConfig>): WithRuntime {
  return async function withRuntime<T>(
    input: SourceInput,
    fn: (m: BoundModel) => Promise<T>,
  ): Promise<T> {
    const { config, problems } = await currentConfig();
    return gateConfigProblems(problems, async () => {
      const resolved: SourceInput =
        "url" in input
          ? { url: resolveUnderRoot(root, input.url) }
          : {
              source: input.source,
              baseUrl: input.baseUrl ? resolveUnderRoot(root, input.baseUrl) : root + path.sep,
            };
      const { reader, entry, readSource } = prepareSource(fsReader(), resolved);
      const runtime = new Runtime({ config, urlReader: reader });
      try {
        return await fn({ runtime, entry, readSource });
      } finally {
        await config.shutdown("idle");
      }
    });
  };
}

/**
 * The test window's catalog: exactly what a production user would see — the
 * published entry point (index.malloy), nothing else. `list` compiles the entry
 * once to surface its exported sources + named queries (so a bare source name
 * resolves); `withModel` binds the entry. Uniform refusal message.
 */
function makeExploreHost(root: string, currentConfig: () => Promise<LoadedConfig>): ExploreHost {
  const withRuntime = makeWithRuntime(root, currentConfig);
  const published = (ref: string): boolean =>
    ref === ENTRY && fs.existsSync(path.join(root, ENTRY));
  return {
    withModel: (ref, fn) => {
      if (!published(ref)) throw new Error(`no published model '${ref}'`);
      return withRuntime({ url: ENTRY }, fn);
    },
    list: async () => {
      if (!published(ENTRY)) return { entries: [] };
      const entry = await withRuntime({ url: ENTRY }, async (m): Promise<ModelEntry> => {
        const compiled = await compile(m.runtime, m.entry, { exportedOnly: true });
        // The catalog SHAPE is the engine's; the host only supplies a compiled
        // model. Same projection the hosted host uses → no drift.
        return compiled.ok && compiled.model
          ? modelCatalogEntry(ENTRY, compiled.model)
          : { model_ref: ENTRY };
      });
      return { entries: [entry] };
    },
  };
}

/** The authoring host: lease a runtime over ANY .malloy path or inline text
    (no index.malloy gate) — makeWithRuntime already IS DevelopHost.withRuntime. */
function makeDevelopHost(root: string, currentConfig: () => Promise<LoadedConfig>): DevelopHost {
  return { withRuntime: makeWithRuntime(root, currentConfig) };
}

/** The model's own guidance topics (guidance/**\/*.md under root) — read once at
    launch, the same files `publish` ships, so the local test window serves the
    guidance a hosted consumer will get. No namespace: one model here. */
function readGuidance(root: string): ReturnType<typeof modelGuidanceTopics> {
  const base = path.join(root, "guidance");
  const files: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        files.push([rel, fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(base);
  return modelGuidanceTopics(files);
}

export async function serveMcp(opts: {
  root?: string;
  version: string;
  mode?: Mode;
}): Promise<void> {
  // Registers every current connection type. Dynamic so the other CLI commands
  // never load native DB backends; MUST complete before any MalloyConfig is
  // built (the registry feeds includeDefaultConnections).
  await import("@malloydata/malloy-connections");
  const root = path.resolve(opts.root ?? process.cwd());
  const mode: Mode = opts.mode ?? "explore";
  const currentConfig = makeConfigSource(root);
  const surface: ToolSurface =
    mode === "develop"
      ? developSurface(makeDevelopHost(root, currentConfig))
      : exploreSurface(makeExploreHost(root, currentConfig), { guidance: readGuidance(root) });
  // The local window has no env.INSTANCE_NAME; honor one if set so a fox can
  // preview a specific instance's name, else fall back to the product name.
  const instanceName = process.env.INSTANCE_NAME || "Malloyyo";
  // Server name encodes the mode — it becomes the mcp__<name>__ tool prefix, an
  // un-truncatable, always-visible mode announcement.
  const serverName = mode === "develop" ? "malloyyo-develop" : "malloyyo-explore";
  const server = new McpServer(
    { name: serverName, version: opts.version },
    {
      instructions: renderInstructions(surface.instructions, instanceName) + MODE_STUB[mode],
      capabilities: { tools: {}, prompts: {}, resources: {} },
    },
  );
  attachSurface(server, surface, { registerSkillsAsPrompts: true });
  await server.connect(new StdioServerTransport());
  // Stdio server: stay alive until the client closes the transport.
  await new Promise<void>((resolveDone) => {
    server.server.onclose = () => resolveDone();
  });
  await (await currentConfig()).config.shutdown("close").catch(() => {});
}
