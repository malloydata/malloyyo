// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Who sees which dashboard, and who may query behind it — against a real
// Postgres. Two layers under dataset access:
//
//   • the dashboard AUDIENCE (src/lib/dashboards/audience.ts, sharing.ts)
//   • VIEW vs QUERY: a role is full or view-only, and someone's level on a
//     dataset is the best any of their roles gives them (src/lib/roles.ts)
//
// Almost entirely DB-only: these functions read rows and decide, so the
// artifacts are bare rows and the model is compiled once, by list_sources.
// What this pins:
//
//   • someone with only a view-only role on a dataset opens its dashboards and
//     is invisible to every query surface — the source resolver, the MCP tools,
//     saving a draft — while one full role on it is enough to query
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
import {
  db,
  users,
  roles,
  datasets,
  malloyModels,
  malloyArtifacts,
  draftDashboards,
  dashboardGrants,
  type User,
} from "@/db";
import { allDashboardsByDataset, getDashboard, listDashboards, listDashboardsAndDrafts } from "@/lib/dashboards";
import { deleteDraft, getDraftFiles, saveDraftDashboard } from "@/lib/dashboards/draft";
import { getSharing, setDraftVisibility, shareDashboard, unshareDashboard } from "@/lib/dashboards/sharing";
import { MALLOYYO_ADMIN, MALLOYYO_USER } from "@/lib/roles";
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import { canQueryDataset, findByDatasetRef, findBySource } from "@/lib/mcp-tools";

const DS = "audience";
let admin: User, author: User, member: User, viewer: User, outsider: User;
let datasetId: string;

const person = async (email: string, roles: string[], extra: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ email, status: "active", roles, ...extra }).returning())[0];

const names = (list: { name: string }[]) => list.map((d) => d.name).sort();

before(async () => {
  // Two roles open the dataset. `staff` is full — and deliberately has NO
  // catalog row, because a role nobody has described must still let its holders
  // query: that is what keeps every existing instance unchanged. `readers` is
  // view-only.
  await db.insert(roles).values({ name: "readers", description: "Dashboards only.", viewOnly: true });

  // The admin holds `staff` too: MALLOYYO_ADMIN does not open a dataset on these
  // paths, and the point here is what an admin sees INSIDE a dataset they can open.
  admin = await person("admin@aud.test", [MALLOYYO_USER, MALLOYYO_ADMIN, "staff"], { role: "admin", isAdmin: true });
  author = await person("author@aud.test", [MALLOYYO_USER, "staff"]);
  member = await person("member@aud.test", [MALLOYYO_USER, "staff"]);
  viewer = await person("viewer@aud.test", [MALLOYYO_USER, "readers"]);
  outsider = await person("outsider@aud.test", [MALLOYYO_USER]);

  const [ds] = await db
    .insert(datasets)
    .values({ userId: admin.id, name: DS, status: "ready", isPublic: false, roles: ["staff", "readers"] })
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

test("a view-only role opens the dashboards, like any role", async () => {
  // Viewing is not a lesser kind of seeing: the same listing, the same lookup,
  // and a private dashboard is shared with them the same way.
  assert.deepEqual(names(await listDashboardsAndDrafts(viewer.id, DS)), ["draft-everyones", "open"]);
  assert.ok(await getDashboard(viewer.id, DS, "open"));
  assert.ok((await shareDashboard(admin, DS, "secret", viewer.email!)).ok);
  assert.ok(await getDashboard(viewer.id, DS, "secret"));
  await unshareDashboard(admin, DS, "secret", viewer.id);
});

test("…and is invisible to every query surface", async () => {
  // The dataset resolves for viewing and not for querying.
  assert.ok(await findByDatasetRef(viewer.id, DS, "view"));
  assert.equal(await findByDatasetRef(viewer.id, DS, "query"), null);
  assert.equal(await canQueryDataset(viewer.id, datasetId), false);
  // A bare source name — how ltool, /api/run and chat address a model.
  assert.equal(await findBySource(viewer.id, "s"), null);
  assert.ok(await findBySource(member.id, "s"));

  // The MCP tools: not listed, and addressed directly it is the same "unknown,
  // or not visible to you" a dataset they cannot open at all gives.
  const asViewer = buildHostedExploreSurface(viewer, "http://localhost:3000");
  const listed = JSON.parse((await asViewer.call("list_sources", {})).content[0]?.text ?? "{}") as {
    models?: Record<string, unknown>;
  };
  assert.equal(listed.models?.[DS], undefined);
  const described = await asViewer.call("describe_source", { source: "s", model_ref: DS });
  assert.match(described.content[0]?.text ?? "", /model-not-found/);
  assert.match(described.content[0]?.text ?? "", /unknown, or not visible to you/);

  const asMember = buildHostedExploreSurface(member, "http://localhost:3000");
  const theirs = JSON.parse((await asMember.call("list_sources", {})).content[0]?.text ?? "{}") as {
    models?: Record<string, unknown>;
  };
  assert.ok(theirs.models?.[DS], "a full role lists it");

  // A draft is made of queries its author wrote, so saving one takes query
  // access — refused before anything is compiled, as a dataset that is not there.
  const saved = await saveDraftDashboard(
    viewer.id,
    DS,
    { name: "sneaky", source: "export default () => null" },
    "http://localhost:3000",
  );
  assert.ok(!saved.ok);
  assert.match(saved.ok ? "" : saved.error, /not found/);
});

test("someone's level on a dataset is the best any of their roles gives them", async () => {
  // A second role that is full is enough…
  await db.update(users).set({ roles: [MALLOYYO_USER, "readers", "staff"] }).where(eq(users.id, viewer.id));
  assert.equal(await canQueryDataset(viewer.id, datasetId), true);
  assert.ok(await findByDatasetRef(viewer.id, DS, "query"));
  await db.update(users).set({ roles: [MALLOYYO_USER, "readers"] }).where(eq(users.id, viewer.id));
  assert.equal(await canQueryDataset(viewer.id, datasetId), false);

  // …and the level belongs to the ROLE: marking it full gives every holder
  // query access on the next request, with nothing changed on the person.
  await db.update(roles).set({ viewOnly: false }).where(eq(roles.name, "readers"));
  assert.equal(await canQueryDataset(viewer.id, datasetId), true);
  await db.update(roles).set({ viewOnly: true }).where(eq(roles.name, "readers"));
  assert.equal(await canQueryDataset(viewer.id, datasetId), false);

  // Owning a dataset is not a role, so it cannot be view-only.
  assert.equal(await canQueryDataset(admin.id, datasetId), true);
  // And no role at all is neither.
  assert.equal(await findByDatasetRef(outsider.id, DS, "view"), null);
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
