// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Admin → Roles: what each role opens — None, Dashboards or Full on each
// dataset — and whether new users are given it.
//
// Only the roles. Who holds one is Admin → Users (each role links there,
// filtered to its people); a dataset's repo and row scoping are Admin →
// Datasets.

import { asc, eq } from "drizzle-orm";
import { db, datasets, repos, roles as rolesTable, users } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { defaultRoles, MALLOYYO_ADMIN, NEVER_A_DEFAULT, rolesOf } from "@/lib/roles";
import { qualifiedName } from "@/lib/repo-names";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { RolesPanel } from "./roles-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
  const me = await requireAdminPage();

  const [catalog, dsRows, people, fallback] = await Promise.all([
    db.select().from(rolesTable).orderBy(asc(rolesTable.builtin), asc(rolesTable.name)),
    // Ready datasets only. A failed or half-built row cannot be opened by
    // anyone, and listing it here means two rows with the same label and no
    // way to tell which is which.
    db
      .select({
        id: datasets.id,
        name: datasets.name,
        title: datasets.title,
        roles: datasets.roles,
        viewOnlyRoles: datasets.viewOnlyRoles,
        ownerId: datasets.userId,
        repoSlug: repos.slug,
      })
      .from(datasets)
      .leftJoin(repos, eq(repos.id, datasets.repoId))
      .where(eq(datasets.status, "ready"))
      .orderBy(asc(repos.slug), asc(datasets.name)),
    db.select().from(users).where(eq(users.status, "active")),
    defaultRoles(),
  ]);

  // Title for reading, the qualified NAME underneath. This page is where access
  // is decided, and titles are not unique — two repos may each publish a
  // "Sales", and a row you cannot tell apart is a level set on the wrong one.
  const allDatasets = dsRows.map((d) => ({
    id: d.id,
    name: qualifiedName(d.repoSlug, d.name),
    title: datasetTitle(d.name, d.title),
    roles: d.roles ?? [],
    viewOnlyRoles: d.viewOnlyRoles ?? [],
    ownerId: d.ownerId,
  }));
  const members = people.map((u) => {
    // `rolesOf`, not the bare column: it folds in the older ways of being an
    // admin, so this page and every access check name the same people.
    const held = rolesOf(u);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      roles: held,
      isAdmin: held.includes(MALLOYYO_ADMIN),
      isOwner: u.role === "owner",
      isSelf: u.id === me.id,
      status: "active" as const,
      signedIn: u.firstSignedInAt !== null,
    };
  });

  return (
    <RolesPanel
      roles={catalog.map((r) => ({ name: r.name, description: r.description, builtin: r.builtin }))}
      datasets={allDatasets}
      people={members}
      defaults={fallback}
      neverDefault={NEVER_A_DEFAULT}
    />
  );
}
