// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Who sees which dashboard — the audience layer under dataset access
// (src/lib/dashboards/audience.ts, sharing.ts), against a real Postgres.
//
// DB-only on purpose: every function under test reads rows and decides, so the
// model here is never compiled and the artifacts are bare rows. What this pins:
//
//   • a draft is private until its author opens it; a modeled dashboard is
//     private when its manifest says so (`# artifact { private }`)
//   • private means admins + its author + the people it is shared with — in
//     every listing AND at the one lookup every route goes through
//   • sharing never opens a dataset: someone who cannot open the dataset still
//     sees nothing, and the share says so
//   • who may change an audience: a draft's author or an admin; a modeled
//     dashboard, admins only, and only its people (its privacy is the model's)
//
// Run via `npm run test:hosted`.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, users, datasets, malloyModels, malloyArtifacts, draftDashboards, dashboardGrants, type User } from "@/db";
import { allDashboardsByDataset, getDashboard, listDashboards, listDashboardsAndDrafts } from "@/lib/dashboards";
import { deleteDraft, getDraftFiles } from "@/lib/dashboards/draft";
import { getSharing, setDraftVisibility, shareDashboard, unshareDashboard } from "@/lib/dashboards/sharing";
import { canExplore, MALLOYYO_ADMIN, MALLOYYO_DASHBOARD_ONLY, MALLOYYO_USER } from "@/lib/roles";
import { createApiToken } from "@/lib/api-tokens";
import { resolveBearer } from "@/lib/bearer-auth";

const DS = "audience";
let admin: User, author: User, member: User, viewer: User, outsider: User;
let datasetId: string;

const person = async (email: string, roles: string[], extra: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ email, status: "active", roles, ...extra }).returning())[0];

const names = (list: { name: string }[]) => list.map((d) => d.name).sort();

before(async () => {
  // `staff` opens the dataset. The admin holds it too: MALLOYYO_ADMIN does not
  // open a dataset on these paths, and the point here is what an admin sees
  // INSIDE a dataset they can open.
  admin = await person("admin@aud.test", [MALLOYYO_USER, MALLOYYO_ADMIN, "staff"], { role: "admin", isAdmin: true });
  author = await person("author@aud.test", [MALLOYYO_USER, "staff"]);
  member = await person("member@aud.test", [MALLOYYO_USER, "staff"]);
  viewer = await person("viewer@aud.test", [MALLOYYO_DASHBOARD_ONLY, "staff"]);
  outsider = await person("outsider@aud.test", [MALLOYYO_USER]);

  const [ds] = await db
    .insert(datasets)
    .values({ userId: admin.id, name: DS, status: "ready", isPublic: false, roles: ["staff"] })
    .returning();
  datasetId = ds.id;
  const [model] = await db
    .insert(malloyModels)
    .values({
      datasetId,
      version: 1,
      source: "source: s is duckdb.sql(\"select 1 as n\")\n",
      generatedBy: "test",
      compiledAt: new Date(),
      sources: [{ name: "s", description: null }],
    })
    .returning();
  await db.insert(malloyArtifacts).values([
    { modelId: model.id, name: "open", title: "Open", manifest: { title: "Open", query: "q" }, source: "" },
    {
      modelId: model.id,
      name: "secret",
      title: "Secret",
      // What artifactManifest writes for `# artifact { private }`.
      manifest: { title: "Secret", query: "q", private: true },
      source: "",
    },
  ]);
  const draft = (slug: string, visibility?: "private" | "dataset") => ({
    slug,
    userId: author.id,
    datasetId,
    modelId: model.id,
    name: slug,
    title: slug,
    manifest: { title: slug },
    malloy: "",
    source: "export default () => null",
    ...(visibility ? { visibility } : {}),
  });
  // `mine` takes the column default — which is the claim: a new draft is private.
  await db.insert(draftDashboards).values([draft("mine"), draft("everyones", "dataset")]);
});

test("a draft saved without a visibility is private", async () => {
  const [row] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, "mine"));
  assert.equal(row.visibility, "private");
});

test("a listing shows each person what they may open, and nothing else", async () => {
  // Everyone on the dataset: the open dashboard and the draft opened to it.
  assert.deepEqual(names(await listDashboardsAndDrafts(member.id, DS)), ["draft-everyones", "open"]);
  // Its author also sees their own private draft — but not the private modeled one.
  assert.deepEqual(names(await listDashboardsAndDrafts(author.id, DS)), ["draft-everyones", "draft-mine", "open"]);
  // An admin sees all of it.
  assert.deepEqual(names(await listDashboardsAndDrafts(admin.id, DS)), [
    "draft-everyones",
    "draft-mine",
    "open",
    "secret",
  ]);
  // The model's own list (the switcher inside a dashboard) follows the same rule.
  assert.deepEqual(names(await listDashboards(member.id, DS)), ["open"]);
  assert.deepEqual(names(await listDashboards(admin.id, DS)), ["open", "secret"]);
  // And the all-datasets tree, which is a separate query path.
  const tree = await allDashboardsByDataset(member.id);
  assert.deepEqual(names(tree.byDataset.get(datasetId) ?? []), ["draft-everyones", "open"]);
  const adminTree = await allDashboardsByDataset(admin.id);
  assert.equal((adminTree.byDataset.get(datasetId) ?? []).length, 4);
});

test("a listing marks what is private, for the people who can see it", async () => {
  const byName = new Map((await listDashboardsAndDrafts(admin.id, DS)).map((d) => [d.name, d.isPrivate]));
  assert.deepEqual(Object.fromEntries(byName), {
    open: undefined,
    secret: true,
    "draft-mine": true,
    "draft-everyones": undefined,
  });
});

test("the lookup every route uses refuses a private dashboard as not-found", async () => {
  assert.equal(await getDashboard(member.id, DS, "secret"), null);
  assert.equal(await getDashboard(member.id, DS, "draft-mine"), null);
  assert.ok(await getDashboard(member.id, DS, "open"));
  assert.ok(await getDashboard(member.id, DS, "draft-everyones"));
  assert.ok(await getDashboard(author.id, DS, "draft-mine"));
  assert.ok(await getDashboard(admin.id, DS, "secret"));
  assert.ok(await getDashboard(admin.id, DS, "draft-mine"));
  // A private draft's FILES are as private as the draft.
  assert.equal(await getDraftFiles(member.id, DS, "mine"), null);
  assert.ok(await getDraftFiles(author.id, DS, "mine"));
});

test("an admin shares a private modeled dashboard with one person", async () => {
  const shared = await shareDashboard(admin, DS, "secret", "  Member@AUD.test ");
  assert.ok(shared.ok, "address is matched case-insensitively and trimmed");
  if (!shared.ok) return;
  assert.equal(shared.value.warning, undefined);
  assert.deepEqual(
    shared.value.people.map((p) => p.email),
    ["member@aud.test"],
  );

  assert.ok(await getDashboard(member.id, DS, "secret"));
  assert.deepEqual(names(await listDashboards(member.id, DS)), ["open", "secret"]);
  // Shared with them — not with everyone.
  assert.equal(await getDashboard(author.id, DS, "secret"), null);
  // Sharing twice is one share.
  assert.ok((await shareDashboard(admin, DS, "secret", "member@aud.test")).ok);
  const rows = await db
    .select()
    .from(dashboardGrants)
    .where(and(eq(dashboardGrants.datasetId, datasetId), eq(dashboardGrants.dashboard, "secret")));
  assert.equal(rows.length, 1);

  const gone = await unshareDashboard(admin, DS, "secret", member.id);
  assert.ok(gone.ok && gone.value.people.length === 0);
  assert.equal(await getDashboard(member.id, DS, "secret"), null);
});

test("a dashboard-only person is shown a dashboard the same way anyone is", async () => {
  // The restriction is on what they may DO, not on which dashboards they see.
  assert.equal(canExplore(viewer), false);
  assert.deepEqual(names(await listDashboardsAndDrafts(viewer.id, DS)), ["draft-everyones", "open"]);
  assert.ok((await shareDashboard(admin, DS, "secret", viewer.email!)).ok);
  assert.ok(await getDashboard(viewer.id, DS, "secret"));
  await unshareDashboard(admin, DS, "secret", viewer.id);
});

test("a dashboard-only account's token stops working, whatever scope it carries", async () => {
  // Minted while they could still query; the restriction arrives later. Every
  // bearer surface — MCP, the CLI, the drafts API — resolves through here.
  const minted = await createApiToken({ userId: viewer.id, name: "from-before", scopes: ["mcp"], expiresAt: null });
  assert.ok(minted.ok);
  if (!minted.ok) return;
  const refused = await resolveBearer(minted.raw, { scope: "mcp", recordUse: false });
  assert.ok(!refused.ok && refused.status === 403);
  assert.match(refused.ok ? "" : refused.error, /dashboard-only/);

  // Read per request, so lifting the restriction takes effect on the next one.
  await db.update(users).set({ roles: ["staff"] }).where(eq(users.id, viewer.id));
  assert.ok((await resolveBearer(minted.raw, { scope: "mcp", recordUse: false })).ok);
  await db.update(users).set({ roles: [MALLOYYO_DASHBOARD_ONLY, "staff"] }).where(eq(users.id, viewer.id));
});

test("sharing never opens a dataset, and says so", async () => {
  const shared = await shareDashboard(admin, DS, "secret", outsider.email!);
  assert.ok(shared.ok);
  if (!shared.ok) return;
  assert.match(shared.value.warning ?? "", /cannot open this dataset/);
  // The share is recorded, and changes nothing until a role opens the dataset.
  assert.equal(await getDashboard(outsider.id, DS, "secret"), null);
  assert.deepEqual(await listDashboardsAndDrafts(outsider.id, DS), []);
  await db.update(users).set({ roles: [MALLOYYO_USER, "staff"] }).where(eq(users.id, outsider.id));
  assert.ok(await getDashboard(outsider.id, DS, "secret"), "the role arriving is what makes the share take effect");
  await db.update(users).set({ roles: [MALLOYYO_USER] }).where(eq(users.id, outsider.id));
  await unshareDashboard(admin, DS, "secret", outsider.id);
});

test("who may change a modeled dashboard's audience: admins, and only its people", async () => {
  // Not a member — and it is a 404, not a 403: they cannot see it to be told no.
  const hidden = await getSharing(member, DS, "secret");
  assert.ok(!hidden.ok && hidden.status === 404);
  // A member who CAN see a dashboard still may not manage it.
  const visible = await getSharing(member, DS, "open");
  assert.ok(!visible.ok && visible.status === 403);
  // An open dashboard has no people list to add to; the model is where it is made private.
  const open = await shareDashboard(admin, DS, "open", member.email!);
  assert.ok(!open.ok && open.status === 400);
  assert.match(open.ok ? "" : open.error, /artifact \{ private \}/);
  // And there is no toggle for a modeled dashboard at all.
  const toggled = await setDraftVisibility(admin, DS, "secret", "dataset");
  assert.ok(!toggled.ok && toggled.status === 400);
  // Nobody on the instance by that address.
  const nobody = await shareDashboard(admin, DS, "secret", "ghost@aud.test");
  assert.ok(!nobody.ok && nobody.status === 404);
});

test("a draft's author opens it to the dataset, closes it, and shares it with one person", async () => {
  const opened = await setDraftVisibility(author, DS, "draft-mine", "dataset");
  assert.ok(opened.ok && opened.value.visibility === "dataset");
  assert.ok(await getDashboard(member.id, DS, "draft-mine"));

  const closed = await setDraftVisibility(author, DS, "draft-mine", "private");
  assert.ok(closed.ok && closed.value.isPrivate);
  assert.equal(await getDashboard(member.id, DS, "draft-mine"), null);

  // Changing who sees a draft is not an edit to it: updated_at is its content
  // version (the runtime cache key and the edit-conflict check read it).
  const [before] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, "mine"));
  await setDraftVisibility(author, DS, "draft-mine", "private");
  const [after] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, "mine"));
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());

  const shared = await shareDashboard(author, DS, "draft-mine", member.email!);
  assert.ok(shared.ok);
  assert.ok(await getDashboard(member.id, DS, "draft-mine"));
  assert.deepEqual(names(await listDashboardsAndDrafts(member.id, DS)), ["draft-everyones", "draft-mine", "open"]);
  assert.ok(await getDraftFiles(member.id, DS, "mine"), "someone it is shared with can read its files too");

  // Being shared with is not being able to re-share, or to open it to everyone.
  const reshare = await shareDashboard(member, DS, "draft-mine", viewer.email!);
  assert.ok(!reshare.ok && reshare.status === 403);
  const reopen = await setDraftVisibility(member, DS, "draft-mine", "dataset");
  assert.ok(!reopen.ok && reopen.status === 403);
  // An admin can do either for any draft.
  assert.ok((await getSharing(admin, DS, "draft-mine")).ok);
});

test("deleting a draft takes its shares with it", async () => {
  const sharesOf = () =>
    db
      .select()
      .from(dashboardGrants)
      .where(and(eq(dashboardGrants.datasetId, datasetId), eq(dashboardGrants.dashboard, "draft-mine")));
  assert.equal((await sharesOf()).length, 1);
  const r = await deleteDraft(author, DS, "mine");
  assert.equal(r.outcome, "deleted");
  assert.equal((await sharesOf()).length, 0);
});
