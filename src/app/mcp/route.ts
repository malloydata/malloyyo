// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// /mcp on the official MCP server SDK (@modelcontextprotocol/server v2)
// instead of hand-rolled JSON-RPC. The SDK owns the
// protocol — both eras (2025 `initialize`, 2026-07-28 `server/discover`),
// version negotiation, result envelopes, cache fields. This file owns only
// what is ours: bearer auth, the per-user hosted surface, and logging.

import {
  McpServer,
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
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import {
  BUNDLE_TOOL,
  RUN_TOOL,
  SHOW_TOOL,
  dashboardBundlePayload,
} from "@/lib/mcp-app-dashboard";
import { dashboardPanel, type DashboardPanel } from "@/lib/mcp-app-panel";
import { getDashboard, listDashboards } from "@/lib/dashboards";
import { saveScratchDashboard } from "@/lib/dashboards/scratch";
import { createApiToken } from "@/lib/api-tokens";
import { runDashboard } from "@/lib/dashboards/engine";
import { bearerToken, credentialLabel, resolveBearer } from "@/lib/bearer-auth";
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
  hosted: Hosted;
  log: Log;
  /** The URL this client reached us at — what the CLI must use too. */
  origin: string;
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

  // The dashboard app, only when its panel could be built: a missing panel
  // asset costs the dashboard tools, never the explore tools above.
  const panel = dashboardPanel();
  if (panel) registerDashboardApp(server, scope, panel);

  registerAuthoringTools(server, scope);

  return server;
}

/** How long a CLI token from issue_cli_token lives. */
const CLI_TOKEN_TTL_MS = 60 * 60 * 1000;
const ISSUE_CLI_TOKEN_TOOL = "issue_cli_token";
const SAVE_SCRATCH_TOOL = "save_scratch_dashboard";

/**
 * Dashboard authoring from an agent: a CLI credential, and scratch dashboards.
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
        `instance (${origin}) — e.g. \`malloyyo scratch push\` to build a dashboard from files. ` +
        `Scope: query only (not publish); expires in an hour. Returns the URL and the command ` +
        `that stores it. If a dataset exists on more than one connected instance, confirm with ` +
        `the user which instance first.`,
      annotations: { readOnlyHint: false },
      inputSchema: fromJsonSchema<Json>({ type: "object", properties: {} }),
    },
    logged(scope, ISSUE_CLI_TOKEN_TOOL, async () => {
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
    slug?: string;
  };
  server.registerTool(
    SAVE_SCRATCH_TOOL,
    {
      title: "Save a scratch dashboard",
      description:
        `${tag} Saves a draft dashboard and returns a URL to open it. Simplest form: a React ` +
        `component (\`source\`) that runs its own queries inline — ` +
        `\`useQuery({ malloy: "run: flights -> { group_by: carrier; aggregate: flight_count }" })\` ` +
        `— plus a \`title\`. Malloy runs against the model's published surface under the same ` +
        `rules as the \`query\` tool. For controls, named queries or a chart with no code, add ` +
        `\`malloy\`: a dashboards/<name>.malloy tagged \`# artifact\` (yo_help ` +
        `"dashboards/authoring"). Reports each query's result and any component compile error, ` +
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
          slug: { type: "string", description: "Update this draft instead of creating one." },
        },
        required: ["dataset", "name"],
      }),
    },
    logged(scope, SAVE_SCRATCH_TOOL, async (a: SaveArgs) => {
      const r = await saveScratchDashboard(userId, a.dataset, a, origin);
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
}

/** One panel resource, one model-visible tool, and two tools only the panel calls. */
function registerDashboardApp(server: McpServer, scope: RequestScope, panel: DashboardPanel): void {
  const { userId } = scope;
  const { uri } = panel;
  const tag = `[${env.INSTANCE_NAME}]`;

  registerAppResource(
    server,
    "Dashboard panel",
    uri,
    // One shell for every dashboard and user; the URI changes when it does.
    { cacheHint: { ttlMs: 3_600_000, cacheScope: "public" } } as never,
    async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: panel.html }] }),
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
      const dash = await getDashboard(userId, dataset, dashboard);
      if (!dash) {
        const names = (await listDashboards(userId, dataset)).map((d) => d.name);
        const msg = names.length
          ? `No dashboard '${dashboard}' in '${dataset}'. Its dashboards: ${names.join(", ")}.`
          : `No dashboards found for '${dataset}'. list_sources reports each model's dashboards.`;
        return { content: text(msg), structuredContent: { ok: false, error: msg }, isError: true };
      }
      return {
        content: text(`Showing the '${dash.title}' dashboard in an inline panel.`),
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
      const out = await runDashboard(userId, a.datasetId, a.name, { query: a.query, malloy: a.malloy }, a.givens ?? {});
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
  const scope: RequestScope = { userId: auth.user.id, hosted, log, origin: originFromRequest(req) };
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
