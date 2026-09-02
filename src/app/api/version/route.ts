// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Public, unauthenticated "what code are you?" endpoint. Mirrors the version
// reported in the MCP initialize handshake (serverInfo.version) so a running
// instance can be identified without an MCP client. INSTANCE_NAME disambiguates
// which deployment answered (multiple instances can be connected at once).
//
// `sha` is the commit, when the build knows it. The version now moves on every
// merge and usually answers this on its own; the commit still separates two
// builds of the SAME version — a rebuild, or an image composed elsewhere. It was
// already rendered in the admin header, where it can only be read by a person
// with a browser; a deploy check wants it here. Absent rather than null when the
// build carries no commit, so a caller tests presence rather than a placeholder.
import { NextResponse } from "next/server";
import { VERSION, shortSha } from "@/lib/version";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  const sha = shortSha();
  return NextResponse.json({
    name: env.INSTANCE_NAME,
    version: VERSION,
    ...(sha ? { sha } : {}),
  });
}
