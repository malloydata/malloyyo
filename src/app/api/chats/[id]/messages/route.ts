// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// POST /api/chats/[id]/messages — ask something; the answer streams back.
//
// Server-Sent Events rather than one JSON response. A turn runs 15-60s (a model
// call plus Malloy execution, repeatedly), and a minute of silence reads as a
// hang. Streaming is most of what makes it feel like a conversation rather than
// a form submission.
//
// The exchange is persisted when the loop finishes, from what it returns — not
// written incrementally as events go out. A half-written turn is not a
// conversation anyone can replay to the model.

import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { askEnabled } from "@/lib/ask";
import { runChatTurn, type ChatEvent } from "@/lib/chat/loop";
import { appendMessages, loadMessages, ownedChat, saveResults, touchChat } from "@/lib/chat/store";
import { originFromRequest } from "@/lib/oauth/base-url";
import { logger, serializeErr } from "@/lib/logger";

export const runtime = "nodejs";

// A conversation turn is a model call plus Malloy execution, several times over.
// Must comfortably exceed the longest single exchange; the loop's own step cap
// is what actually bounds it.
export const maxDuration = 300;

function sse(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!askEnabled()) {
    return Response.json({ error: "Chat is not configured on this instance." }, { status: 503 });
  }

  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "sign in required" }, { status: 401 });
    }
    throw err;
  }

  const { id } = await ctx.params;
  const chat = await ownedChat(id, user.id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });

  let body: { question?: string; model?: string; effort?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const question = body.question?.trim() ?? "";
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  const history = await loadMessages(id);
  const userMessage = { role: "user" as const, content: [{ type: "text" as const, text: question }] };
  // Persisted before the model runs. If the turn dies mid-way the question is
  // still in the transcript, which is what someone reloading expects to see.
  await appendMessages(id, [userMessage]);

  const admin = isAdmin(user);
  const started = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) => {
        // The dollar figure is the operator's spend on the operator's key, so it
        // is withheld here rather than hidden in the UI.
        const safe = e.type === "done" && !admin ? { ...e, costUsd: null } : e;
        try {
          controller.enqueue(encoder.encode(sse(safe)));
        } catch {
          // The client hung up mid-write. The abort signal ends the loop; there
          // is nothing to do here but stop trying to write.
        }
      };

      try {
        const outcome = await runChatTurn(
          {
            user,
            baseUrl: originFromRequest(req),
            dataset: chat.dataset,
            source: chat.source,
            messages: [...history, userMessage],
            model: body.model ?? chat.model ?? undefined,
            effort: body.effort ?? chat.effort ?? undefined,
            userAgent: req.headers.get("user-agent"),
            signal: req.signal,
          },
          send,
        );

        await appendMessages(id, outcome.appended);
        await saveResults(id, outcome.results);
        await touchChat(id, {
          // The first question names the chat. Trimmed to something that fits a
          // sidebar row rather than the whole paragraph someone may have typed.
          title: chat.title ?? question.slice(0, 120),
          model: outcome.model,
          effort: outcome.effort,
        });

        logger.info("chat turn", {
          userId: user.id,
          chatId: id,
          model: outcome.model,
          effort: outcome.effort,
          steps: outcome.steps,
          durationMs: Date.now() - started,
          costUsd: outcome.costUsd,
          ...outcome.usage,
        });
      } catch (e) {
        logger.error("chat turn failed", { chatId: id, error: serializeErr(e).message });
        send({ type: "error", message: "The conversation failed unexpectedly." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming at all.
      "x-accel-buffering": "no",
    },
  });
}
