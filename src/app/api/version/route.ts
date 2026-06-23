// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Public, unauthenticated "what code are you?" endpoint. Mirrors the version
// reported in the MCP initialize handshake (serverInfo.version) so a running
// instance can be identified without an MCP client. INSTANCE_NAME disambiguates
// which deployment answered (multiple instances can be connected at once).
import { NextResponse } from "next/server";
import { VERSION } from "@/lib/version";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ name: env.INSTANCE_NAME, version: VERSION });
}
