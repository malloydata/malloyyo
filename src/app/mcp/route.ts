// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// /mcp on the official MCP server SDK (@modelcontextprotocol/server v2)
// instead of hand-rolled JSON-RPC. The SDK owns the
// protocol — both eras (2025 `initialize`, 2026-07-28 `server/discover`),
// version negotiation, result envelopes, cache fields. This file owns only
// what is ours: bearer auth, the per-user hosted surface, and logging.

import {
  McpServer,
  ResourceTemplate,
  createMcpHandler,
  fromJsonSchema,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { publishedSchema } from "@malloyyo/mcp-engine/mcp-sdk";
import { buildHostedExploreSurface, dashboardUrl } from "@/lib/mcp-host";
import {
  BUNDLE_TOOL,
  RUN_TOOL,
  SHOW_TOOL,
  dashboardBundlePayload,
} from "@/lib/mcp-app-dashboard";
import { dashboardPanel, type DashboardPanel } from "@/lib/mcp-app-panel";
import { DRAFT_PREFIX, draftForward, draftSlug, getDashboard, listDashboards, visibleImageHosts } from "@/lib/dashboards";
import { deleteDraft, recordPromotion, saveDraftDashboard } from "@/lib/dashboards/draft";
import { hasRole, MALLOYYO_ADMIN } from "@/lib/roles";
import { checkRepo, describeTable, findRepo, listRepos, listTables, publishRepo } from "@/lib/repo-authoring";
import { fetchBranchPreview } from "@/lib/repo-preview-store";
import { createApiToken } from "@/lib/api-tokens";
import { runDashboard } from "@/lib/dashboards/engine";
import { bearerToken, credentialLabel, resolveBearer, type Credential } from "@/lib/bearer-auth";
import { corsPreflight, withCors } from "@/lib/oauth/cors";
import { originFromRequest } from "@/lib/oauth/base-url";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Log = ReturnType<typeof logger.child>;
type Hosted = ReturnType<typeof buildHostedExploreSurface>;

/** What the route resolves before the SDK sees the request. */
interface RequestScope {
  userId: string;
  /** The whole user, not just the id: a tenant-scoped model binds their email
      (src/lib/tenancy.ts), and that must come from the credential, never the
      request body. */
  user: { id: string; email: string | null; roles: string[] };
  hosted: Hosted;
  log: Log;
  /** The URL this client reached us at — what the CLI must use too. */
  origin: string;
  /** What kind of credential is calling.
   *
   *  Carried because one tool must refuse one of them: an API token may not
   *  mint another API token. Without this the scope could not tell, and a
   *  minted token could mint its successor indefinitely. */
  credentialKind: Credential["kind"];
}

type Json = Record<string, unknown>;

function text(t: string): CallToolResult["content"] {
  return [{ type: "text", text: t }];
}

/** Wrap a handler so every tool call logs the same lines the old route did. */
function logged<A>(scope: RequestScope, tool: string, fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    const start = Date.now();
    scope.log.info("mcp tool call", { tool });
    try {
      const out = await fn(args);
      scope.log.info("mcp tool ok", { tool, durationMs: Date.now() - start });
      return out;
    } catch (e) {
      scope.log.error("mcp tool error", {
        tool,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
}

function buildServer(scope: RequestScope): McpServer {
  const { hosted } = scope;
  const server = new McpServer(
    { name: env.INSTANCE_NAME, version: VERSION },
    {
      instructions: hosted.instructions,
      capabilities: {
        extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
      },
    },
  );

  // The explore surface: the engine's JSON Schema descriptors, as they are,
  // validated by the engine rather than the SDK (see publishedSchema).
  for (const d of hosted.descriptors) {
    server.registerTool(
      d.name,
      { title: d.title, description: d.description, inputSchema: publishedSchema(d.inputSchema) },
      logged(scope, d.name, async (args: Json) => (await hosted.call(d.name, args)) as CallToolResult),
    );
  }

  // The dashboard app. Its panel is markup plus two <script src> onto this
  // instance's own origin, so there is nothing to read off disk and nothing
  // that can be missing from a deployment at this point.
  registerDashboardApp(server, scope, dashboardPanel(scope.origin));

  registerAuthoringTools(server, scope);

  // Admins only: these run SQL through a repo's connections and compile model
  // code nobody has reviewed — the power publishing already has, reached from
  // a chat. A member never sees them.
  if (hasRole(scope.user, MALLOYYO_ADMIN)) registerRepoTools(server, scope);

  return server;
}

/** Text + structured content for a tool result, as an error when `ok` is false. */
function result<T extends { ok: boolean; error?: string }>(r: T, summary?: string): CallToolResult {
  if (!r.ok) return { content: text(r.error ?? "failed"), structuredContent: r as unknown as Json, isError: true };
  return { content: text(summary ?? JSON.stringify(r, null, 2)), structuredContent: r as unknown as Json };
}

/**
 * Adding a dataset to a repo from a chat (src/lib/repo-authoring.ts). Git
 * writes are GitHub's own MCP server's, as the person; these are what only
 * this instance can answer — what a repo's connections can see, whether a
 * branch or pull request compiles here, and the publish after the merge.
 */
function registerRepoTools(server: McpServer, scope: RequestScope): void {
  const tag = `[${env.INSTANCE_NAME}]`;
  const withRepo = async <T extends object>(ref: string, fn: (repo: NonNullable<Awaited<ReturnType<typeof findRepo>>>) => Promise<T>) => {
    const repo = await findRepo(ref);
    if (!repo) return { ok: false, error: `No repo "${ref}" on this instance. list_repos shows them.` };
    return fn(repo);
  };

  server.registerTool(
    "list_repos",
    {
      title: "List model repos",
      description:
        `${tag} The model repos this instance publishes: their GitHub repo and branch, layout, datasets and ` +
        `database connections (names and kinds only), and the branches fetched as previews. Start here to ` +
        `add a dataset to a repo (read yo_help("repo/add-dataset-from-chat") first), or to try a branch's ` +
        `models and dashboards before they're published (yo_help("repo/branches")).`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<Json>({ type: "object", properties: {} }),
    },
    logged(scope, "list_repos", async () => {
      const repos = await listRepos();
      return result({ ok: true, repos });
    }),
  );

  type TablesArgs = { repo: string; connection: string; schema?: string; like?: string; dataset_dir?: string };
  server.registerTool(
    "list_tables",
    {
      title: "List a connection's tables",
      description:
        `${tag} Lists the tables a repo's database connection can see (up to 500), before anything is ` +
        `modeled. \`schema\` narrows to one schema (BigQuery requires it: the dataset); \`like\` filters ` +
        `names (SQL LIKE, e.g. "%order%"). Admins only.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<TablesArgs>({
        type: "object",
        properties: {
          repo: { type: "string", description: "The repo, as list_repos names it (slug or owner/name)." },
          connection: { type: "string", description: "A connection name from list_repos." },
          schema: { type: "string", description: "Optional schema (BigQuery: dataset) to list." },
          like: { type: "string", description: "Optional table-name pattern, SQL LIKE." },
          dataset_dir: { type: "string", description: "Optional: use this dataset's own malloy-config.json." },
        },
        required: ["repo", "connection"],
      }),
    },
    logged(scope, "list_tables", async (a: TablesArgs) =>
      result(await withRepo(a.repo, (repo) => listTables(repo, a.connection, { schema: a.schema, like: a.like, dir: a.dataset_dir }))),
    ),
  );

  type DescribeArgs = { repo: string; connection: string; table: string; dataset_dir?: string };
  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description:
        `${tag} One table's columns and types, its row count and ${5} sample rows, read through the repo's ` +
        `connection the way a model would read it (\`connection.table('…')\`). On DuckDB the table can be a ` +
        `file path or URL (Parquet, CSV, JSON). Admins only.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<DescribeArgs>({
        type: "object",
        properties: {
          repo: { type: "string", description: "The repo, as list_repos names it." },
          connection: { type: "string", description: "A connection name from list_repos." },
          table: { type: "string", description: "Table as the model would name it: 'schema.table', or a path/URL on DuckDB." },
          dataset_dir: { type: "string", description: "Optional: use this dataset's own malloy-config.json." },
        },
        required: ["repo", "connection", "table"],
      }),
    },
    logged(scope, "describe_table", async (a: DescribeArgs) =>
      result(await withRepo(a.repo, (repo) => describeTable(repo, a.connection, a.table, { dir: a.dataset_dir }))),
    ),
  );

  type CheckArgs = {
    repo: string;
    ref?: string;
    pull_request?: number;
    test_query?: { dataset_dir: string; malloy: string };
  };
  server.registerTool(
    "check_repo",
    {
      title: "Check a branch or pull request",
      description:
        `${tag} Compiles a repo at a commit, branch or tag (\`ref\`), or at a pull request's merge result ` +
        `(\`pull_request\`), exactly as publishing would: layout rules, every dataset, its dashboards. Nothing ` +
        `is stored or published. Says which datasets are new. \`test_query\` also runs one Malloy query ` +
        `against a dataset at that ref. Right after a commit, pass the commit SHA your write returned: a branch ` +
        `name can resolve to the previous commit for up to a minute. Check the pull request before merging it — that is what catches a ` +
        `change that merges cleanly but breaks the model. Admins only.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<CheckArgs>({
        type: "object",
        properties: {
          repo: { type: "string", description: "The repo, as list_repos names it." },
          ref: { type: "string", description: "Commit SHA (best, right after a commit), branch or tag. Default: the repo's published branch." },
          pull_request: { type: "integer", description: "Check this pull request's merge result instead of a ref." },
          test_query: {
            type: "object",
            description: "Optional query to run at that ref.",
            properties: {
              dataset_dir: { type: "string", description: "The dataset's directory, e.g. datasets/returns." },
              malloy: { type: "string", description: "Malloy text, e.g. run: returns -> { aggregate: row_count }" },
            },
            required: ["dataset_dir", "malloy"],
          },
        },
        required: ["repo"],
      }),
    },
    logged(scope, "check_repo", async (a: CheckArgs) =>
      result(
        await withRepo(a.repo, (repo) =>
          checkRepo(
            repo,
            { ref: a.ref, pr: a.pull_request },
            a.test_query ? { dir: a.test_query.dataset_dir, malloy: a.test_query.malloy } : undefined,
          ),
        ),
      ),
    ),
  );

  type FetchArgs = { repo: string; branch: string };
  server.registerTool(
    "fetch_branch",
    {
      title: "Preview a branch: its models and dashboards, unpublished",
      description:
        `${tag} The way to SEE a branch's changes here — models, queries, dashboards — before they are ` +
        `published. Fetches the branch from GitHub (push first) into a preview, compiled but not ` +
        `published. Every tool that takes a dataset then takes \`repo@branch:dataset\` ` +
        `(query's model_ref, describe_source, show_dashboard) and serves that snapshot until the next ` +
        `fetch, so fetch again after each push. Returns each dataset's preview address, whether it ` +
        `compiled, and a browser link to each dashboard. Admins only.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<FetchArgs>({
        type: "object",
        properties: {
          repo: { type: "string", description: "The repo, as list_repos names it." },
          branch: { type: "string", description: "The branch to fetch." },
        },
        required: ["repo", "branch"],
      }),
    },
    logged(scope, "fetch_branch", async (a: FetchArgs) => {
      const out = await withRepo(a.repo, (repo) => fetchBranchPreview(repo, a.branch, scope.userId));
      if (!out.ok) return result(out);
      const r = out as Extract<typeof out, { revision: number }>;
      // Links, not just addresses: the person wants to open the dashboards,
      // and an address alone left a model guessing at the URL shape.
      const datasets = r.datasets.map((d) => ({
        ...d,
        dashboards: (d.artifacts ?? []).map((a) => ({
          name: a.name,
          title: a.title,
          url: dashboardUrl(env.APP_BASE_URL, d.address, a.name),
        })),
      }));
      const lines = datasets.flatMap((d) => [
        `  ${d.address} — ${d.ok ? `${d.status}, ${d.sources?.length ?? 0} sources, ${d.dashboards.length} dashboards` : `FAILED: ${d.error}`}`,
        ...d.dashboards.map((a) => `      ${a.title ?? a.name}: ${a.url}`),
      ]);
      return result(
        { ...r, datasets },
        `Fetched ${r.repo}@${r.branch} at ${r.commit?.slice(0, 7) ?? "?"}. Preview addresses:\n${lines.join("\n")}\n\n` +
          `Pass an address as model_ref to describe_source and query, or as dataset to show_dashboard. ` +
          `Give the person the dashboard links. This is a snapshot: after the next push, fetch_branch again.`,
      );
    }),
  );

  server.registerTool(
    "publish_repo",
    {
      title: "Publish a repo",
      description:
        `${tag} Pulls the repo's published branch from GitHub and publishes it, creating a dataset for any new ` +
        `datasets/<name>/ directory. Run it after the pull request is merged. Everything compiles or nothing ` +
        `changes. Admins only.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<{ repo: string }>({
        type: "object",
        properties: { repo: { type: "string", description: "The repo, as list_repos names it." } },
        required: ["repo"],
      }),
    },
    logged(scope, "publish_repo", async ({ repo: ref }: { repo: string }) => {
      const out = await withRepo(ref, (repo) => publishRepo(repo));
      if (!out.ok) return result(out);
      const r = out as Extract<typeof out, { revision: number }>;
      const created = r.datasets.filter((d) => d.created).map((d) => d.qualified);
      return result(
        r,
        r.unchanged
          ? `Nothing new: ${r.repo.slug} is already at this commit.`
          : `Published ${r.repo.slug} revision ${r.revision}` +
              (created.length ? `; created ${created.join(", ")}` : "") +
              `. Datasets: ${r.datasets.map((d) => d.qualified).join(", ")}.`,
      );
    }),
  );
}

/** How long a CLI token from issue_cli_token lives. */
const CLI_TOKEN_TTL_MS = 60 * 60 * 1000;
const ISSUE_CLI_TOKEN_TOOL = "issue_cli_token";
const SAVE_DRAFT_TOOL = "save_draft_dashboard";
const DELETE_DRAFT_TOOL = "delete_draft_dashboard";
const PROMOTED_DRAFT_TOOL = "mark_draft_promoted";

/**
 * Dashboard authoring from an agent: a CLI credential, and draft dashboards.
 *
 * issue_cli_token lets an agent that is already connected here (Claude Code,
 * say) drive the `malloyyo` CLI against THIS instance without a browser
 * login. The token is keyed to the URL the client connected to, lives an hour,
 * and carries only the `mcp` scope — the caller's own scope, never publish.
 */
function registerAuthoringTools(server: McpServer, scope: RequestScope): void {
  const { userId, origin } = scope;
  const tag = `[${env.INSTANCE_NAME}]`;

  server.registerTool(
    ISSUE_CLI_TOKEN_TOOL,
    {
      title: "Issue a CLI token",
      description:
        `${tag} Issues a short-lived token so the \`malloyyo\` CLI can act as you against THIS ` +
        `instance (${origin}) — \`malloyyo draft list\` and \`malloyyo draft promote <slug>\`, which ` +
        `write a draft dashboard into a model checkout. Scope: query only (never publish); expires ` +
        `in an hour. Returns the URL and the command that stores it. If a dataset exists on more ` +
        `than one connected instance, confirm with the user which instance first.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<Json>({ type: "object", properties: {} }),
    },
    logged(scope, ISSUE_CLI_TOKEN_TOOL, async () => {
      // An API token may not mint another API token.
      //
      // Both credential kinds can reach /mcp, so without this a minted token
      // could call this tool and mint its successor, and that one the next —
      // a chain with no end, each link a fresh hour, derived from a credential
      // whose own lifetime no longer constrains it. The hour is only a bound if
      // renewing it requires going back to the thing that granted it.
      //
      // OAuth is where the hour comes from, so OAuth is who may ask. A CLI that
      // holds a token and wants another has somewhere to go: `malloyyo login`,
      // or /settings/tokens, both of which involve the person.
      if (scope.credentialKind === "api-token") {
        const why =
          `${ISSUE_CLI_TOKEN_TOOL} is for a connected client (an OAuth connection) and not for an ` +
          `API token: a token cannot mint another token. Run \`malloyyo login ${origin}\` or create ` +
          `one at ${origin}/settings/tokens.`;
        return { content: text(why), structuredContent: { ok: false, error: why }, isError: true };
      }
      const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_MS);
      const created = await createApiToken({
        userId,
        name: `CLI via MCP (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`,
        scopes: ["mcp"],
        expiresAt,
      });
      if (!created.ok) {
        return { content: text(created.error), structuredContent: { ok: false, error: created.error }, isError: true };
      }
      const login = `malloyyo login ${origin} --token-stdin`;
      return {
        content: text(
          `Token for ${origin} (query scope, expires ${expiresAt.toISOString()}). Store it with:\n` +
            `  printf '%s' '${created.raw}' | ${login}\n` +
            `Then target this instance with \`-i ${origin}\`. When it expires, call ${ISSUE_CLI_TOKEN_TOOL} again.`,
        ),
        structuredContent: {
          ok: true,
          url: origin,
          token: created.raw,
          expires_at: expiresAt.toISOString(),
          login,
        },
      };
    }),
  );

  type SaveArgs = {
    dataset: string;
    name: string;
    source?: string;
    malloy?: string;
    title?: string;
    description?: string;
    slug?: string;
  };
  server.registerTool(
    SAVE_DRAFT_TOOL,
    {
      title: "Save a draft dashboard",
      description:
        `${tag} Saves a draft dashboard and returns a URL to open it. Simplest form: a React ` +
        `component (\`source\`) that runs its own queries inline — ` +
        `\`useQuery({ malloy: "run: flights -> { group_by: carrier; aggregate: flight_count }" })\` ` +
        `— plus a \`title\`. Malloy runs against the model's published surface under the same ` +
        `rules as the \`query\` tool. For controls, named queries or a chart with no code, add ` +
        `\`malloy\`: a dashboards/<name>.malloy tagged \`# artifact\`. Read ` +
        `yo_help("dashboards/drafts") BEFORE writing one — it has the component shape, what you ` +
        `may import, and the query rules. Reports each query's result and any component compile error, ` +
        `so fix what it reports before showing the user. Pass \`slug\` to update a draft you ` +
        `already saved; show_dashboard renders it by the returned \`dashboard\` name.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<SaveArgs>({
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name (the model_ref list_sources reports)." },
          name: { type: "string", description: 'A short name, e.g. "revenue_trend".' },
          source: { type: "string", description: "The React component (JSX/TSX), default-exported." },
          malloy: {
            type: "string",
            description: "Optional dashboards/<name>.malloy — needed only for controls, named queries, or a tag-only dashboard.",
          },
          title: { type: "string", description: "Shown as the dashboard's title (a .malloy carries its own)." },
          description: {
            type: "string",
            description: "One line on what it answers, shown under the title in listings.",
          },
          slug: { type: "string", description: "Update this draft instead of creating one." },
        },
        required: ["dataset", "name"],
      }),
    },
    logged(scope, SAVE_DRAFT_TOOL, async (a: SaveArgs) => {
      const r = await saveDraftDashboard(userId, a.dataset, a, origin);
      if (!r.ok) {
        const detail = r.problems?.map((p) => `  - ${p.message}`).join("\n");
        return {
          content: text(detail ? `${r.error}\n${detail}` : r.error),
          structuredContent: r as unknown as Json,
          isError: true,
        };
      }
      const failed = r.tiles.filter((t) => !t.ok);
      return {
        content: text(
          `Saved '${r.title}' as ${r.dashboard} — ${r.url}\n` +
            `Tiles: ${r.tiles.length - failed.length}/${r.tiles.length} ran` +
            (failed.length ? `; failed: ${failed.map((t) => `${t.run} (${t.error})`).join("; ")}` : "") +
            (r.component.ok ? "" : `\nComponent error${r.component.line ? ` (line ${r.component.line})` : ""}: ${r.component.error}`),
        ),
        structuredContent: r as unknown as Json,
      };
    }),
  );

  // A draft is named `draft-<slug>` everywhere a dashboard goes; accept either.
  const slugOf = (dashboard: string) => draftSlug(dashboard) ?? dashboard;
  const fail = (msg: string): CallToolResult => ({ content: text(msg), structuredContent: { ok: false, error: msg }, isError: true });

  type DraftRefArgs = { dataset: string; dashboard: string };
  server.registerTool(
    DELETE_DRAFT_TOOL,
    {
      title: "Delete a draft dashboard",
      description:
        `${tag} Deletes a draft dashboard; its link stops working. Its author or an admin may. Ask the person ` +
        `first. A draft that was promoted and is now published doesn't need deleting: it is already out of ` +
        `the listings, and its link forwards to the published dashboard — deleting it ends that forward.`,
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: fromJsonSchema<DraftRefArgs>({
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name (the model_ref list_sources reports)." },
          dashboard: { type: "string", description: "The draft, as `draft-<slug>` or its slug." },
        },
        required: ["dataset", "dashboard"],
      }),
    },
    logged(scope, DELETE_DRAFT_TOOL, async (a: DraftRefArgs) => {
      const r = await deleteDraft(scope.user, a.dataset, slugOf(a.dashboard));
      if (r.outcome === "not-yours") return fail("That draft belongs to someone else; its author or an admin can delete it.");
      if (r.outcome === "not-found") return fail(`No draft '${a.dashboard}' in '${a.dataset}'.`);
      return {
        content: text(
          `Deleted ${DRAFT_PREFIX}${slugOf(a.dashboard)}.` +
            ("promotedAs" in r && r.promotedAs ? ` Its link no longer forwards to '${r.promotedAs}'.` : ""),
        ),
        structuredContent: { ok: true, deleted: `${DRAFT_PREFIX}${slugOf(a.dashboard)}` },
      };
    }),
  );

  type PromotedArgs = DraftRefArgs & { promoted_as: string };
  server.registerTool(
    PROMOTED_DRAFT_TOOL,
    {
      title: "Mark a draft as promoted",
      description:
        `${tag} Records that a draft dashboard was written into the model repo as \`promoted_as\` (the ` +
        `dashboard's name there, i.e. dashboards/<promoted_as>.malloy). Call it after the files are ` +
        `committed. Once the dataset publishes that dashboard, the draft's link redirects to it and the ` +
        `draft leaves the listings, so saved links keep working. Until then the draft still serves. ` +
        `The draft's author records it.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<PromotedArgs>({
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name (the model_ref list_sources reports)." },
          dashboard: { type: "string", description: "The draft, as `draft-<slug>` or its slug." },
          promoted_as: { type: "string", description: "The dashboard's name in the repo, e.g. revenue_trend." },
        },
        required: ["dataset", "dashboard", "promoted_as"],
      }),
    },
    logged(scope, PROMOTED_DRAFT_TOOL, async (a: PromotedArgs) => {
      const name = a.promoted_as.trim();
      if (!name || draftSlug(name) !== null) return fail(`'${a.promoted_as}' isn't a dashboard name a repo publishes.`);
      const outcome = await recordPromotion(userId, a.dataset, slugOf(a.dashboard), { name });
      if (outcome === "not-yours") return fail("That draft belongs to someone else; its author records its promotion.");
      if (outcome === "not-found") return fail(`No draft '${a.dashboard}' in '${a.dataset}'.`);
      const live = await draftForward(userId, a.dataset, `${DRAFT_PREFIX}${slugOf(a.dashboard)}`);
      return {
        content: text(
          live
            ? `Recorded. '${name}' is already published, so the draft's link now opens it.`
            : `Recorded. Once '${name}' is published (merge, then publish_repo), the draft's link opens it instead.`,
        ),
        structuredContent: { ok: true, promoted_as: name, forwarding: Boolean(live) },
      };
    }),
  );
}

/** Any panel URI this server has ever minted — see the template registration. */
const PANEL_URI_RE = /^ui:\/\/dashboard\/panel-[0-9a-f]{6,64}\.html$/;

/** One panel resource, one model-visible tool, and two tools only the panel calls. */
function registerDashboardApp(server: McpServer, scope: RequestScope, panel: DashboardPanel): void {
  const { userId, origin } = scope;
  const { uri } = panel;
  const tag = `[${env.INSTANCE_NAME}]`;

  /**
   * The panel document, answered at whatever URI was asked for.
   *
   * A panel runs under a default-deny policy, so every origin it loads
   * anything from has to be declared here. Two kinds:
   *
   *   - THIS INSTANCE, where the panel's own two scripts live. Without it the
   *     panel is an empty document.
   *   - The model repos' declared image_hosts, so a dashboard that builds
   *     <img src> from a model column (poster art, logos, avatars) shows them
   *     inside Claude as it does on the web app — which widens its own frame's
   *     img-src from the same malloy-config.json list.
   *
   * resourceDomains is broader than img-src (scripts, styles, fonts, media
   * too), so the repo half stays an allowlist the model's own author declared,
   * never a blanket https:.
   */
  const panelContents = async (at: string) => {
    const resourceDomains = [origin, ...(await visibleImageHosts(userId))];
    return {
      contents: [
        {
          uri: at,
          mimeType: RESOURCE_MIME_TYPE,
          text: panel.html,
          _meta: { ui: { csp: { resourceDomains } } },
        },
      ],
    };
  };

  // One shell for every dashboard. PRIVATE rather than public, because the
  // policy above is this user's: the body is identical for everyone, the image
  // hosts are not.
  registerAppResource(
    server,
    "Dashboard panel",
    uri,
    { cacheHint: { ttlMs: 3_600_000, cacheScope: "private" } } as never,
    () => panelContents(uri),
  );

  /**
   * ...and the same shell for a panel URI from an EARLIER BUILD.
   *
   * The URI is content-addressed, so every deploy that changes the shell mints
   * a new one — while a client goes on holding the tool list it discovered
   * before, whose `_meta.ui.resourceUri` names the old one. It then reads a URI
   * this server no longer registers, and the panel fails to load with the tools
   * around it working perfectly. Observed twice on the same day: the client
   * asked for panel-5829f82a1dd5.html for half an hour after the deploy that
   * replaced it.
   *
   * Exact registrations are matched before templates (verified in the SDK's
   * read handler), so this only ever answers the stale case. The body is
   * current on purpose: a stale URI is a name for "the panel", not for a
   * version of it, and the runtime it loads is fetched by URL anyway.
   */
  server.registerResource(
    "Dashboard panel (earlier build)",
    new ResourceTemplate("ui://dashboard/{file}", { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE, cacheHint: { ttlMs: 3_600_000, cacheScope: "private" } } as never,
    async (requested: URL) => {
      const at = requested.toString();
      if (!PANEL_URI_RE.test(at)) throw new Error(`no resource at ${at}`);
      scope.log.info("mcp panel from an earlier build", { requested: at, current: uri });
      return panelContents(at);
    },
  );

  registerAppTool(
    server,
    SHOW_TOOL,
    {
      title: "Show a dashboard",
      description:
        `${tag} Renders one of this instance's dashboards inline, as an interactive panel. ` +
        `Dashboards are listed per model by list_sources. ` +
        `Once it renders, say it is there rather than restating its contents.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<{ dataset: string; dashboard: string }>({
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name (the model_ref list_sources reports)." },
          dashboard: { type: "string", description: "Dashboard name, as listed by list_sources." },
        },
        required: ["dataset", "dashboard"],
      }),
      _meta: { ui: { resourceUri: uri } },
    },
    logged(scope, SHOW_TOOL, async ({ dataset, dashboard }: { dataset: string; dashboard: string }) => {
      // Check before claiming success: otherwise the model reports a dashboard
      // as shown while the panel says "not found" — or, in a client that
      // doesn't draw panels, shows nothing at all. getDashboard answers null
      // for a dataset the user can't see, so this can't reveal one exists.
      // A promoted draft that's now published shows the published dashboard.
      dashboard = (await draftForward(userId, dataset, dashboard)) ?? dashboard;
      const dash = await getDashboard(userId, dataset, dashboard);
      if (!dash) {
        const names = (await listDashboards(userId, dataset)).map((d) => d.name);
        const msg = names.length
          ? `No dashboard '${dashboard}' in '${dataset}'. Its dashboards: ${names.join(", ")}.`
          : `No dashboards found for '${dataset}'. list_sources reports each model's dashboards.`;
        return { content: text(msg), structuredContent: { ok: false, error: msg }, isError: true };
      }
      return {
        // The link too: a client that doesn't draw panels shows nothing, and
        // the person may want it in a browser anyway.
        content: text(
          `Showing the '${dash.title}' dashboard in an inline panel. ` +
            `In a browser: ${dashboardUrl(env.APP_BASE_URL, dataset, dash.name)}`,
        ),
        structuredContent: { ok: true, datasetId: dataset, name: dash.name },
      };
    }),
  );

  const appOnly = { ui: { resourceUri: uri, visibility: ["app" as const] } };

  registerAppTool(
    server,
    BUNDLE_TOOL,
    {
      title: "Load a dashboard's code",
      description: `${tag} Returns a dashboard's compiled bundle. Called by the panel.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<{ datasetId: string; name: string }>({
        type: "object",
        properties: { datasetId: { type: "string" }, name: { type: "string" } },
        required: ["datasetId", "name"],
      }),
      _meta: appOnly,
    },
    logged(scope, BUNDLE_TOOL, async ({ datasetId, name }: { datasetId: string; name: string }) => {
      const payload = await dashboardBundlePayload(userId, { datasetId, name });
      return {
        content: text(payload.ok ? payload.title : payload.error),
        structuredContent: payload as unknown as Json,
        isError: !payload.ok,
      };
    }),
  );

  type RunArgs = { datasetId: string; name: string; query?: string; malloy?: string; givens?: Json };
  registerAppTool(
    server,
    RUN_TOOL,
    {
      title: "Run a dashboard query",
      description: `${tag} Runs one dashboard query. Called by the panel.`,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<RunArgs>({
        type: "object",
        properties: {
          datasetId: { type: "string" },
          name: { type: "string" },
          query: { type: "string", description: "A run-expression, or Malloy text beginning with `run:`." },
          malloy: { type: "string" },
          givens: { type: "object", additionalProperties: true },
        },
        required: ["datasetId", "name"],
      }),
      _meta: appOnly,
    },
    logged(scope, RUN_TOOL, async (a: RunArgs) => {
      const out = await runDashboard(scope.user, a.datasetId, a.name, { query: a.query, malloy: a.malloy }, a.givens ?? {});
      return {
        content: text(out.ok ? "ok" : `error: ${out.error}`),
        structuredContent: out as unknown as Json,
        isError: !out.ok,
      };
    }),
  );

}

// One handler for the process; each request gets a fresh server from the
// factory, built for the user the route authenticated (passed via authInfo).
const handler = createMcpHandler(
  (ctx) => buildServer(ctx.authInfo?.extra?.scope as RequestScope),
  {
    legacy: "stateless",
    responseMode: "json",
    onerror: (e) => logger.warn("mcp sdk error", { error: e.message }),
  },
);

function unauthorized(description: string, request: Request): Response {
  const origin = originFromRequest(request);
  const safe = description.replace(/[^\x20-\x7E]/g, " ").replace(/"/g, "'");
  return withCors(
    new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          `Bearer error="invalid_token", error_description="${safe}", ` +
          `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    }),
  );
}

async function serve(req: Request): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const raw = bearerToken(req);
  if (!raw) {
    logger.info("mcp unauthorized", { requestId, reason: "missing_bearer" });
    return unauthorized("Missing Bearer token. OAuth against this server to obtain one.", req);
  }
  const auth = await resolveBearer(raw, { scope: "mcp" });
  if (!auth.ok) {
    logger.info("mcp unauthorized", { requestId, status: auth.status, reason: auth.error });
    return unauthorized(auth.status === 403 ? auth.error : "Invalid or revoked token", req);
  }
  const log = logger.child({ requestId, userId: auth.user.id, credential: credentialLabel(auth.cred) });
  // The SDK parses the body itself; peek at a clone so every line still names
  // the JSON-RPC method (and the resource/tool it targets).
  let rpc: { method?: string; params?: { name?: string; uri?: string } } = {};
  try { rpc = req.method === "POST" ? await req.clone().json() : {}; } catch { /* the SDK reports it */ }
  log.info("mcp request", {
    rpcMethod: rpc.method,
    target: rpc.params?.name ?? rpc.params?.uri,
    userAgent: req.headers.get("user-agent"),
  });

  const hosted = buildHostedExploreSurface(auth.user, originFromRequest(req), {
    userAgent: req.headers.get("user-agent"),
    authorModel: req.headers.get("x-author-model"),
  });
  const scope: RequestScope = {
    userId: auth.user.id,
    user: auth.user,
    hosted,
    log,
    origin: originFromRequest(req),
    credentialKind: auth.cred.kind,
  };
  const res = await handler.fetch(req, {
    authInfo: { token: raw, clientId: credentialLabel(auth.cred), scopes: ["mcp"], extra: { scope } },
  });
  return withCors(res);
}

export const POST = serve;
export async function OPTIONS() { return corsPreflight(); }

/**
 * GET /mcp — 405, per the Streamable HTTP transport.
 *
 * Clients open GET on the MCP endpoint to listen for server→client messages
 * over SSE. We send none (every response rides the POST), so the spec's answer
 * is 405: "the server MUST return HTTP 405 Method Not Allowed, indicating that
 * the server does not offer an SSE stream at this endpoint."
 *
 * Returning 200 here — as we used to — puts a client into an endless reconnect
 * loop, and one client did exactly that for ~11h at ~1 req/s. In the reference
 * client (@modelcontextprotocol/sdk client/streamableHttp.js) our 200 is
 * `response.ok`, so it is adopted as an open stream with isReconnectable=true;
 * the plain-text body yields zero SSE events and ends at once; the graceful-end
 * path re-arms with `_scheduleReconnection(…, 0)`, resetting the attempt
 * counter so the maxRetries=2 cap never trips; and the flat 1000ms
 * initialReconnectionDelay sets the cadence. A 405 is a bare `return` — no
 * error surfaced, no reconnect.
 *
 * The body text stays: browsers render it regardless of status, so a human who
 * pastes the URL still gets pointed at the right verb.
 *
 * DELETE (2025 session termination) gets the same answer: the server is
 * stateless, so there is no session to end. Neither verb reaches the SDK — it
 * would answer 405 too, but only after the full auth path, which writes
 * last_used_at.
 */
export async function GET(req: Request) {
  // No auth needed to answer, but Streamable HTTP clients send their bearer
  // token when opening the stream — resolve it purely so the log names who is
  // behind any residual traffic. Two indexed lookups (credential, then user),
  // and deliberately no last_used_at write: opening a stream is not a use.
  const raw = bearerToken(req);
  const resolved = raw ? await resolveBearer(raw, { scope: "mcp", recordUse: false }) : null;
  logger.info(`mcp ${req.method}`, {
    requestId: req.headers.get("x-request-id") ?? undefined,
    userId: resolved?.ok ? resolved.user.id : undefined,
    credential: resolved?.ok ? credentialLabel(resolved.cred) : undefined,
    userAgent: req.headers.get("user-agent"),
  });
  return withCors(new Response(
    "POST JSON-RPC requests to this URL. See https://modelcontextprotocol.io",
    { status: 405, headers: { Allow: "POST, OPTIONS" } },
  ));
}

export const DELETE = GET;
