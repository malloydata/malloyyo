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

/**
 * Find the `malloyyo` target map. Looked for, in order:
 *   1. the `malloyyo` key in malloy-config.json
 *   2. a standalone malloyyo.json (whole file is the map)
 */
function readTargetMap(dir: string): TargetMap {
  const malloyConfig = join(dir, "malloy-config.json");
  if (existsSync(malloyConfig)) {
    const json = JSON.parse(readFileSync(malloyConfig, "utf8"));
    if (json.malloyyo && typeof json.malloyyo === "object") return json.malloyyo;
  }
  const standalone = join(dir, "malloyyo.json");
  if (existsSync(standalone)) {
    return JSON.parse(readFileSync(standalone, "utf8"));
  }
  throw new Error(
    `No \`malloyyo\` config found in ${dir} ` +
      `(looked for a "malloyyo" block in malloy-config.json, then malloyyo.json).`,
  );
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
