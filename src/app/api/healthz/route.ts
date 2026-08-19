// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The **local** health signal: "is this process alive and did it start up
// correctly?" Performs no I/O — no database query, no provider call, no fetch.
//
// This is the route routine machinery may poll. Fly's service check hits it
// every 15 seconds on every hosted instance, and the hosted fleet's health
// reconciler reads the results of those checks. /api/health is the deep signal
// and answers a different question ("is this instance correctly connected to
// its dependencies?"), which is why it executes SELECT 1 — and why nothing on
// an interval may call it: a check that queries Postgres every 15 seconds holds
// a scale-to-zero database awake forever.
//
// The verdict this reports already exists. `migrationGateError()` is the same
// readiness gate /api/health applies; this route is that function plus a
// version string. It introduces no new state and no new failure mode.
//
// Not /api/version: that answers "what code are you", and it has to keep
// answering 200 during a failed startup, which is exactly when an operator
// needs it. Overloading identity with health would remove the one reliable
// diagnostic route at the worst possible moment.

import { NextResponse } from "next/server";
import { VERSION } from "@/lib/version";
import { migrationGateError } from "@/lib/migration-state";

export const dynamic = "force-dynamic";

export function GET() {
  // Readiness includes boot migrations when RUN_MIGRATIONS_ON_BOOT is set, so
  // this answers 503 for the whole boot window. That is intended: the Fly check
  // carries a grace period sized for it, and a Machine still applying its
  // migrations genuinely cannot serve.
  const gate = migrationGateError();
  if (gate) {
    // Status and version only, no reason. `gate` carries a driver message, and
    // this is the route a machine polls every 15 seconds — the place for the
    // detail is /api/health, which a person runs deliberately when they are
    // already looking at a specific instance.
    return NextResponse.json(
      { status: "failed_startup", version: VERSION },
      { status: 503 }
    );
  }
  return NextResponse.json({ status: "ok", version: VERSION });
}
