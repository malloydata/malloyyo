// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// POST /api/ask — a question in, a run query out.
//
// The model writes the Malloy (src/lib/ask.ts); THIS route runs the answer, in
// full, through the same runQueryForWeb the Run button uses — the loop's own
// runs are row-capped and slugless, so what the user sees is a real one and not
// the truncated one the model looked at. Running it here
// rather than handing the text back for the browser to submit is what keeps
// authorship honest: resolveLtoolAuthor would stamp a query arriving from the
// editor as 'human', and a client claiming otherwise is a client claiming
// authorship — not something to take its word for. The one place that knows a
// model wrote this query is the process that asked it to.
//
// Response is the /api/run shape plus `malloy` and `model`, so the client can
// drop it straight into the editor and the result panel.

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { askEnabled, askForMalloy } from "@/lib/ask";
import { runQueryForWeb } from "@/lib/mcp-tools";
import { originFromRequest } from "@/lib/oauth/base-url";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Step-capped, but each turn waits on a model AND a Malloy run, so this is
// comfortably slower than a plain query — 30-60s is normal.
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!askEnabled()) {
    return NextResponse.json(
      { error: "Ask is not configured on this instance." },
      { status: 503 },
    );
  }

  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    throw err;
  }

  let body: {
    source?: string;
    question?: string;
    dataset?: string | null;
    currentMalloy?: string | null;
    maxRows?: number;
    model?: string;
    effort?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const source = body.source?.trim() ?? "";
  const question = body.question?.trim() ?? "";
  if (!source || !question) {
    return NextResponse.json(
      { error: "source and question are required" },
      { status: 400 },
    );
  }

  const userAgent = req.headers.get("user-agent");
  const started = Date.now();

  const asked = await askForMalloy({
    user,
    baseUrl: originFromRequest(req),
    source,
    dataset: body.dataset ?? null,
    question,
    currentMalloy: body.currentMalloy ?? null,
    userAgent,
    // Validated against the offered list in ask.ts, not trusted as sent.
    model: body.model,
    effort: body.effort,
  });

  // What ran and what it cost — on the response as a nested object the client
  // reads, and on the log flattened, so a log search can filter on the fields
  // directly instead of digging into a serialized object.
  //
  // The DOLLAR figure goes only to admins, and is withheld here rather than
  // merely hidden in the UI: it is the operator's spend on the operator's key,
  // and a number that must not be shown should not be in the payload at all.
  // Turns and tokens still go to everyone — they describe the work done on your
  // question, which is yours to see. The log always carries the cost.
  const report = {
    model: asked.model,
    effort: asked.effort,
    steps: asked.steps,
    usage: asked.usage,
    ...(isAdmin(user) ? { costUsd: asked.costUsd } : {}),
  };
  const logged = { ...report, usage: undefined, costUsd: asked.costUsd, ...asked.usage };

  if (!asked.ok) {
    logger.info("ask failed", {
      userId: user.id,
      durationMs: Date.now() - started,
      ...logged,
    });
    // 422, not 500: the request was well-formed and the service worked — the
    // model just couldn't answer this question about this source. Usage rides
    // along: a failed ask still spent tokens, and hiding that is how an
    // instance-wide key becomes a surprise.
    return NextResponse.json({ error: asked.error, ...report }, { status: 422 });
  }

  // The single execution. Recorded, slugged, shareable, and attributed to the
  // model that wrote it — everything a Run-button query gets.
  const result = await runQueryForWeb(
    user.id,
    source,
    asked.malloy,
    body.maxRows ?? 1000,
    body.dataset ?? null,
    // Title from the model's own synopsis of the query it settled on, falling
    // back to what was typed. Both describe the same thing, but the synopsis
    // describes the QUERY ("Top products in NY by total sales") where the typed
    // question describes the asking ("can you show me the top products in
    // NY?") — and this string is a row in a shared list, not a chat message.
    { userAgent, authorModel: asked.model, question: asked.question ?? question, entrypoint: "ask" },
  );

  logger.info("ask", {
    userId: user.id,
    durationMs: Date.now() - started,
    ran: result.ok,
    ...logged,
  });

  if (!result.ok) {
    // The loop said this compiles, so a failure here is a run-time one (a
    // warehouse error, a timeout). Return the Malloy anyway — the user should
    // see what was written, in the editor, rather than only an error.
    return NextResponse.json({ error: result.error, malloy: asked.malloy, ...report }, { status: 400 });
  }

  // `question` is the model's synopsis, which the client uses as the row title
  // — it is NOT part of `result` (runQueryForWeb returns the run, not its
  // label), so it has to be sent explicitly.
  return NextResponse.json({
    ...result,
    malloy: asked.malloy,
    question: asked.question,
    ...report,
  });
}
