import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Target {
  name: string;
  url: string;
  dataset: string;
  /** Env var name holding a bearer token, if the config declares one. */
  tokenEnv?: string;
}

/** One entry under the `malloyyo` config block. Only the token env var *name* is committed. */
interface TargetConfig {
  url: string;
  dataset: string;
  malloyyo_token?: { env: string };
}

type TargetMap = Record<string, TargetConfig>;

/** Project-level settings for the published site. */
export interface SiteConfig {
  /** Google Analytics 4 Measurement ID, e.g. G-XXXXXXXXXX. */
  analytics?: string;
}

/**
 * The `malloyyo` block. Every key here is a KNOWN name:
 *
 *   { "malloyyo": {
 *       "analytics": "G-XXXXXXXXXX",
 *       "targets": { "prod": { "url": …, "dataset": … } }
 *   } }
 *
 * The old shape put targets directly at the top level, which made the block an
 * open map: a mistyped setting silently became a publish target, and there was
 * nowhere to put project settings. That shape still works and still warns —
 * see parseMalloyyoConfig.
 */
const KNOWN_KEYS = new Set(["analytics", "targets"]);

/** A target is an object with a string `url`. Only used to tell a legacy
    top-level target apart from a mistyped key, so the warning can say which. */
function isTarget(v: unknown): v is TargetConfig {
  return typeof v === "object" && v !== null && typeof (v as TargetConfig).url === "string";
}

// The config is read by several entry points in one process; warn once each.
const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

function parseMalloyyoConfig(raw: Record<string, unknown>): {
  analytics?: string;
  targets: TargetMap;
} {
  const declared = raw.targets;
  const targets: TargetMap =
    typeof declared === "object" && declared !== null ? { ...(declared as TargetMap) } : {};

  const legacy: string[] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (isTarget(v)) {
      // Accept it, so existing repos keep working.
      if (!(k in targets)) targets[k] = v as TargetConfig;
      legacy.push(k);
    } else {
      unknown.push(k);
    }
  }

  if (legacy.length) {
    warnOnce(
      "legacy-targets",
      `malloy-config.json: publish target(s) ${legacy.map((t) => `"${t}"`).join(", ")} are ` +
        `at the top of the "malloyyo" block. Move them under "targets":\n` +
        `  "malloyyo": { "targets": { ${legacy.map((t) => `"${t}": { … }`).join(", ")} } }\n` +
        `The old shape still works for now.`,
    );
  }
  if (unknown.length) {
    warnOnce(
      "unknown-keys",
      `malloy-config.json: ignoring unknown key(s) in the "malloyyo" block: ` +
        `${unknown.map((k) => `"${k}"`).join(", ")}. ` +
        `Known keys: ${[...KNOWN_KEYS].join(", ")}.`,
    );
  }
  const analytics = raw.analytics;
  return {
    analytics: typeof analytics === "string" && analytics ? analytics : undefined,
    targets,
  };
}

/**
 * Publish targets. Looked for, in order:
 *   1. the `malloyyo` key in malloy-config.json
 *   2. a standalone malloyyo.json (whole file is the block)
 */
function readTargetMap(dir: string): TargetMap {
  const raw = readMalloyyoBlock(dir);
  if (raw) return parseMalloyyoConfig(raw).targets;
  throw new Error(
    `No \`malloyyo\` config found in ${dir} ` +
      `(looked for a "malloyyo" block in malloy-config.json, then malloyyo.json).`,
  );
}

/** The raw `malloyyo` block, or null. Same lookup order as the target map:
    the `malloyyo` key in malloy-config.json, then a standalone malloyyo.json. */
function readMalloyyoBlock(dir: string): Record<string, unknown> | null {
  const malloyConfig = join(dir, "malloy-config.json");
  if (existsSync(malloyConfig)) {
    try {
      const json = JSON.parse(readFileSync(malloyConfig, "utf8"));
      if (json.malloyyo && typeof json.malloyyo === "object") return json.malloyyo;
    } catch {
      /* malformed config — target resolution will report it */
    }
  }
  const standalone = join(dir, "malloyyo.json");
  if (existsSync(standalone)) {
    try {
      return JSON.parse(readFileSync(standalone, "utf8"));
    } catch {
      /* same */
    }
  }
  return null;
}

/** Site settings from the `malloyyo` block. Unlike target resolution this NEVER
    throws: publishing a static site does not require a malloyyo block at all,
    so a missing or malformed config just means no settings. */
export function readSiteConfig(dir: string): SiteConfig {
  const raw = readMalloyyoBlock(dir);
  if (!raw) return {};
  const { analytics } = parseMalloyyoConfig(raw);
  return analytics ? { analytics } : {};
}

const normalizeUrl = (u: string): string => u.replace(/\/+$/, "");

/** Resolve a named target's url/dataset (token is resolved separately — see oauth.ts). */
export function resolveTarget(dir: string, name: string): Target {
  const targets = readTargetMap(dir);
  const cfg = targets[name];
  if (!cfg) {
    const available = Object.keys(targets).join(", ") || "(none defined)";
    throw new Error(`Unknown target "${name}". Available: ${available}`);
  }
  return {
    name,
    url: normalizeUrl(cfg.url),
    dataset: cfg.dataset,
    tokenEnv: cfg.malloyyo_token?.env,
  };
}

/**
 * Resolve an instance to log in/out of. `arg` may be:
 *   - a URL (http/https) — used directly, no config needed
 *   - a named target from the config block — its url is used
 *   - omitted — allowed when the config is unambiguous (one target, or all
 *     targets share a single url)
 * Login is per-instance, so the dataset is irrelevant here.
 */
export function resolveInstance(dir: string, arg?: string): { name: string; url: string } {
  if (arg && /^https?:\/\//i.test(arg)) {
    const url = normalizeUrl(arg);
    return { name: url, url };
  }

  const targets = readTargetMap(dir);
  const entries = Object.entries(targets);

  if (arg) {
    const cfg = targets[arg];
    if (!cfg) {
      const available = entries.map(([n]) => n).join(", ") || "(none defined)";
      throw new Error(`Unknown target "${arg}". Pass a target name, a URL, or one of: ${available}`);
    }
    return { name: arg, url: normalizeUrl(cfg.url) };
  }

  // No arg: only allowed when unambiguous.
  if (entries.length === 0) throw new Error("No targets defined. Pass a target name or a URL.");
  if (entries.length === 1) return { name: entries[0][0], url: normalizeUrl(entries[0][1].url) };
  const urls = new Set(entries.map(([, c]) => normalizeUrl(c.url)));
  if (urls.size === 1) return { name: entries.map(([n]) => n).join("/"), url: [...urls][0] };
  throw new Error(`Multiple targets — specify which: ${entries.map(([n]) => n).join(", ")} (or a URL).`);
}
