// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Reading and writing chats. A chat belongs to ONE person; `ownedChat` is the
// single place that decides so, and nothing else in this file re-derives it.
//
// A chat may also be made public, which grants READING and nothing else —
// `readableChat` is that rule, and it is deliberately a separate function from
// `ownedChat` rather than a flag on it. Everything that writes (asking a
// question, renaming, deleting, publishing) goes on calling `ownedChat`, so a
// public chat cannot be added to: it stays one person's conversation instead of
// turning into a room nobody owns.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db, chats, chatMessages, chatResults, datasets, type Chat } from "@/db";
import { resolveDatasetRef } from "@/lib/repos";

/** Is the dataset this chat was held on one anyone may see?
 *
 *  Resolved through `resolveDatasetRef`, not by a select on `datasets.name`.
 *  `chats.dataset` is whatever the link that opened the chat put in
 *  `?dataset=`, and those links now carry the qualified `repo:dataset` — so the
 *  column holds BOTH spellings and a name match saw only the older half.
 *
 *  Both directions were wrong. A chat started from the home page on
 *  `acme:orders` matched nothing, so sharing it was refused with "that is a
 *  private dataset" about a public one, and an already-published chat became
 *  unreadable to everyone but its owner. The other direction is worse: for a
 *  bare `orders` with two ready rows — one repo's public, another's private —
 *  the select was unordered and unscoped, so a PRIVATE chat's publishability
 *  could be decided by the public namesake's flag, and `readableChat` would
 *  then serve its messages to every signed-in user. The old comment claimed
 *  the `status = 'ready'` pin prevented exactly that; once names stopped being
 *  unique per server, it did not.
 *
 *  A ref that no longer resolves — an ambiguous bare name, or a deleted
 *  dataset — is not public, which is the safe answer for a sharing gate. */
async function datasetIsPublic(ref: string): Promise<boolean> {
  const resolved = await resolveDatasetRef(ref);
  if (!resolved.ok) return false;
  return resolved.dataset.isPublic === true;
}

/** The chat if this user owns it, else null. Absent and not-yours look the same
    on purpose — a probe must not be able to tell them apart. */
export async function ownedChat(id: string, userId: string): Promise<Chat | null> {
  const [row] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** The chat if this user may READ it: theirs, or one someone published.
 *
 *  Returns who is asking along with it, because every caller needs to know —
 *  a reader gets no composer and no controls. */
export async function readableChat(
  id: string,
  userId: string,
): Promise<{ chat: Chat; mine: boolean } | null> {
  const [row] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  if (!row) return null;
  if (row.userId === userId) return { chat: row, mine: true };
  if (!row.isPublic) return null;
  // Re-checked on every read, not just when it was published. `is_public` is a
  // claim made at one moment, and the dataset can be made private afterwards —
  // at which point this chat's stored ROWS would go on being served to everyone
  // signed in, which is precisely what publishing is gated on preventing.
  return (await datasetIsPublic(row.dataset)) ? { chat: row, mine: false } : null;
}

/** Whether this chat may be published: its dataset must be public. Exported so
    the route asks the same question the reader path answers. */
export async function chatIsPublishable(chat: Chat): Promise<boolean> {
  return datasetIsPublic(chat.dataset);
}

/** Publish or unpublish. Owner only — a reader of a public chat cannot pass it
    on, and cannot take it back either. */
export async function setChatPublic(
  id: string,
  userId: string,
  isPublic: boolean,
): Promise<Chat | null> {
  const [row] = await db
    .update(chats)
    .set({ isPublic })
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .returning();
  return row ?? null;
}

export async function listChats(userId: string, limit = 100) {
  return db
    .select({
      id: chats.id,
      dataset: chats.dataset,
      source: chats.source,
      title: chats.title,
      isPublic: chats.isPublic,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.updatedAt))
    .limit(limit);
}

export async function createChat(params: {
  userId: string;
  dataset: string;
  source: string;
  model?: string | null;
  effort?: string | null;
}): Promise<Chat> {
  const [row] = await db
    .insert(chats)
    .values({
      userId: params.userId,
      dataset: params.dataset,
      source: params.source,
      model: params.model ?? null,
      effort: params.effort ?? null,
    })
    .returning();
  return row;
}

export async function deleteChat(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .returning({ id: chats.id });
  return rows.length > 0;
}

/** A chat's messages in order. This is what gets replayed to the model, so it is
    the stored content-block arrays and nothing else. */
export async function loadMessages(chatId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.seq));
  return rows.map((r) => ({
    role: r.role as Anthropic.MessageParam["role"],
    content: r.content as Anthropic.MessageParam["content"],
  }));
}

/** Everything the SCREEN needs: the same messages, plus the rendered results
    keyed by the tool_use id that produced them. */
export async function loadForDisplay(chatId: string) {
  const [messages, results] = await Promise.all([
    db
      .select({ seq: chatMessages.seq, role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.seq)),
    db
      .select()
      .from(chatResults)
      .where(eq(chatResults.chatId, chatId)),
  ]);
  return { messages, results };
}

/** Append messages to a chat, continuing its sequence.
 *
 * `seq` is read and written in one call rather than counted client-side: two
 * turns racing on the same chat would otherwise collide on the unique index,
 * which is exactly what that index is for. */
export async function appendMessages(
  chatId: string,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  if (messages.length === 0) return;
  const [last] = await db
    .select({ seq: chatMessages.seq })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.seq))
    .limit(1);
  const base = (last?.seq ?? -1) + 1;
  await db.insert(chatMessages).values(
    messages.map((m, i) => ({
      chatId,
      seq: base + i,
      role: m.role,
      content: m.content as unknown as object,
    })),
  );
}

export type StoredResult = {
  malloy: string;
  sql: string;
  rowCount: number;
  slug: string | null;
  stableResult: unknown;
};

/** Save the rendered results of one exchange, keyed by tool_use id.
 *
 * onConflictDoNothing because a retried write must not fail the turn that
 * produced it — the result is already there and identical. */
export async function saveResults(
  chatId: string,
  results: Map<string, StoredResult>,
): Promise<void> {
  if (results.size === 0) return;
  await db
    .insert(chatResults)
    .values(
      [...results].map(([toolUseId, r]) => ({
        toolUseId,
        chatId,
        malloy: r.malloy,
        sql: r.sql,
        rowCount: r.rowCount,
        slug: r.slug,
        stableResult: r.stableResult as object,
      })),
    )
    .onConflictDoNothing();
}

/** Bump `updated_at` so the chat rises in the list, and set the title from the
    first question if it has none. */
export async function touchChat(
  chatId: string,
  opts: { title?: string | null; model?: string | null; effort?: string | null } = {},
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (opts.model) set.model = opts.model;
  if (opts.effort) set.effort = opts.effort;
  if (opts.title) set.title = opts.title;
  await db.update(chats).set(set).where(eq(chats.id, chatId));
}

/** Delete every chat in the list, for the test's cleanup. */
export async function deleteChats(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(chats).where(inArray(chats.id, ids));
}
