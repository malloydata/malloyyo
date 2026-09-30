// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The role catalog, and what each role opens. One POST with an `action`,
// matching /api/admin/users next door; the rules live in src/lib/roles.ts so
// this route stays a thin shell over them.

import { NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db, datasets, givens, instanceSettings, roles, users } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { UnauthorizedError } from "@/lib/user";
import { env } from "@/lib/env";
import { isBuiltinRole, roleNameError } from "@/lib/roles";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: Request) {
  let actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return bad(err.message, 403);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  switch (action) {
    case "create": {
      const problem = roleNameError(name);
      if (problem) return bad(problem);
      const description = typeof body?.description === "string" ? body.description.trim() : null;
      await db
        .insert(roles)
        .values({ name, description: description || null })
        .onConflictDoNothing();
      logger.info("role created", { name, actorId: actor.id });
      break;
    }

    case "delete": {
      if (isBuiltinRole(name)) return bad("built-in roles cannot be deleted");
      // Revoke it everywhere in the same breath. A role left on a user or a
      // dataset after its definition is gone is a grant nobody can see in the
      // UI and nobody thinks to audit.
      await db.transaction(async (tx) => {
        await tx.delete(roles).where(eq(roles.name, name));
        await tx.execute(sql`update ${users} set roles = array_remove(roles, ${name})`);
        await tx.execute(sql`update ${datasets} set roles = array_remove(roles, ${name})`);
      });
      logger.info("role deleted", { name, actorId: actor.id });
      break;
    }

    case "set-datasets": {
      // Which datasets this role opens, as a whole list — the UI sends the set
      // it wants, so a checkbox cleared in the browser is a dataset removed
      // here without a second action to forget.
      const wanted = Array.isArray(body?.datasetIds) ? (body.datasetIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (!name) return bad("name is required");
      await db.transaction(async (tx) => {
        const rows = await tx.select({ id: datasets.id, roles: datasets.roles }).from(datasets);
        for (const row of rows) {
          const held = row.roles ?? [];
          const should = wanted.includes(row.id);
          if (should === held.includes(name)) continue;
          const next = should ? [...held, name] : held.filter((r) => r !== name);
          await tx.update(datasets).set({ roles: next }).where(eq(datasets.id, row.id));
        }
      });
      logger.info("role datasets set", { name, count: wanted.length, actorId: actor.id });
      break;
    }

    case "set-user-roles": {
      const userId = typeof body?.userId === "string" ? body.userId : null;
      if (!userId) return bad("userId is required");
      const wanted = Array.isArray(body?.roles) ? (body.roles as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const known = await db.select({ name: roles.name }).from(roles).where(inArray(roles.name, wanted.length ? wanted : [""]));
      const unknown = wanted.filter((r) => !known.some((k) => k.name === r));
      if (unknown.length) return bad(`unknown role(s): ${unknown.join(", ")}`);
      await db.update(users).set({ roles: [...new Set(wanted)] }).where(eq(users.id, userId));
      logger.info("user roles set", { userId, roles: wanted, actorId: actor.id });
      break;
    }

    case "set-dataset-givens": {
      // What a dataset is scoped by. Configured here, not derived from whatever
      // a model happened to declare — and only names from the catalog, so a
      // typo cannot create a requirement nothing can ever satisfy.
      const datasetId = typeof body?.datasetId === "string" ? body.datasetId : null;
      if (!datasetId) return bad("datasetId is required");
      const wanted = Array.isArray(body?.givens)
        ? (body.givens as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (wanted.length > 0) {
        const known = await db.select({ name: givens.name }).from(givens).where(inArray(givens.name, wanted));
        const unknown = wanted.filter((g) => !known.some((k) => k.name === g));
        if (unknown.length) return bad(`unknown given(s): ${unknown.join(", ")}`);
      }
      await db.update(datasets).set({ requiredGivens: [...new Set(wanted)] }).where(eq(datasets.id, datasetId));
      logger.info("dataset givens set", { datasetId, givens: wanted, actorId: actor.id });
      break;
    }

    case "set-default": {
      const wanted = Array.isArray(body?.roles) ? (body.roles as unknown[]).filter((x): x is string => typeof x === "string") : [];
      await db
        .insert(instanceSettings)
        .values({ instanceCode: env.INSTANCE_CODE, defaultRoles: wanted })
        .onConflictDoUpdate({
          target: instanceSettings.instanceCode,
          set: { defaultRoles: wanted, updatedAt: new Date() },
        });
      logger.info("default roles set", { roles: wanted, actorId: actor.id });
      break;
    }

    default:
      return bad(
        "expected action: create | delete | set-datasets | set-user-roles | set-dataset-givens | set-default",
      );
  }

  return NextResponse.json({ ok: true });
}
