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
    url: cfg.url.replace(/\/+$/, ""),
    dataset: cfg.dataset,
    tokenEnv: cfg.malloyyo_token?.env,
  };
}
