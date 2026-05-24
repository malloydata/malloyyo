import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// All auth is handled by Google OAuth at the route level.
// This proxy just ensures OAuth/MCP discovery routes are never blocked.
export function proxy(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
