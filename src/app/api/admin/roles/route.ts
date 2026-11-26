// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The role catalog, and what each role opens. One POST with an `action`,
// matching /api/admin/users next door; the rules live in src/lib/roles.ts so
// this route stays a thin shell over them.

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, datasets, givens, instanceSettings, roles, users } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { hostedSignIn } from "@/lib/hosted-auth-integration";
import { UnauthorizedError } from "@/lib/user";
import { env } from "@/lib/env";
import {
  isBuiltinRole,
  isEnvAdmin,
  MALLOYYO_ADMIN,
  deleteRole,
  NEVER_A_DEFAULT,
  roleLevelUpdate,
  roleNameError,
  rolesOf,
} from "@/lib/roles";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // Revoked everywhere it lives, in one transaction: `deleteRole`.
      await deleteRole(name);
      logger.info("role deleted", { name, actorId: actor.id });
      break;
    }

    case "set-level": {
      // What ONE role gets on ONE dataset: none, view (dashboards only) or
      // query (full). The unit Admin → Roles edits, one switch at a time.
      //
      // Stored as two arrays on the dataset — `roles` (any access) and
      // `view_only_roles` (the subset that may only view); see `DatasetAccess`
      // and `roleLevelUpdate` in src/lib/roles.ts, which is the one writer.
      const datasetId = typeof body?.datasetId === "string" ? body.datasetId : "";
      const level = body?.level;
      if (!UUID_RE.test(datasetId)) return bad("datasetId is required");
      if (level !== "none" && level !== "view" && level !== "query") {
        return bad("level must be none, view or query");
      }
      // An admin opens every dataset in full, by rule rather than by grant.
      // Offering a switch here would be offering a choice that does not exist.
      if (name === MALLOYYO_ADMIN) return bad("MALLOYYO_ADMIN always has full access to every dataset");
      const [known] = await db.select({ name: roles.name }).from(roles).where(eq(roles.name, name));
      if (!known) return bad(`unknown role: ${name || "(none)"}`);

      const changed = await db
        .update(datasets)
        .set(roleLevelUpdate(name, level))
        // Ready datasets only, because that is what the page offers — the same
        // rule the list it replaced had.
        .where(and(eq(datasets.id, datasetId), eq(datasets.status, "ready")))
        .returning({ id: datasets.id });
      if (changed.length === 0) return bad("no such dataset", 404);
      logger.info("role level set", { name, datasetId, level, actorId: actor.id });
      break;
    }

    case "set-user-roles": {
      const userId = typeof body?.userId === "string" ? body.userId : null;
      if (!userId) return bad("userId is required");
      const wanted = Array.isArray(body?.roles) ? (body.roles as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const known = await db.select({ name: roles.name }).from(roles).where(inArray(roles.name, wanted.length ? wanted : [""]));
      const unknown = wanted.filter((r) => !known.some((k) => k.name === r));
      if (unknown.length) return bad(`unknown role(s): ${unknown.join(", ")}`);

      const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) return bad("no such user", 404);

      // The same two guardrails /admin/users has, because this surface writes the
      // same authority and the safe failure is refusal. Without them this route
      // was strictly looser than the older one beside it.
      if (target.role === "owner") return bad("the owner's roles cannot be changed here");
      const next = new Set(wanted);
      const losingAdmin = !next.has(MALLOYYO_ADMIN) && rolesOf(target).includes(MALLOYYO_ADMIN);
      if (losingAdmin && target.id === actor.id) {
        return bad("you cannot revoke your own admin role");
      }
      // An env-granted admin cannot be revoked by any write to this row, so
      // saying "done" would be a lie the UI then renders as unticked.
      if (losingAdmin && isEnvAdmin(target.email)) {
        return bad(
          `${target.email} is an admin because APP_ADMIN_EMAILS names them. Remove the address from that variable and redeploy.`,
        );
      }

      // WHERE THIS PERSON'S ADMIN COMES FROM decides what may be written.
      //
      // `rolesOf()` reports MALLOYYO_ADMIN for someone who holds it in any of
      // three places, and the page sends back the list it was shown — so
      // editing any OTHER role for an admin arrives here carrying it. Writing
      // it into the role list is right only when the row is where it lives:
      //
      //   - APP_ADMIN_EMAILS names them: it lives in the environment. Written
      //     here it would outlast the address being taken out of the variable.
      //   - An integration owns sign-in and mirrors the provider's admin flag
      //     into `role` / `is_admin` on every sign-in: it lives at the provider.
      //     Written here it would outlast being revoked there — the sign-in
      //     mirror resets those two columns and never touches the list.
      //
      // In both cases it is left where it is. (On an ordinary instance the two
      // legacy columns ARE the row's own record, and move with the list below.)
      const hosted = hostedSignIn();
      const inList = (target.roles ?? []).includes(MALLOYYO_ADMIN);
      const legacyAdmin = target.role === "admin" || target.isAdmin === true;
      const providerAdmin = hosted && legacyAdmin;
      if (losingAdmin && providerAdmin) {
        return bad(
          `${target.email ?? "This person"} is an admin at the identity provider this instance signs in with. Remove it there; it cannot be taken away here.`,
        );
      }
      const heldOnRow = inList || (!hosted && legacyAdmin);
      if (!heldOnRow && (isEnvAdmin(target.email) || providerAdmin)) next.delete(MALLOYYO_ADMIN);

      // The legacy columns move WITH the list — on an instance that owns its
      // own sign-in. `rolesOf()` still folds `role`/`is_admin` in (every row
      // backfilled by 0021 kept them), so writing only the list made un-ticking
      // MALLOYYO_ADMIN a no-op that reported success, and ticking it produced
      // an admin whom `applyUserAction('demote')` then refused as "not an
      // admin". Where an integration owns sign-in those two columns are its
      // mirror of the provider and are not this route's to write: a grant made
      // here lives in the list alone.
      const gainingAdmin = next.has(MALLOYYO_ADMIN);
      await db
        .update(users)
        .set({
          roles: [...next],
          ...(hosted
            ? {}
            : gainingAdmin
              ? { role: "admin" as const, isAdmin: true }
              : legacyAdmin
                ? { role: "member" as const, isAdmin: false }
                : {}),
        })
        .where(eq(users.id, userId));
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
      // Validated like its siblings — it was the one action that checked nothing,
      // so a typo became a role written onto every new arrival that no checkbox
      // could show and `set-user-roles` would then reject as unknown.
      if (wanted.length > 0) {
        const known = await db.select({ name: roles.name }).from(roles).where(inArray(roles.name, wanted));
        const unknown = wanted.filter((r) => !known.some((k) => k.name === r));
        if (unknown.length) return bad(`unknown role(s): ${unknown.join(", ")}`);
      }
      // And these two are never an admission default. On an `open` instance the
      // default is applied to every new row at first sign-in, so MALLOYYO_ADMIN
      // here makes anyone who signs in an admin — the widest possible reading of
      // one checkbox. Refused server-side, not merely hidden in the UI.
      const privileged = wanted.filter((r) => NEVER_A_DEFAULT.includes(r));
      if (privileged.length) {
        return bad(
          `${privileged.join(", ")}: cannot be given to new arrivals automatically — on an open instance that grants it to anyone who signs in. Grant it per person instead.`,
        );
      }
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
        "expected action: create | delete | set-level | set-user-roles | set-dataset-givens | set-default",
      );
  }

  return NextResponse.json({ ok: true });
}
