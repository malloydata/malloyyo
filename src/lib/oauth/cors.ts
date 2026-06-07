// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

const ALLOW_HEADERS = ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"].join(", ");
const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const EXPOSE_HEADERS = ["WWW-Authenticate", "Mcp-Session-Id"].join(", ");

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW_METHODS,
  "Access-Control-Allow-Headers": ALLOW_HEADERS,
  "Access-Control-Expose-Headers": EXPOSE_HEADERS,
  "Access-Control-Max-Age": "86400",
};

export function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
