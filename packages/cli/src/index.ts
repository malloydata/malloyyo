#!/usr/bin/env node
import { Command } from "commander";
import { resolve, relative, sep } from "node:path";
import { resolveTarget, resolveInstance, resolvePublishTarget, type Target } from "./config.js";
import { gatherDirectory, gatherDashboards, gitArchiveZip, gitInfo } from "./gather.js";
import { layoutFromListing } from "@malloyyo/mcp-engine";
import { fsLister, repoRootOf } from "./repo.js";
import {
  OLD_LAYOUT_NOTICE,
  lintDashboards,
  lintRepo,
  printLintReport,
  printRepoLintReport,
} from "./lint.js";
import { missingEnvRefs, missingEnvHint } from "./shared/env-refs.js";
import {
  getAccessToken,
  login,
  looksLikeInstanceToken,
  tokenSource,
  TOKEN_ENV,
  type TokenSource,
} from "./oauth.js";
import { apiFetch } from "./http.js";
import { serveMcp } from "./mcp.js";
import { serveDashboard } from "./dashboard.js";
import { bundleDashboards } from "./bundle.js";
import { initCmd } from "./init.js";
import { sqlCmd } from "./sql.js";
import { launchCmd } from "./launch.js";
import { clearCreds } from "./store.js";
import { draftList, draftPromote, loginWithToken } from "./draft.js";
import { registerCloudCommands } from "./cloud/index.js";
import type { PublishRequest, ModelStatus } from "./protocol.js";
// Single source of truth: the build runs after the release bump, so esbuild
// inlines the current package.json version (tree-shaken to just the string).
// Feeds both `malloyyo --version` and the MCP server's serverInfo.version.
import { version as VERSION } from "../package.json";

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "";
}

/**
 * Extra advice for a 401/403 from the server. The target resolved and the
 * request got through — it's the CREDENTIAL that's wrong — so point at the
 * thing that produced it rather than leaving "invalid or revoked token" as the
 * whole message.
 */
function authHint(
  status: number,
  t: Target,
  source: TokenSource,
  /** The value used didn't look like a minted instance token — likely the wrong secret. */
  foreignValue = false,
): string {
  const login = `malloyyo login ${t.name}`;
  const mint = `${t.url}/settings/tokens`;
  if (status === 403) {
    // The server's own message says which of these it was; this says where the
    // fix lives. Both halves matter: a token can be perfectly valid and still
    // lack the scope, or belong to someone who doesn't own the dataset.
    const why =
      `\n  The credential is valid, but it isn't allowed to do this on ${t.url}.` +
      `\n  The model surface needs the "publish" scope, on an account that owns the` +
      `\n  dataset (or is an admin there).`;
    // A saved login from before `login` asked for publishing carries "mcp"
    // alone, and no token page fixes that — signing in again does.
    return source === "login"
      ? why + `\n  A login stored before that scope existed carries only "mcp". Run:  ${login}`
      : why + `\n  Mint a token carrying it at:  ${mint}`;
  }
  const wrongSecret = foreignValue
    ? `\n  (that value isn't shaped like a Malloyyo token — is the variable still` +
      `\n  set to something else, like a warehouse password?)`
    : "";
  switch (source) {
    case "flag":
      return `\n  That token came from --token. Mint one at ${mint}, or run:  ${login}${wrongSecret}`;
    case "env":
      return `\n  That token came from $${t.tokenEnv}. Mint a replacement at ${mint},` +
        `\n  or unset it and run:  ${login}${wrongSecret}`;
    case "global-env":
      return `\n  That token came from $${TOKEN_ENV}. It may be revoked, or minted for a` +
        `\n  different instance. Mint one for ${t.url} at:  ${mint}` +
        `\n  Or unset the variable and run:  ${login}${wrongSecret}`;
    default:
      return `\n  Your saved login for ${t.url} is expired or revoked.\n  Run:  ${login}`;
  }
}

/**
 * What to DO about a rejected push, by the server's `kind`. The server's own
 * message says what went wrong; this says where to fix it, since the same
 * Malloy error means something different depending on whether a file didn't
 * upload, a secret isn't set on that deployment, or the model is just wrong.
 */
function failureHint(out: ModelStatus, t: Target): string {
  switch (out.kind) {
    case "missing-import":
      return `\n  A file the model imports wasn't in the upload. Publish from the directory` +
        `\n  that holds index.malloy, and check the import path's spelling/case.`;
    case "connection":
      if (out.missingEnv?.length) {
        const vars = out.missingEnv.map((v) => `$${v}`).join(", ");
        return `\n  malloy-config.json references ${vars}, which ${out.missingEnv.length > 1 ? "are" : "is"} NOT set on ${t.url}.` +
          `\n  Secrets don't travel with the model — set them in that deployment's environment` +
          `\n  (Vercel: Settings → Environment Variables), then publish again.`;
      }
      return `\n  The server couldn't open the connection the model uses. Check the` +
        `\n  \`connections\` block in malloy-config.json, and that ${t.url} can reach it.`;
    case "persist":
      return `\n  The model itself is fine — this failed writing to the server's database.` +
        `\n  Retry; if it repeats, the message above is the database's own.`;
    default:
      return "";
  }
}

/** Message for a failed publish/status response, with advice about what to fix. */
function requestFailed(
  what: string,
  res: Response,
  out: ModelStatus,
  t: Target,
  source: TokenSource,
  bearer?: string,
): Error {
  const detail = out.error ?? `${res.status} ${res.statusText}`;
  // Only worth saying for a value that came from the environment: a token
  // typed after --token, or one stored by `login`, is not of that shape either
  // and saying so would be noise.
  const foreign =
    (source === "env" || source === "global-env") && !!bearer && !looksLikeInstanceToken(bearer);
  const hint =
    res.status === 401 || res.status === 403
      ? authHint(res.status, t, source, foreign)
      : failureHint(out, t);
  return new Error(`${what} failed: ${detail}${hint}`);
}

/**
 * Named after the flags it explains, since `--instance`/`--dataset` are the part of this
 * command that isn't guessable from the argument list alone.
 */
const PUBLISH_HELP = `One dataset, or several:
  The repo's shape decides, so you don't declare it:

    index.malloy                    one dataset
    dashboards/                     publish --dataset movies
                                    --create-dataset to make it

    datasets/finance/index.malloy   one dataset per directory
    datasets/sales/index.malloy     publish --repo owner/name
    malloy-config.json              --create-datasets to make them

  Use the wrong flag for your layout and the error says which to use.

  A repo publishes as a unit: every dataset is linted, and the server writes
  all of them or none. \`malloyyo lint\` shows what yours publishes.

Target resolution:
  The instance and dataset normally come from the \`malloyyo\` block in
  malloy-config.json. Either can be overridden, and giving BOTH means the
  config is never read — so a repo with no targets (or none for this
  instance) can be published without editing its committed config:

    malloyyo publish -i https://gravity.malloyyo.com --dataset movies --create-dataset

  -i takes what \`login\` takes: a URL, or the name of a configured target
  whose url should be borrowed. Authenticate the same way as always:
  \`malloyyo login <url>\`, or set \$MALLOYYO_TOKEN (mint one at
  <url>/settings/tokens — that is what CI wants), or pass --token.`;

type PublishRepoOptions = {
  token?: string;
  dryRun?: boolean;
  skipLint?: boolean;
  createDatasets?: boolean;
  repo?: string;
  instance?: string;
};

/**
 * Publish a multi-dataset repo — every dataset in it, as one unit.
 *
 * The repo is packed into the same archive GitHub hands the server for a repo it
 * pulls, so there is one ingestion path on the other side rather than a
 * GitHub-shaped one and a CLI-shaped one that agree until they do not. The
 * server compiles all of them and writes them in one transaction, or writes
 * none: a repo that half-lands leaves an instance that looks complete and is
 * missing the dataset nobody checks.
 */
async function publishRepo(
  root: string,
  datasetNames: string[],
  target: string | undefined,
  opts: PublishRepoOptions,
): Promise<void> {
  const t = resolvePublishTarget(root, target, { instance: opts.instance, dataset: opts.repo });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });

  if (!opts.skipLint) {
    // The whole repo, so a broken dashboard in ANY dataset stops the publish.
    const linted = await lintRepo(root);
    console.log("dashboards:");
    printRepoLintReport(linted);
    if (!linted.ok) {
      throw new Error(
        "dashboard lint failed — fix the above, or pass --skip-lint" +
          missingEnvHint(missingEnvRefs(gatherDirectory(root).config), "this shell"),
      );
    }
  }

  // What is in the repo is what GIT says is in the repo — not what a directory
  // walk with a skip list decides. That walk silently dropped a dataset whose
  // directory was called `docs/`, and uploaded the gitignored
  // `malloy-config-local.json` where the real credentials live. Both stop being
  // possible here rather than being patched one at a time.
  const { zip: archive, fileCount } = gitArchiveZip(root);
  if (fileCount === 0) throw new Error(`${root} has no files git tracks — nothing to publish`);

  const git = gitInfo(root);
  const provenance = git.sha
    ? `${git.branch}@${shortSha(git.sha)}${git.dirty ? " (dirty)" : ""}`
    : "(no git)";
  console.log(`→ ${t.url}  repo=${opts.repo}${opts.createDatasets ? " (create missing)" : ""}`);
  console.log(`  ${datasetNames.length} dataset(s): ${datasetNames.join(", ")}`);
  console.log(`  ${fileCount} file(s), ${(archive.length / 1024).toFixed(0)}KB archive  ${provenance}`);

  if (opts.dryRun) {
    console.log("dry run — not sending");
    return;
  }

  const res = await apiFetch(`${t.url}/api/repos/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      repo: opts.repo,
      branch: git.branch ?? "main",
      archive: archive.toString("base64"),
      createDatasets: opts.createDatasets ?? false,
      git,
    }),
  });
  const out = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    datasets?: { name: string; version: number; created?: boolean }[];
  } | null;

  if (!res.ok || !out?.ok) {
    throw new Error(out?.error ?? `publish failed (${res.status})`);
  }
  for (const d of out.datasets ?? []) {
    console.log(`  ✓ ${d.name}  v${d.version}${d.created ? "  (created)" : ""}`);
  }
  console.log(`published ${out.datasets?.length ?? 0} dataset(s) to ${t.url}`);
}

async function publish(
  target: string | undefined,
  dir: string,
  opts: {
    token?: string;
    dryRun?: boolean;
    skipLint?: boolean;
    createDataset?: boolean;
    createDatasets?: boolean;
    repo?: string;
    instance?: string;
    dataset?: string;
  },
): Promise<void> {
  const root = resolve(dir);

  // A URL typed where a target NAME goes. It is the obvious thing to type and
  // the obvious intent, and failing it with `Unknown target "http://…"` sends
  // someone looking for a config problem they do not have. `-i` is the flag
  // that takes a URL, so put it there.
  if (target && /^https?:\/\//i.test(target)) {
    opts = { ...opts, instance: opts.instance ?? target };
    target = undefined;
  }

  // Which shape is this repo? The answer decides which flags mean anything, so
  // it is read from the repo rather than from what the caller typed — a repo
  // that grew a `datasets/` directory should say so, not publish its root.
  //
  // A LISTING, not a lint: the lint compiles every dataset, and `--skip-lint`
  // exists to not pay for that. Reading the layout through `lintRepo` here made
  // the flag suppress only the printing.
  const layout = await layoutFromListing(fsLister(root), root);
  if (!layout.ok) throw new Error(layout.error);
  // Two separate questions: which flags this layout accepts, and whether to nag
  // about converting. A dataset directory pointed at directly reads as the
  // single-dataset shape, and its repo is already converted.
  const oldLayout = layout.kind === "single" && repoRootOf(root) === root;

  if (layout.kind !== "single") {
    const names = layout.datasets.map((d) => d.name);
    if (opts.dataset) {
      throw new Error(
        `${root} publishes ${names.length} datasets (${names.join(", ")}), so --dataset cannot say which.\n` +
          `Publish the repo instead:  malloyyo publish --repo <owner/name>` +
          (opts.createDataset ? " --create-datasets" : ""),
      );
    }
    if (!opts.repo) {
      throw new Error(
        `${root} publishes ${names.length} datasets, and a repo is published as one unit.\n` +
          `Name it:  malloyyo publish --repo <owner/name>`,
      );
    }
    return publishRepo(root, names, target, opts as PublishRepoOptions);
  }
  // FIRST, because this one is about WHERE you are standing and the next is about
  // which flag you typed. The other order made the two refusals a loop: pointed
  // at a dataset directory, `--repo` was refused with "use --dataset", and
  // `--dataset` was refused with "publish the repo instead".
  //
  // A dataset of a repo is not independently publishable, and allowing it fails
  // in the worst available shape: the model compiles here, because the config
  // search walks up to the repo's `malloy-config.json` — but only the files UNDER
  // this directory are uploaded, so the server receives a model with no
  // connections at all. Lint passes, publish ships something broken.
  const repoRoot = repoRootOf(root);
  if (repoRoot !== root) {
    const rel = relative(repoRoot, root).split(sep).join("/");
    throw new Error(
      `${rel} is one dataset of the repo above it, and a repo publishes as one unit.\n` +
        `Publish the repo:  cd ${repoRoot} && malloyyo publish --repo <owner/name>`,
    );
  }
  if (opts.repo) {
    throw new Error(
      `${root} publishes a single dataset (index.malloy at its root), so --repo has nothing to name.\n` +
        `Use --dataset <name>.`,
    );
  }
  if (opts.createDatasets) {
    throw new Error("--create-datasets is for a repo with a datasets/ directory; use --create-dataset.");
  }

  const t = resolvePublishTarget(root, target, {
    instance: opts.instance,
    dataset: opts.dataset,
  });
  // Transitional — see OLD_LAYOUT_NOTICE. AFTER the target resolves: printing
  // it first buried the actual error under five lines of layout advice.
  if (oldLayout) console.log(`\n${OLD_LAYOUT_NOTICE}\n`);

  const source = tokenSource(t, { tokenFlag: opts.token });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });

  const { files, config } = gatherDirectory(root);
  if (files.length === 0) {
    throw new Error(`No .malloy files found under ${root}`);
  }

  // Lint dashboards before sending — a broken dashboard shouldn't reach the server.
  if (!opts.skipLint) {
    const report = await lintDashboards(root, { repoRoot: repoRootOf(root) });
    if (report.dashboards.length > 0) {
      console.log("dashboards:");
      printLintReport(report);
    }
    if (!report.ok) {
      // A lint failure whose real cause is an unset secret reads as an
      // inexplicable connection error — name the variable.
      throw new Error(
        "dashboard lint failed — fix the above, or pass --skip-lint" +
          missingEnvHint(missingEnvRefs(config), "this shell"),
      );
    }
  }

  const git = gitInfo(root);
  const dashboards = await gatherDashboards(root);
  const body: PublishRequest = { files, config, git, dashboards };

  const provenance = git.sha
    ? `${git.branch}@${shortSha(git.sha)}${git.dirty ? " (dirty)" : ""}`
    : "(no git)";
  console.log(`→ ${t.url}  dataset=${t.dataset}${opts.createDataset ? " (create if missing)" : ""}`);
  console.log(`  ${files.length} file(s)  ${provenance}`);

  if (opts.dryRun) {
    console.log("dry run — not sending");
    return;
  }

  // ?create=1 makes the server create the dataset when it doesn't exist yet — but
  // only after the model compiles, so a failed publish still creates nothing.
  const push = `${t.url}/api/datasets/${t.dataset}/model/push${opts.createDataset ? "?create=1" : ""}`;
  const res = await apiFetch(push, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as ModelStatus;

  if (!res.ok || !out.ok) {
    throw requestFailed("publish", res, out, t, source, bearer);
  }
  if (out.created) {
    console.log(`✓ created dataset ${out.dataset ?? t.dataset} (private) — ${t.url}/datasets/${out.dataset ?? t.dataset}`);
  }
  console.log(
    `✓ published version ${out.version} — ${out.sources?.length ?? 0} source(s)` +
      (dashboards.length ? `, ${dashboards.length} dashboard(s)` : "") +
      (out.requiredGivens?.length ? `, scoped by ${out.requiredGivens.join(", ")}` : ""),
  );
  if (out.declaredButUnused?.length) {
    const many = out.declaredButUnused.length > 1;
    console.log(
      `  ↳ this model declares ${out.declaredButUnused.join(", ")}, which this dataset is NOT ` +
        `scoped by. Nothing supplies ${many ? "them" : "it"}, so ${many ? "those filters" : "that filter"} ` +
        `will use the declaration default. An admin ticks ${many ? "them" : "it"} on the dataset.`,
    );
  }
}

async function status(target: string | undefined, opts: { token?: string }): Promise<void> {
  const t = resolveTarget(resolve("."), target);
  const source = tokenSource(t, { tokenFlag: opts.token });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });
  const res = await apiFetch(`${t.url}/api/datasets/${t.dataset}/model/status`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    // Same treatment as publish: read the server's own message, and say what to
    // do about a bad credential instead of just printing "401 Unauthorized".
    const body = (await res.json().catch(() => ({}))) as ModelStatus;
    throw requestFailed("status", res, body, t, source, bearer);
  }
  const s = (await res.json()) as ModelStatus;
  const git = s.git;
  console.log(`${t.name}: ${t.url}  dataset=${t.dataset}`);
  console.log(`  version ${s.version ?? "?"}` + (git?.sha ? `  ${git.branch}@${shortSha(git.sha)}` : ""));
  console.log(`  ${s.compileError ? `✗ ${s.compileError}` : `✓ compiled ${s.compiledAt ?? ""}`}`);
}

async function loginCmd(
  target: string | undefined,
  opts: { browser?: boolean; tokenStdin?: boolean },
): Promise<void> {
  const inst = resolveInstance(resolve("."), target);
  if (opts.tokenStdin) return loginWithToken(inst.url);
  // commander maps `--no-browser` to browser:false, defaulting to true.
  await login(inst.url, { noBrowser: opts.browser === false });
  console.log(`✓ logged in to ${inst.name} (${inst.url})`);
}

async function logoutCmd(target: string | undefined): Promise<void> {
  const inst = resolveInstance(resolve("."), target);
  console.log(clearCreds(inst.url) ? `✓ logged out of ${inst.url}` : `not logged in to ${inst.url}`);
}

const program = new Command();
program
  .name("malloyyo")
  .description("Publish Malloy models to a Malloyyo instance")
  .version(VERSION);

program
  .command("login")
  .argument("[target]", "target name or instance URL (optional if the config has one target)")
  .option("--no-browser", "print the sign-in URL instead of launching a browser")
  .option("--token-stdin", "store a token read from stdin (checked against the instance first)")
  .description("sign in to an instance in your browser (stores a token)")
  .action(loginCmd);

const draft = program
  .command("draft")
  .description("draft dashboards made on an instance, before they live in the model repo");

draft
  .command("list")
  .argument("[dir]", "model directory", ".")
  .option("-i, --instance <instance>", "instance URL, or a configured target name")
  .option("--dataset <dataset>", "dataset whose drafts to list; overrides the config")
  .option("--token <token>", "bearer token (overrides login/env)")
  .description("list your drafts on an instance")
  .action(draftList);

draft
  .command("promote")
  .argument("<slug>", "draft slug, as `malloyyo draft list` prints it")
  .argument("[dir]", "model directory to write into", ".")
  .option("-i, --instance <instance>", "instance URL, or a configured target name")
  .option("--dataset <dataset>", "dataset the draft belongs to; overrides the config")
  .option("--token <token>", "bearer token (overrides login/env)")
  .option("--name <name>", "dashboard name to write as (default: the draft's own)")
  .option("--tsx", "write the component as .tsx instead of .jsx")
  .option("--force", "overwrite existing dashboard files of that name")
  .description("write a draft into this repo as dashboards/<name>.malloy + component")
  .action(draftPromote);

program
  .command("logout")
  .argument("[target]", "target name or instance URL (optional if the config has one target)")
  .description("forget the stored token for an instance")
  .action(logoutCmd);

program
  .command("publish")
  .argument(
    "[target]",
    "named target from the `malloyyo` config block; optional when the repo defines one",
  )
  .argument("[dir]", "directory to publish", ".")
  .option(
    "-i, --instance <instance>",
    "instance URL, or a configured target name to borrow the url from; overrides the config",
  )
  .option("--dataset <dataset>", "dataset to publish into; overrides the config")
  .option("--token <token>", "bearer token (overrides login/env)")
  .option("--dry-run", "gather and report what would be sent, but don't POST")
  .option("--skip-lint", "skip the pre-publish dashboard lint")
  .option("--create-dataset", "create the target dataset if it doesn't exist yet (private)")
  .option(
    "--repo <owner/name>",
    "publish a repo with a datasets/ directory — every dataset in it, as one unit",
  )
  .option("--create-datasets", "with --repo: create any dataset the repo publishes that doesn't exist yet")
  .description('push the Malloy model in <dir> (default ".") to <target>')
  .addHelpText("after", `\n${PUBLISH_HELP}\n`)
  .action(publish);

program
  .command("lint")
  .argument("[dir]", "repo (or dataset directory) to lint", ".")
  .description("validate the whole repo: its layout, and every dataset's dashboards")
  .action(async (dir: string) => {
    const root = resolve(dir);
    // THE REPO, not a directory. A repo publishes as a unit, and for a
    // GitHub-backed one it refreshes on a trigger — so this is the last moment a
    // human sees an error, and it has to have looked at all of it. Pointing this
    // at a single dataset directory still works: that directory is a repo shape
    // of its own.
    const repo = await lintRepo(root);
    if (repo.empty) {
      // A repo `malloyyo init` just made. Nothing is wrong with it yet.
      console.log("no datasets yet — run `claude` here and ask it to add one.");
      return;
    }
    if (repo.layoutError) {
      console.error(`✗ ${repo.layoutError}`);
      process.exit(1);
    }
    const total = repo.datasets.reduce((n, d) => n + d.report.dashboards.length, 0);
    if (total === 0) {
      console.log(
        repo.datasets.length > 1
          ? `${repo.datasets.length} datasets, no dashboards to lint`
          : "no dashboards to lint",
      );
      if (repo.oldLayout) console.log(`\n${OLD_LAYOUT_NOTICE}`);
      return;
    }
    printRepoLintReport(repo);
    if (repo.oldLayout) console.log(`\n${OLD_LAYOUT_NOTICE}`);
    if (!repo.ok) {
      // Same diagnosis publish gives: an unset {env:…} secret surfaces here as a
      // connection error with no hint of which variable is missing.
      const hint = missingEnvHint(missingEnvRefs(gatherDirectory(root).config), "this shell");
      if (hint) console.error(hint.replace(/^\n/, ""));
      process.exit(1);
    }
  });

program
  .command("status")
  .argument(
    "[target]",
    "named target from the `malloyyo` config block; optional when the repo defines one",
  )
  .option("--token <token>", "bearer token (overrides login/env)")
  .description("show what's live on the target: version, commit, compile state")
  .action(status);

program
  .command("mcp")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .option("--develop", "author surface: compile/prettify/query any .malloy in the project")
  .option("--explore", "explore surface: the claude.ai web preview (index.malloy only) [default]")
  .description(
    "run a local stdio MCP server over the Malloy model in the current directory. " +
      "--develop for authoring, --explore (default) to preview the web experience",
  )
  .action(async (opts: { root?: string; develop?: boolean; explore?: boolean }) => {
    if (opts.develop && opts.explore) {
      throw new Error("pass only one of --develop / --explore");
    }
    await serveMcp({
      root: opts.root,
      version: VERSION,
      mode: opts.develop ? "develop" : "explore",
    });
  });

program
  .command("init")
  .argument("[dir]", "model repo to set up", ".")
  .description(
    "set up an empty model repo: .mcp.json so `cd <repo> && claude` opens in " +
      "author mode, plus malloy-config.json and datasets/. Ask claude to add datasets.",
  )
  .action(initCmd);

program
  .command("sql")
  .argument("[connection]", "connection name from malloy-config.json", "duckdb")
  .option("-e, --execute <sql>", "SQL to run (else read from -f <file> or stdin)")
  .option("-f, --file <path>", "read SQL from a file")
  .option("-C, --root <dir>", "project root for malloy-config.json discovery (default: current directory)")
  .option("-j, --json", "print result rows as JSON")
  .description(
    "run raw SQL against a configured connection using the embedded DuckDB — " +
      "e.g. COPY a web CSV into docs/*.parquet, no standalone duckdb needed",
  )
  .action(
    async (
      connection: string | undefined,
      opts: { execute?: string; file?: string; json?: boolean; root?: string },
    ) => {
      await sqlCmd(connection, opts);
    },
  );

program
  .command("author")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .description("launch Claude wired ONLY to the author surface (compile/edit the model)")
  .action(async (opts: { root?: string }) => {
    await launchCmd("author", opts);
  });

program
  .command("test")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .description("launch Claude wired ONLY to the explore surface — the claude.ai web preview")
  .action(async (opts: { root?: string }) => {
    await launchCmd("test", opts);
  });

program
  .command("dashboard")
  .argument("<action>", "action to run (dev | bundle)")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .option("-p, --port <port>", "port to serve on (dev)", "4173")
  .option("-o, --out <dir>", "output directory (bundle)", "docs")
  .option("--title <title>", "site title (bundle; default: project directory name)")
  .option("--target <target>", "deploy target: pages | vercel (bundle)", "pages")
  .option("--duckdb <source>", "DuckDB binaries: cdn | bundled (bundle)", "cdn")
  .option("--analytics <id>", "GA4 Measurement ID, overriding malloyyo.analytics in malloy-config.json (bundle)")
  .option("--no-serve", "bundle only; don't serve the result (bundle)")
  .description("preview dashboards locally (dev), or build a static site from them (bundle)")
  .action(
    async (
      action: string,
      opts: { root?: string; port?: string; out?: string; title?: string; serve?: boolean; target?: string; duckdb?: string; analytics?: string },
    ) => {
      if (action === "dev") {
        await serveDashboard({ root: opts.root, port: Number(opts.port) });
        return;
      }
      if (action === "bundle") {
        if (opts.target !== "pages" && opts.target !== "vercel") {
          throw new Error(`unknown --target '${opts.target}' (expected: pages | vercel)`);
        }
        if (opts.analytics && !/^G-[A-Z0-9]+$/i.test(opts.analytics)) {
          throw new Error(
            `--analytics expects a GA4 Measurement ID like G-XXXXXXXXXX, got '${opts.analytics}'`,
          );
        }
        if (opts.duckdb !== "cdn" && opts.duckdb !== "bundled") {
          throw new Error(`unknown --duckdb '${opts.duckdb}' (expected: cdn | bundled)`);
        }
        await bundleDashboards({
          root: opts.root,
          out: opts.out,
          title: opts.title,
          serve: opts.serve,
          target: opts.target,
          duckdb: opts.duckdb,
          analytics: opts.analytics,
          // `dashboard dev` owns 4173/4174; default the bundle preview clear of
          // both so you can run the two side by side.
          port: opts.port === "4173" ? 4180 : Number(opts.port),
        });
        return;
      }
      throw new Error(`unknown dashboard action '${action}' (expected: dev | bundle)`);
    },
  );

// `malloyyo cloud …` — managing Malloyyo-hosted instances. It sets `process.exitCode`
// itself rather than throwing, because its failures are already phrased for the person
// who typed the command.
registerCloudCommands(program);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
