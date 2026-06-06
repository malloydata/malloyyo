import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { logger } from "@/lib/logger";

// Routes that must never be blocked — OAuth discovery, MCP, and auth itself.
const ALWAYS_ALLOW = /^\/(api\/auth|api\/oauth|\.well-known|mcp|oauth\/consent)/;

// Origins allowed to make credentialed cross-origin requests (cookies attached).
// Wildcards cannot be used with credentials, so these must be explicit.
const CREDENTIALED_ORIGINS = new Set(["https://claude.ai"]);

const CREDENTIALED_CORS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Vary": "Origin",
};

function applyCors(res: NextResponse, origin: string): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", origin);
  for (const [k, v] of Object.entries(CREDENTIALED_CORS)) res.headers.set(k, v);
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin") ?? "";
  const isCredentialedOrigin = CREDENTIALED_ORIGINS.has(origin);

  // Handle OPTIONS preflight for credentialed origins before any auth logic.
  if (isCredentialedOrigin && req.method === "OPTIONS") {
    return applyCors(new NextResponse(null, { status: 204 }), origin);
  }

  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  logger.info("request", { requestId, method: req.method, path: pathname, ip });

  // Propagate requestId so route handlers can correlate logs.
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const next = () => {
    const res = NextResponse.next({ request: { headers } });
    return isCredentialedOrigin ? applyCors(res, origin) : res;
  };

  if (ALWAYS_ALLOW.test(pathname)) return next();

  const allowList = process.env.EMAIL_ALLOW_LIST;
  if (!allowList) return next();

  const session = await auth();
  if (!session?.user?.email) return next(); // not signed in — let route handle it

  const allowed = allowList.split(",").map((e) => e.trim().toLowerCase());
  if (!allowed.includes(session.user.email.toLowerCase())) {
    // Signed in but not allowed — sign them out and redirect to home.
    logger.warn("access denied", { requestId, userId: session.user.id });
    const signOutUrl = new URL("/api/auth/signout", req.url);
    signOutUrl.searchParams.set("callbackUrl", "/");
    return NextResponse.redirect(signOutUrl);
  }

  return next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
