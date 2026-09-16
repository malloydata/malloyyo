// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { buildHostedExploreSurface } from "@/lib/mcp-host";
import {
  APP_MIME_TYPE,
  DASHBOARD_APP_URI,
  UI_EXTENSION_ID,
  callDashboardApp,
  dashboardAppResource,
  dashboardAppResourceContents,
  dashboardAppTool,
  isDashboardAppTool,
} from "@/lib/mcp-app";
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
        tools: [...hosted.descriptors, dashboardAppTool(`[${env.INSTANCE_NAME}]`)],
      });

    // PROTOTYPE: MCP Apps (the extension MotherDuck's view_dive uses). The
    // HTML below is loaded into a sandboxed iframe by the client and driven
    // over postMessage — see src/lib/mcp-app.ts.
    case "resources/list":
      return ok(body.id, { resources: [dashboardAppResource()] });

    case "resources/read": {
      const uri = String((body.params ?? {}).uri ?? "");
      if (uri !== DASHBOARD_APP_URI) return err(body.id, -32002, `resource not found: ${uri}`);
      return ok(body.id, {
        contents: [dashboardAppResourceContents()],
      });
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
        const result = isDashboardAppTool(name)
          ? callDashboardApp(args)
          : await hosted.call(name, args);
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
