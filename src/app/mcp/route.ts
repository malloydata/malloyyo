// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { buildHostedExploreSurface } from "@/lib/mcp-host";
import {
  BUNDLE_TOOL,
  RUN_TOOL,
  SHOW_TOOL,
  SURFACE_BUILD,
  dashboardBundlePayload,
  isPanelUri,
  panelHtml,
  panelUri,
} from "@/lib/mcp-app-dashboard";
import { listAllDashboards } from "@/lib/dashboards";
import { runDashboard } from "@/lib/dashboards/engine";
import { APP_MIME_TYPE, UI_EXTENSION_ID } from "@/lib/mcp-app";
import { bearerToken, credentialLabel, resolveBearer } from "@/lib/bearer-auth";
import { corsPreflight, withCors } from "@/lib/oauth/cors";
import { originFromRequest } from "@/lib/oauth/base-url";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRpcReq = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * Every result gets `resultType: "complete"`.
 *
 * Protocol revision 2026-07-28 made the field REQUIRED on the result envelope:
 * "servers implementing protocol revision 2026-07-28 MUST include it (the
 * absent-means-complete bridge applies only to earlier-revision servers)".
 * Because we advertise 2026-07-28 in server/discover, a client that takes us at
 * our word rejects EVERY result we return — not just the App tool. That is what
 * "This connector has no tools available" was, and what made every tools/call
 * fail on the direct connector while the same server worked fine through an
 * older-revision bridge.
 *
 * Stamped here rather than per-handler because the reference SDK does exactly
 * that, for all methods (stampResultType in @modelcontextprotocol/client): the
 * field belongs to the envelope, so anything that returns a result needs it and
 * nothing should have to remember.
 *
 * The other value is "input_required", which only some methods may return; no
 * handler here does, so unconditional "complete" is correct.
 */
function ok(id: string | number | null | undefined, result: unknown) {
  const stamped =
    result && typeof result === "object" && !Array.isArray(result) && !("resultType" in result)
      ? { ...(result as Record<string, unknown>), resultType: "complete" }
      : result;
  return withCors(Response.json({ jsonrpc: "2.0", id: id ?? null, result: stamped }));
}

function err(id: string | number | null | undefined, code: number, message: string) {
  return withCors(Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}

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

const PROTOCOL_VERSION = "2025-03-26";

/**
 * Newest first. 2026-07-28 is the revision that introduced `server/discover`
 * and capability `extensions` — which is the revision claude.ai speaks, and
 * the only one in which an MCP App can be advertised at all.
 */
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-06-18", "2025-03-26"];

/** The capability block, shared by `initialize` and `server/discover`. */
function serverCapabilities() {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false },
    extensions: { [UI_EXTENSION_ID]: { mimeTypes: [APP_MIME_TYPE] } },
  };
}
const SERVER_INFO = { name: env.INSTANCE_NAME, version: VERSION };

/**
 * The dashboard surface: three tools and one resource, whatever the dashboard
 * count. `show_dashboard` is the only one the model sees; the other two are
 * `visibility: ["app"]`, called by the panel itself.
 */
function dashboardTools(instance: string) {
  const uri = panelUri();
  const ui = { resourceUri: uri };
  const appOnly = { resourceUri: uri, visibility: ["app"] };
  return [
    {
      name: SHOW_TOOL,
      title: "Show a dashboard",
      description:
        `[${instance}] (build ${SURFACE_BUILD}) Renders one of this instance's dashboards inline, as an ` +
        `interactive panel. Dashboards are listed per dataset by list_sources. ` +
        `Once it renders, say it is there rather than restating its contents.`,
      annotations: { title: "Show a dashboard", readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name or id." },
          dashboard: { type: "string", description: "Dashboard name, as listed by list_sources." },
        },
        required: ["dataset", "dashboard"],
      },
      outputSchema: { type: "object", properties: {}, additionalProperties: true },
      _meta: { ui, "ui/resourceUri": uri },
    },
    {
      name: BUNDLE_TOOL,
      title: "Load a dashboard's code",
      description: `[${instance}] Returns a dashboard's compiled bundle. Called by the panel.`,
      annotations: { title: "Load a dashboard's code", readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { datasetId: { type: "string" }, name: { type: "string" } },
        required: ["datasetId", "name"],
      },
      outputSchema: { type: "object", properties: {}, additionalProperties: true },
      _meta: { ui: appOnly, "ui/resourceUri": uri },
    },
    {
      name: RUN_TOOL,
      title: "Run a dashboard query",
      description: `[${instance}] Runs one dashboard query. Called by the panel.`,
      annotations: { title: "Run a dashboard query", readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          datasetId: { type: "string" },
          name: { type: "string" },
          query: { type: "string", description: "A run-expression, or Malloy text beginning with `run:`." },
          malloy: { type: "string" },
          givens: { type: "object", additionalProperties: true },
        },
        required: ["datasetId", "name"],
      },
      outputSchema: { type: "object", properties: {}, additionalProperties: true },
      _meta: { ui: appOnly, "ui/resourceUri": uri },
    },
  ];
}

export async function POST(req: Request) {
  // Set by the middleware (src/proxy.ts) so these lines correlate with the
  // "request" line that carries the client IP.
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const raw = bearerToken(req);
  if (!raw) {
    logger.info("mcp unauthorized", { requestId, reason: "missing_bearer" });
    return unauthorized("Missing Bearer token. OAuth against this server to obtain one.", req);
  }

  // Either credential opens this door: an OAuth token from a browser sign-in
  // (how claude.ai connects) or a personal API token carrying the "mcp" scope
  // (how a script or an unattended agent does). resolveBearer re-reads the user
  // row and re-runs authorize() on every call, so a disabled account or a
  // revoked token loses access immediately rather than at token expiry.
  const auth = await resolveBearer(raw, { scope: "mcp" });
  if (!auth.ok) {
    logger.info("mcp unauthorized", { requestId, status: auth.status, reason: auth.error });
    return unauthorized(auth.status === 403 ? auth.error : "Invalid or revoked token", req);
  }
  const user = auth.user;

  // Every log line from here on names the user and the credential, so any /mcp
  // request can be attributed — not just the tool calls.
  const log = logger.child({
    requestId,
    userId: user.id,
    credential: credentialLabel(auth.cred),
  });

  let body: JsonRpcReq;
  try { body = (await req.json()) as JsonRpcReq; } catch {
    return withCors(Response.json({ error: "invalid JSON" }, { status: 400 }));
  }
  if (body.jsonrpc !== "2.0" || !body.method) return err(body.id, -32600, "invalid JSON-RPC envelope");

  // One line per authenticated JSON-RPC request — initialize/tools/list/ping
  // included, which previously logged nothing and so were unattributable.
  log.info("mcp request", { rpcMethod: body.method, userAgent: req.headers.get("user-agent") });

  // The deployed /mcp IS the engine's exploreSurface. The host wraps it with
  // instance tagging, the mandatory question, recording, and open_share_link.
  // user_agent identifies the client; x-author-model (set by our LLM test
  // harness) is ground-truth model attribution — absent for organic traffic.
  const hosted = buildHostedExploreSurface(user, originFromRequest(req), {
    userAgent: req.headers.get("user-agent"),
    authorModel: req.headers.get("x-author-model"),
  });

  switch (body.method) {
    case "initialize": {
      // PROTOTYPE: whether this client will render an MCP App at all is the
      // single fact that decides if the panel can work, and it is knowable
      // only from what it advertises here. Logged so a silent non-render is
      // attributable instead of guessed at.
      log.info("mcp initialize", {
        clientExtensions: Object.keys(
          ((body.params?.capabilities ?? {}) as Record<string, unknown>).extensions ?? {},
        ),
      });
      // Match the reference server's handshake exactly
      // (@modelcontextprotocol/server-basic-vanillajs, which renders):
      //
      //   protocolVersion: echoed back from the request, not hardcoded
      //   capabilities:    {tools:{listChanged},resources:{listChanged}}
      //
      // Both mattered. We answered a fixed "2025-03-26" no matter what the
      // client asked for, which can drop a newer client into a mode that
      // predates MCP Apps. And we advertised an `extensions` capability the
      // reference server does not send at all — the UI extension belongs to
      // the 2026-07-28 server/discover handshake below, not to initialize.
      const requested = String((body.params ?? {}).protocolVersion ?? "");
      const negotiated = SUPPORTED_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSION;
      return ok(body.id, {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
        },
        serverInfo: SERVER_INFO,
        instructions: hosted.instructions,
      });
    }

    /**
     * PROTOCOL REVISION 2026-07-28. claude.ai does NOT call `initialize` — it
     * calls this, and the spec says servers MUST implement it. Until it existed
     * here the method fell through to `default:` and was answered with
     * -32601, so every connection's discovery failed silently: tools kept
     * working only because the client still had them cached from when the
     * connector was added, and nothing ever learned about the UI resource or
     * the tool `_meta` that binds it. That is why no panel ever rendered.
     *
     * Shape differs from initialize: serverInfo moves into `_meta`, and a list
     * of `supportedVersions` replaces the single negotiated `protocolVersion`.
     */
    case "server/discover":
      return ok(body.id, {
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: SERVER_INFO.name,
            title: SERVER_INFO.name,
            version: SERVER_INFO.version,
          },
        },
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: serverCapabilities(),
        instructions: hosted.instructions,
      });

    case "notifications/initialized":
      return withCors(new Response(null, { status: 202 }));

    case "tools/list":
      // PROTOTYPE: the MCP Apps tool rides alongside the explore surface.
      return ok(body.id, {
        tools: [
          ...hosted.descriptors,
          ...dashboardTools(env.INSTANCE_NAME),
        ],
      });

    // PROTOTYPE: MCP Apps (the extension MotherDuck's view_dive uses). The
    // HTML below is loaded into a sandboxed iframe by the client and driven
    // over postMessage — see src/lib/mcp-app.ts.
    case "resources/list":
      return ok(body.id, { resources: [{ uri: panelUri(), name: panelUri(), mimeType: APP_MIME_TYPE }] });

    case "resources/read": {
      const uri = String((body.params ?? {}).uri ?? "");
      if (isPanelUri(uri)) {
        // One shell for every dashboard and every user — so it is public, and
        // long-lived because the URI already changes whenever the shell does.
        // A dashboard edit does NOT change it: the bundle arrives separately,
        // which is what spares clients a reconnect per dashboard change.
        return ok(body.id, {
          contents: [{ uri, mimeType: APP_MIME_TYPE, text: panelHtml() }],
          ttlMs: 3_600_000,
          cacheScope: "public",
        });
      }
      return err(body.id, -32002, `resource not found: ${uri}`);
    }

    case "resources/templates/list":
      return ok(body.id, { resourceTemplates: [] });

    case "tools/call": {
      const params = body.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const start = Date.now();
      log.info("mcp tool call", { tool: name });
      try {
        // The app tool is one fixed query, run through the instance's own
        // query surface — same Malloy path, real data, no arguments to get
        // wrong. Its `_meta.ui.resourceUri` is what makes a host render it.
        // Static for now — see staticDashboardResult(). Set DASHBOARD_LIVE_QUERY=1
        // to run the real Malloy query instead, once /mcp's query path is not
        // 20x slower than /api/run for the same text.
        // The panel's own query button: a real Malloy run, on demand.
        if (name === SHOW_TOOL) {
          // Names the dashboard for the panel; the panel fetches its bundle.
          //
          // Accept the app-only tools' spellings too. Clients cache tool
          // schemas hard and do not re-read them, so a caller working from a
          // stale definition guesses — and answering "" for a missing argument
          // is the least debuggable thing this can do. Aliases cost nothing;
          // a silent empty result costs a round trip to discover.
          const dataset = String(args.dataset ?? args.datasetId ?? "");
          const dash = String(args.dashboard ?? args.name ?? "");
          if (!dataset || !dash) {
            log.info("mcp tool error", { tool: name, reason: "missing arguments" });
            return ok(body.id, {
              content: [
                {
                  type: "text",
                  text:
                    "show_dashboard needs `dataset` and `dashboard`. Call list_sources " +
                    "to see what is available. (If your tool definition shows no " +
                    "parameters, it is cached — reconnect the server.)",
                },
              ],
              structuredContent: { ok: false, error: "dataset and dashboard are required" },
              isError: true,
            });
          }
          log.info("mcp tool ok", { tool: name, durationMs: Date.now() - start });
          return ok(body.id, {
            content: [{ type: "text", text: `Opened the '${dash}' dashboard above.` }],
            structuredContent: { ok: true, datasetId: dataset, name: dash },
          });
        }
        if (name === BUNDLE_TOOL) {
          const payload = await dashboardBundlePayload(user.id, {
            datasetId: String(args.datasetId ?? ""),
            name: String(args.name ?? ""),
          });
          log.info("mcp tool ok", { tool: name, durationMs: Date.now() - start });
          return ok(body.id, {
            content: [{ type: "text", text: payload.ok ? payload.title : payload.error }],
            structuredContent: payload as unknown as Record<string, unknown>,
          });
        }
        if (name === RUN_TOOL) {
          const out = await runDashboard(
            user.id,
            String(args.datasetId ?? ""),
            String(args.name ?? ""),
            { query: args.query as string | undefined, malloy: args.malloy as string | undefined },
            (args.givens ?? {}) as Record<string, unknown>,
          );
          log.info("mcp tool ok", { tool: name, durationMs: Date.now() - start });
          return ok(body.id, {
            content: [{ type: "text", text: out.ok ? "ok" : `error: ${out.error}` }],
            structuredContent: out as unknown as Record<string, unknown>,
          });
        }
                        // Dashboards are part of what a dataset IS, so they ride along with
        // list_sources rather than needing a tool of their own. Discovery then
        // costs the model nothing extra, and the tool list does not grow with
        // the dashboard count.
        if (name === "list_sources") {
          const base = (await hosted.call(name, args)) as {
            content?: { type: string; text: string }[];
            structuredContent?: Record<string, unknown>;
          };
          const dashboards = (await listAllDashboards(user.id)).map((d) => ({
            dataset: d.datasetName ?? d.datasetId,
            name: d.name,
            title: d.title,
          }));
          const note =
            dashboards.length === 0
              ? ""
              : "\n\nDashboards (render inline with show_dashboard):\n" +
                dashboards.map((d) => `  ${d.dataset} / ${d.name} — ${d.title}`).join("\n");
          log.info("mcp tool ok", { tool: name, durationMs: Date.now() - start });
          return ok(body.id, {
            ...base,
            content: [
              ...(base.content ?? []),
              ...(note ? [{ type: "text", text: note }] : []),
            ],
            ...(base.structuredContent
              ? { structuredContent: { ...base.structuredContent, dashboards } }
              : { structuredContent: { dashboards } }),
          });
        }
        const result = await hosted.call(name, args);
        log.info("mcp tool ok", { tool: name, durationMs: Date.now() - start });
        return ok(body.id, result);
      } catch (e) {
        log.error("mcp tool error", { tool: name, durationMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) });
        return err(body.id, -32000, e instanceof Error ? e.message : String(e));
      }
    }

    case "ping":
      return ok(body.id, {});

    default:
      return err(body.id, -32601, `method not found: ${body.method}`);
  }
}

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
 */
export async function GET(req: Request) {
  // No auth needed to answer, but Streamable HTTP clients send their bearer
  // token when opening the stream — resolve it purely so the log names who is
  // behind any residual traffic. Two indexed lookups (credential, then user),
  // and deliberately no last_used_at write: opening a stream is not a use.
  const raw = bearerToken(req);
  const resolved = raw ? await resolveBearer(raw, { scope: "mcp", recordUse: false }) : null;
  logger.info("mcp GET", {
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
