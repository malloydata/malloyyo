// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users } from "@/db";
import { eq } from "drizzle-orm";
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import { recordAccessTokenUse, validateAccessToken } from "@/lib/oauth/tokens";
import { isEmailAllowed } from "@/lib/user";
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

function ok(id: string | number | null | undefined, result: unknown) {
  return withCors(Response.json({ jsonrpc: "2.0", id: id ?? null, result }));
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
const SERVER_INFO = { name: env.INSTANCE_NAME, version: VERSION };

/** Bearer token from the Authorization header, or "" when absent/not Bearer. */
function bearerToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
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
  const validated = await validateAccessToken(raw);
  if (!validated.ok) {
    logger.info("mcp unauthorized", { requestId, reason: validated.reason });
    return unauthorized("Invalid or revoked token", req);
  }

  // Every log line from here on names the user and the OAuth client, so any
  // /mcp request can be attributed — not just the tool calls.
  const log = logger.child({ requestId, userId: validated.userId, clientId: validated.clientId });

  // Identify user from the token — no slug needed.
  const [user] = await db.select().from(users).where(eq(users.id, validated.userId)).limit(1);
  if (!user) {
    log.warn("mcp unauthorized", { reason: "user_not_found" });
    return unauthorized("Token user not found", req);
  }

  // Re-check the email allow-list on every call. The token alone proves the
  // user once authenticated; this ensures a user removed from EMAIL_ALLOW_LIST
  // loses MCP access immediately rather than at token expiry (up to 90 days).
  if (!isEmailAllowed(user.email)) {
    log.warn("mcp unauthorized", { reason: "not_allowed" });
    return unauthorized("Access revoked for this account", req);
  }

  // Fire-and-forget last_used_at update.
  void recordAccessTokenUse(validated.tokenHash);

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
    case "initialize":
      return ok(body.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: hosted.instructions,
      });

    case "notifications/initialized":
      return withCors(new Response(null, { status: 202 }));

    case "tools/list":
      return ok(body.id, { tools: hosted.descriptors });

    case "tools/call": {
      const params = body.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const start = Date.now();
      log.info("mcp tool call", { tool: name });
      try {
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

export async function GET(req: Request) {
  // GET /mcp needs no auth (it only returns the pointer text below), but MCP
  // Streamable HTTP clients open it for the server→client SSE stream and send
  // their bearer token. We don't serve a stream, so a client can settle into a
  // reconnect loop — resolving the token here is purely so the log names who
  // is behind that traffic. One indexed lookup, and no last_used_at write.
  const raw = bearerToken(req);
  const validated = raw ? await validateAccessToken(raw) : null;
  logger.info("mcp GET", {
    requestId: req.headers.get("x-request-id") ?? undefined,
    userId: validated?.ok ? validated.userId : undefined,
    clientId: validated?.ok ? validated.clientId : undefined,
    userAgent: req.headers.get("user-agent"),
  });
  return withCors(new Response(
    "POST JSON-RPC requests to this URL. See https://modelcontextprotocol.io",
    { status: 200 },
  ));
}
