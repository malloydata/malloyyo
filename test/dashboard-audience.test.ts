// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Who sees which dashboard, and who may query behind it — against a real
// Postgres. Two layers under dataset access:
//
//   • LEVELS: a role has a level per dataset — none, dashboards (view) or full
//     (query) — and someone's level is the best any of their roles gives them
//     (src/lib/roles.ts, src/lib/role-access.ts)
//   • the dashboard AUDIENCE: a dashboard is open to its dataset, or private
//     and shared by email address (src/lib/dashboards/audience.ts, sharing.ts)
//
// Almost entirely DB-only: these functions read rows and decide, so the
// artifacts are bare rows and the model is compiled once, by list_sources.
// What this pins:
//
//   • a role at the dashboards level opens the dashboards and is invisible to
//     every query surface; one full role on the dataset is enough to query
//   • the page's arithmetic and the server's SQL give the same answer
//   • an admin opens every dataset, in full
//   • a draft is private until its author opens it; a published dashboard is
//     private when its stored setting says so, else when its tag does
//   • private means admins + its author + the people it is shared with — in
//     every listing AND at the one lookup every route goes through
//   • sharing never opens a dataset
//   • promoting a draft copies its audience to the published dashboard
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
import { deleteDraft, getDraftFiles, recordPromotion, saveDraftDashboard } from "@/lib/dashboards/draft";
import { getSharing, setDashboardVisibility, shareDashboard, unshareDashboard } from "@/lib/dashboards/sharing";
import { MALLOYYO_ADMIN, MALLOYYO_USER } from "@/lib/roles";
import { resolveAccess } from "@/lib/role-access";
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import { canQueryDataset, findByDatasetRef, findBySource } from "@/lib/mcp-tools";

const DS = "audience";
let admin: User, author: User, member: User, viewer: User, outsider: User;
let datasetId: string;

const person = async (email: string, roles: string[], extra: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ email, status: "active", roles, ...extra }).returning())[0];

const names = (list: { name: string }[]) => list.map((d) => d.name).sort();

before(async () => {
  // Two roles open the dataset: `staff` in full, `readers` at the dashboards
  // level. `staff` deliberately has NO catalog row — a role nobody described
  // must still let its holders query, which is what keeps every existing
  // instance unchanged.
  await db.insert(roles).values({ name: "readers", description: "Dashboards only." });

  // The admin holds NEITHER: MALLOYYO_ADMIN opens every dataset by itself.
  admin = await person("admin@aud.test", [MALLOYYO_USER, MALLOYYO_ADMIN], { role: "admin", isAdmin: true });
  author = await person("author@aud.test", [MALLOYYO_USER, "staff"]);
  member = await person("member@aud.test", [MALLOYYO_USER, "staff"]);
  viewer = await person("viewer@aud.test", [MALLOYYO_USER, "readers"]);
  outsider = await person("outsider@aud.test", [MALLOYYO_USER]);

  const [ds] = await db
    .insert(datasets)
    .values({
      // Owned by someone who is not under test: owning a dataset gives full
      // access, and that would hide whether the admin role alone opens it.
      userId: (await person("owner@aud.test", [MALLOYYO_USER])).id,
      name: DS,
      status: "ready",
      isPublic: false,
      roles: ["staff", "readers"],
      viewOnlyRoles: ["readers"],
    })
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

test("a role at the dashboards level opens the dashboards, like any role", async () => {
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

  // …and the level is the ROLE's, on THIS dataset: moving `readers` to full
  // here gives every holder query access on the next request, with nothing
  // changed on the person.
  await db.update(datasets).set({ viewOnlyRoles: [] }).where(eq(datasets.id, datasetId));
  assert.equal(await canQueryDataset(viewer.id, datasetId), true);
  await db.update(datasets).set({ viewOnlyRoles: ["readers"] }).where(eq(datasets.id, datasetId));
  assert.equal(await canQueryDataset(viewer.id, datasetId), false);

  // No role at all is neither level.
  assert.equal(await findByDatasetRef(outsider.id, DS, "view"), null);
});

test("an admin opens every dataset in full, holding no role on it", async () => {
  assert.deepEqual(admin.roles, [MALLOYYO_USER, MALLOYYO_ADMIN]);
  assert.ok(await findByDatasetRef(admin.id, DS, "view"));
  assert.ok(await findByDatasetRef(admin.id, DS, "query"));
  assert.equal(await canQueryDataset(admin.id, datasetId), true);
  // Every way of being an admin counts, not only the role list.
  const legacy = await person("legacy-admin@aud.test", [], { role: "admin" });
  assert.equal(await canQueryDataset(legacy.id, datasetId), true);
});

test("the admin page's arithmetic gives the answer the server enforces", async () => {
  // src/lib/role-access.ts is what Admin → Roles shows; datasetAccessWhere is
  // what decides. If these ever disagree the page is lying about access.
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  const grants = [{ id: ds.id, roles: ds.roles, viewOnlyRoles: ds.viewOnlyRoles, isPublic: ds.isPublic, ownerId: ds.userId }];
  for (const who of [admin, author, member, viewer, outsider]) {
    const [fresh] = await db.select().from(users).where(eq(users.id, who.id));
    const held = [...(fresh.roles ?? []), ...(fresh.role === "admin" ? [MALLOYYO_ADMIN] : [])];
    const [shown] = resolveAccess(held, grants, { userId: who.id });
    const enforced = (await canQueryDataset(who.id, datasetId))
      ? "query"
      : (await findByDatasetRef(who.id, DS, "view"))
        ? "view"
        : "none";
    assert.equal(shown.level, enforced, `${fresh.email}: page says ${shown.level}, server says ${enforced}`);
  }
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

test("a published dashboard's audience is an admin's to change", async () => {
  // Not a member — and it is a 404, not a 403: they cannot see it to be told no.
  const hidden = await getSharing(member, DS, "secret");
  assert.ok(!hidden.ok && hidden.status === 404);
  // A member who CAN see a dashboard still may not manage it.
  const visible = await getSharing(member, DS, "open");
  assert.ok(!visible.ok && visible.status === 403);
  const toggle = await setDashboardVisibility(member, DS, "open", "private");
  assert.ok(!toggle.ok && toggle.status === 403);
  // Nobody on the instance by that address.
  const nobody = await shareDashboard(admin, DS, "secret", "ghost@aud.test");
  assert.ok(!nobody.ok && nobody.status === 404);
});

test("the stored setting outranks the model's tag, in both directions", async () => {
  // `open` has no private tag. An admin restricts it from the Share dialog…
  const closed = await setDashboardVisibility(admin, DS, "open", "private");
  assert.ok(closed.ok && closed.value.kind === "published" && closed.value.isPrivate);
  assert.equal(await getDashboard(member.id, DS, "open"), null);
  assert.deepEqual(names(await listDashboards(member.id, DS)), []);
  // …and shares it with one person, exactly as for any private dashboard.
  assert.ok((await shareDashboard(admin, DS, "open", member.email!)).ok);
  assert.ok(await getDashboard(member.id, DS, "open"));
  assert.equal(await getDashboard(author.id, DS, "open"), null);

  // `secret` IS tagged private. Opening it from the dialog wins over the tag,
  // so the next publish — which carries the same tag — does not undo it.
  const opened = await setDashboardVisibility(admin, DS, "secret", "dataset");
  assert.ok(opened.ok && !opened.value.isPrivate);
  assert.ok(await getDashboard(author.id, DS, "secret"));

  // One entry each, set in place: neither write disturbed the other's.
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  assert.deepEqual(ds.dashboardAudience, { open: "private", secret: "dataset" });

  // Back to how the model has them, for the tests below.
  await db.update(datasets).set({ dashboardAudience: {} }).where(eq(datasets.id, datasetId));
  await unshareDashboard(admin, DS, "open", member.id);
  assert.ok(await getDashboard(author.id, DS, "open"));
  assert.equal(await getDashboard(author.id, DS, "secret"), null);
});

test("someone can be added to a dashboard that is open to the dataset", async () => {
  // It changes nothing today, and is who keeps access if it is later made
  // private — the same as adding a person to a document anyone can already read.
  const added = await shareDashboard(admin, DS, "open", member.email!);
  assert.ok(added.ok && !added.value.isPrivate);
  await unshareDashboard(admin, DS, "open", member.id);
});

test("a draft's author opens it to the dataset, closes it, and shares it with one person", async () => {
  const opened = await setDashboardVisibility(author, DS, "draft-mine", "dataset");
  assert.ok(opened.ok && opened.value.visibility === "dataset");
  assert.ok(await getDashboard(member.id, DS, "draft-mine"));

  const closed = await setDashboardVisibility(author, DS, "draft-mine", "private");
  assert.ok(closed.ok && closed.value.isPrivate);
  assert.equal(await getDashboard(member.id, DS, "draft-mine"), null);

  // Changing who sees a draft is not an edit to it: updated_at is its content
  // version (the runtime cache key and the edit-conflict check read it).
  const [before] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, "mine"));
  await setDashboardVisibility(author, DS, "draft-mine", "private");
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
  const reopen = await setDashboardVisibility(member, DS, "draft-mine", "dataset");
  assert.ok(!reopen.ok && reopen.status === 403);
  // An admin can do either for any draft.
  assert.ok((await getSharing(admin, DS, "draft-mine")).ok);
});

test("promoting a draft copies who can see it to the published dashboard", async () => {
  // `mine` is private and shared with `member`. Its author records that it was
  // promoted as `forecast` — the moment its link is pointed at the published
  // dashboard — and from then `forecast` has the draft's audience, whatever
  // the promoted file's tag says (here: nothing, i.e. open).
  assert.equal(await recordPromotion(author.id, DS, "mine", { name: "forecast" }), "recorded");
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  assert.equal(ds.dashboardAudience.forecast, "private");

  const [model] = await db.select().from(malloyModels).where(eq(malloyModels.datasetId, datasetId));
  await db.insert(malloyArtifacts).values({
    modelId: model.id,
    name: "forecast",
    title: "Forecast",
    manifest: { title: "Forecast", query: "q" },
    source: "",
  });

  // The same people as before: the person it was shared with…
  assert.ok(await getDashboard(member.id, DS, "forecast"));
  // …its author, who saw the draft because it was theirs and must not lose the
  // dashboard the day it ships…
  assert.ok(await getDashboard(author.id, DS, "forecast"));
  // …admins — and nobody else.
  assert.ok(await getDashboard(admin.id, DS, "forecast"));
  assert.equal(await getDashboard(viewer.id, DS, "forecast"), null);

  // An OPEN draft promotes to an open dashboard even into a file tagged private.
  assert.equal(await recordPromotion(author.id, DS, "everyones", { name: "secret" }), "recorded");
  assert.ok(await getDashboard(viewer.id, DS, "secret"), "the draft was open, so the published one is");
  await db.update(datasets).set({ dashboardAudience: {} }).where(eq(datasets.id, datasetId));
  await db
    .update(draftDashboards)
    .set({ promotedAs: null, promotedHash: null, promotedAt: null })
    .where(eq(draftDashboards.datasetId, datasetId));
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
