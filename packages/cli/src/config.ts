import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** An instance and how to authenticate to it — what every target has, whatever it publishes. */
export interface Endpoint {
  name: string;
  url: string;
  /** Env var name holding a bearer token, if the config declares one. */
  tokenEnv?: string;
}

/** A target that addresses one dataset: a single-dataset repo, `status`, `draft`. */
export interface Target extends Endpoint {
  dataset: string;
}

/** A target that addresses a repo with a `datasets/` directory, published as one unit. */
export interface RepoTarget extends Endpoint {
  /** GitHub `owner/name` — what the server matches the push against (findRepoForPublish). */
  repo: string;
}

/**
 * One entry under the `malloyyo` config block. Only the token env var *name* is committed.
 *
 * `dataset` and `repo` are the two things a target can publish, and the repo's layout
 * decides which it needs: `dataset` for an `index.malloy` at the root, `repo` for a
 * `datasets/` directory. A target names one of them, not both — nothing would read both,
 * and a key the CLI silently ignores is how a target ends up publishing somewhere else.
 */
interface TargetConfig {
  url: string;
  dataset?: string;
  repo?: string;
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
 *       "image_hosts": ["image.tmdb.org"],
 *       "targets": {
 *         "prod": { "url": …, "dataset": … },          // index.malloy at the repo root
 *         "all":  { "url": …, "repo": "owner/name" }   // a datasets/ directory
 *       }
 *   } }
 *
 * `image_hosts` is read by the SERVER, not by this file: it widens the dashboard
 * frame's `img-src` so a dashboard can show remote images. Listed here only so the
 * unknown-key warning below doesn't fire on a legitimate setting.
 *
 * The old shape put targets directly at the top level, which made the block an
 * open map: a mistyped setting silently became a publish target, and there was
 * nowhere to put project settings. That shape still works and still warns —
 * see parseMalloyyoConfig.
 */
const KNOWN_KEYS = new Set(["analytics", "targets", "image_hosts"]);

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
/**
 * The shape to add, shown with every "there is no config" error.
 *
 * Nothing in this toolchain writes `malloy-config.json` — it is the author's file, and
 * the CLI and the MCP tools only ever read it — so a missing block is something only
 * they can add. That makes this the first error a new user is likely to meet, and the
 * one that most needs to carry its own fix rather than only its diagnosis.
 */
const TARGETS_BLOCK_EXAMPLE =
  '  "malloyyo": {\n' +
  '    "targets": { "prod": { "url": "https://<instance>", "dataset": "<dataset>" } }\n' +
  "  }\n" +
  "For a repo with a datasets/ directory, the target names the repo instead:\n" +
  '    "targets": { "prod": { "url": "https://<instance>", "repo": "<owner/name>" } }';

/** `orFlags` is a command line that needs no config, appended where the config has nothing. */
function readTargetMap(dir: string, orFlags = ""): TargetMap {
  const raw = readMalloyyoBlock(dir);
  if (raw) return parseMalloyyoConfig(raw).targets;
  throw new Error(
    `No \`malloyyo\` config found in ${dir} ` +
      `(looked for a "malloyyo" block in malloy-config.json, then malloyyo.json).\n` +
      `Add one to malloy-config.json:\n${TARGETS_BLOCK_EXAMPLE}${orFlags}`,
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

/**
 * A target's url, or a message saying where to put one.
 *
 * `url` is required, but nothing validates malloy-config.json on the way in, so a target
 * written without one used to reach normalizeUrl as undefined and fail with
 * "Cannot read properties of undefined (reading 'replace')" — a stack-shaped error for a
 * one-line config mistake. It also now has a second fix worth naming: the instance can
 * come from the command line instead of the file.
 */
function targetUrl(name: string, cfg: TargetConfig): string {
  if (typeof cfg.url !== "string" || cfg.url === "") {
    throw new Error(
      `Target "${name}" has no "url" in malloy-config.json. Add one:\n` +
        `  "malloyyo": { "targets": { "${name}": { "url": "https://<instance>", "dataset": "<dataset>" } } }\n` +
        `Or name the instance on the command line:  malloyyo publish -i https://<instance>`,
    );
  }
  return normalizeUrl(cfg.url);
}

/**
 * Resolve a named target's url/dataset (token is resolved separately — see oauth.ts).
 *
 * `name` may be omitted when the repo defines exactly one target, matching what `login`
 * has always accepted — and what `cloud instance create` now tells people to run.
 * Unlike login's rule, several targets sharing one URL is still ambiguous here: login
 * needs only the instance, while publishing also needs the dataset, and two targets on
 * one instance are precisely two different datasets.
 */
export function resolveTarget(dir: string, name?: string): Target {
  const t = readTarget(dir, name);
  return { name: t.name, url: t.url, dataset: datasetOf(t), tokenEnv: t.tokenEnv };
}

/** A configured target before anyone has asked what it publishes. */
type ConfiguredTarget = Endpoint & { dataset?: string; repo?: string };

/** The named (or sole) target, with whichever of `dataset`/`repo` it declares. */
function readTarget(dir: string, name?: string, orFlags = ""): ConfiguredTarget {
  const targets = readTargetMap(dir, orFlags);
  const entries = Object.entries(targets);

  if (name === undefined) {
    if (entries.length === 0) {
      // The one error a new customer is most likely to meet, so it carries the fix
      // rather than the diagnosis: nothing in this toolchain writes malloy-config.json,
      // so a missing block is something only they can add.
      throw new Error(
        `No publish targets defined. Add one to malloy-config.json:\n${TARGETS_BLOCK_EXAMPLE}${orFlags}`,
      );
    }
    if (entries.length > 1) {
      throw new Error(`Multiple targets — specify which: ${entries.map(([n]) => n).join(", ")}.`);
    }
    const [onlyName, onlyCfg] = entries[0];
    return configured(onlyName, onlyCfg);
  }

  const cfg = targets[name];
  if (!cfg) {
    const available = Object.keys(targets).join(", ") || "(none defined)";
    throw new Error(`Unknown target "${name}". Available: ${available}`);
  }
  return configured(name, cfg);
}

function configured(name: string, cfg: TargetConfig): ConfiguredTarget {
  // A non-string value (`"repo": true`, a number) reads as absent, so it gets the
  // "add one" error below rather than reaching a URL or a request body as-is.
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    name,
    url: targetUrl(name, cfg),
    dataset: str(cfg.dataset),
    repo: str(cfg.repo),
    tokenEnv: cfg.malloyyo_token?.env,
  };
}

/**
 * The dataset a target addresses, or an error that says what to write instead.
 *
 * Before targets could name a repo, a target missing its dataset reached the request as
 * `undefined` — `/api/datasets/undefined/model/push` — and the server's 404 said nothing
 * about the config. A target that names a repo is now the likely way to get here: written
 * for a `datasets/` repo, then used by something that addresses one dataset.
 */
function datasetOf(t: ConfiguredTarget, opts: { flag?: boolean } = {}): string {
  const shape = `  "${t.name}": { "url": "${t.url}", "dataset": "<dataset>" }`;
  // `status` has no --dataset to offer; `publish` and `draft` do.
  const orFlag = opts.flag ? `\nOr name it on the command line:  --dataset <dataset>` : "";
  if (t.dataset !== undefined && t.repo !== undefined) throw bothKeys(t, "dataset");
  if (t.dataset !== undefined) return t.dataset;
  if (t.repo !== undefined) {
    throw new Error(
      `Target "${t.name}" names a repo ("${t.repo}"), but this command addresses a single dataset, ` +
        `so "repo" has nothing to name.\n` +
        `Use "dataset" instead:\n${shape}${orFlag}`,
    );
  }
  throw new Error(
    `Target "${t.name}" has no "dataset" in malloy-config.json. Add one:\n${shape}${orFlag}`,
  );
}

/** The repo a target addresses — the `datasets/` counterpart of datasetOf. */
function repoOf(t: ConfiguredTarget): string {
  const shape = (value: string) => `  "${t.name}": { "url": "${t.url}", "repo": "${value}" }`;
  if (t.dataset !== undefined && t.repo !== undefined) throw bothKeys(t, "repo");
  if (t.repo !== undefined) return t.repo;
  if (t.dataset !== undefined) {
    throw new Error(
      `Target "${t.name}" names a dataset ("${t.dataset}"), but this repo has a datasets/ ` +
        `directory and publishes all of them as one unit, so "dataset" cannot say which.\n` +
        `Use "repo" instead:\n${shape("<owner/name>")}\n` +
        `Or name it on the command line:  malloyyo publish --repo <owner/name>`,
    );
  }
  throw missingRepo(t.name, t.url);
}

function missingRepo(name: string, url: string): Error {
  return new Error(
    `This repo has a datasets/ directory and publishes as one unit, so its target names the ` +
      `repo, and target "${name}" has no "repo". Add one to malloy-config.json:\n` +
      `  "${name}": { "url": "${url}", "repo": "<owner/name>" }\n` +
      `Or name it on the command line:  malloyyo publish --repo <owner/name>`,
  );
}

/** A target naming both keys. Only one is ever read, so the other would be silently
    ignored — exactly what `repo` was added to stop happening to `dataset`. */
function bothKeys(t: ConfiguredTarget, wanted: "dataset" | "repo"): Error {
  const other = wanted === "dataset" ? "repo" : "dataset";
  return new Error(
    `Target "${t.name}" names both a "dataset" and a "repo"; a target publishes one or the other.\n` +
      `This needs "${wanted}" — remove "${other}" from the target (or give it a target of its own).`,
  );
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
    return { name: arg, url: targetUrl(arg, cfg) };
  }

  // No arg: only allowed when unambiguous.
  if (entries.length === 0) throw new Error("No targets defined. Pass a target name or a URL.");
  if (entries.length === 1) return { name: entries[0][0], url: targetUrl(entries[0][0], entries[0][1]) };
  const urls = new Set(entries.map(([n, c]) => targetUrl(n, c)));
  if (urls.size === 1) return { name: entries.map(([n]) => n).join("/"), url: [...urls][0] };
  throw new Error(`Multiple targets — specify which: ${entries.map(([n]) => n).join(", ")} (or a URL).`);
}

/**
 * The target `publish` will push to: the config's, with `--instance`/`--dataset` on top.
 *
 * A target is two independent facts — WHICH instance and WHICH dataset — so each is
 * overridable on its own, and supplying BOTH skips the config entirely. That last case is
 * the point of the flags: publishing a repo to an instance it has no target for (a fresh
 * `cloud instance create`, a colleague's instance, a one-off) previously meant editing
 * malloy-config.json, which is the author's committed file and usually not what they want
 * to change to run one command.
 *
 *   malloyyo publish -i https://gravity.malloyyo.com --dataset movies --create-dataset
 *
 * `--instance` takes the same argument `login` does — a URL, used as-is with no config
 * read, or the name of a configured target, whose url is borrowed.
 */
export function resolvePublishTarget(
  dir: string,
  name?: string,
  overrides: { instance?: string; dataset?: string } = {},
): Target {
  const { endpoint, value } = overridden(dir, name, overrides.instance, overrides.dataset, (t) =>
    datasetOf(t, { flag: true }),
  );
  return { ...endpoint, dataset: value };
}

/**
 * The target a `datasets/` repo publishes to: resolvePublishTarget with `repo` in the
 * place of `dataset`, and the same rules — `--repo` overrides the target's `repo`,
 * `--instance` its url, and both together never open the config.
 *
 *   malloyyo publish -i https://gravity.malloyyo.com --repo acme/models --create-datasets
 *
 * Its own function, not resolvePublishTarget with the repo passed as the dataset: that
 * is how `--repo` worked at first, and it meant a target could not say which repo, and a
 * `dataset` written in the target was silently dropped.
 */
export function resolveRepoTarget(
  dir: string,
  name?: string,
  overrides: { instance?: string; repo?: string } = {},
): RepoTarget {
  // Where the config has no target at all, the flags are as good a fix as adding one —
  // and for a repo that has never published, usually the quicker one.
  const orFlags =
    "\nOr skip the config:  malloyyo publish -i https://<instance> --repo <owner/name>";
  const { endpoint, value } = overridden(
    dir,
    name,
    overrides.instance,
    overrides.repo,
    repoOf,
    orFlags,
  );
  return { ...endpoint, repo: value };
}

/**
 * A target's two halves — WHICH instance, and WHAT on it (a dataset or a repo) — each
 * overridable on its own. `pick` reads the second half from the config, and runs only
 * when no flag supplied it.
 */
function overridden(
  dir: string,
  name: string | undefined,
  instance: string | undefined,
  flagValue: string | undefined,
  pick: (t: ConfiguredTarget) => string,
  orFlags = "",
): { endpoint: Endpoint; value: string } {
  // Fully specified, and no target named: nothing to read. This is the shape that works
  // in a repo whose malloy-config.json has no `malloyyo` block at all.
  if (instance !== undefined && flagValue !== undefined && name === undefined) {
    const resolved = resolveInstance(dir, instance);
    return { endpoint: { name: resolved.name, url: resolved.url }, value: flagValue };
  }

  const base = readTarget(dir, name, orFlags);
  const value = flagValue ?? pick(base);
  if (instance === undefined) {
    return { endpoint: { name: base.name, url: base.url, tokenEnv: base.tokenEnv }, value };
  }

  const resolved = resolveInstance(dir, instance);
  return {
    endpoint: { name: resolved.name, url: resolved.url },
    // tokenEnv is deliberately NOT carried over. It names a credential for the
    // CONFIGURED instance, and this is a different one — sending that token to another
    // host is both wrong and a leak. Falling through to --token or the stored login for
    // the new URL is the safe default.
    value,
  };
}
