// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// THE REPO MODEL, demonstrated.
//
// Every test here names a finding from the three reviews of the previous
// implementation and shows the new shape not having it. Where the old shape can
// be put back cheaply, it IS put back inside the test and shown to fail — a test
// that passes against the broken code is not a regression test.
//
// Real Postgres (the metadata DB), real Malloy on in-process DuckDB, and the
// real publish pipeline. The library seam (`publishRevision`) rather than HTTP,
// because what is being tested is the model and not the wire; the wire is
// covered by test/publish-flow.test.ts, which drives the actual CLI binary.
//
// Run via `npm run test:hosted`.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  db,
  datasetAliases,
  datasets,
  malloyModelFiles,
  malloyModels,
  repoRevisions,
  repos,
  users,
  type Repo,
  type User,
} from "@/db";
import { modelFileMap } from "@/lib/mcp-tools";
import { publishRevision } from "@/lib/repo-publish";
import { qualifiedName, resolveDatasetRef } from "@/lib/repos";

const MODEL = `#" Pet shop sales.
source: sales is duckdb.sql("""
  SELECT 'dog' as animal, 'CA' as state, 2 as qty
  UNION ALL SELECT 'cat', 'CA', 3
""") extend {
  measure: total_qty is qty.sum()
  view: by_animal is { group_by: animal; aggregate: total_qty }
}
`;

const BROKEN = `source: oops is no_such_connection.sql("SELECT 1") extend { }\n`;

const CONFIG = JSON.stringify({ connections: { duckdb: { is: "duckdb" } } });

function zip(files: Record<string, string>): Buffer {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = strToU8(v);
  return Buffer.from(zipSync(out, { mtime: new Date("1980-06-01T12:00:00Z") }));
}

/** A repo with one dataset per name under `datasets/`, sharing a `lib/`. */
function multiRepo(names: string[], opts: { broken?: string; lib?: boolean } = {}): Buffer {
  const files: Record<string, string> = { "malloy-config.json": CONFIG };
  if (opts.lib) files["lib/shared.malloy"] = "source: shared is duckdb.sql(\"SELECT 1 as one\")\n";
  for (const n of names) {
    files[`datasets/${n}/index.malloy`] =
      n === opts.broken ? BROKEN : (opts.lib ? 'import "../../lib/shared.malloy"\n' : "") + MODEL;
  }
  return zip(files);
}

let owner: User;
let other: User;

async function makeRepo(slug: string, ownerId = owner.id): Promise<Repo> {
  const [r] = await db.insert(repos).values({ slug, ownerId }).returning();
  return r;
}

const revisionsOf = (repoId: string) =>
  db.select().from(repoRevisions).where(eq(repoRevisions.repoId, repoId)).orderBy(repoRevisions.revision);

const liveRevision = async (repoId: string) =>
  (
    await db
      .select()
      .from(repoRevisions)
      .where(and(eq(repoRevisions.repoId, repoId), eq(repoRevisions.active, true)))
  )[0];

const datasetsOf = (repoId: string) =>
  db.select().from(datasets).where(eq(datasets.repoId, repoId)).orderBy(datasets.name);

const activeModel = async (datasetId: string) =>
  (
    await db
      .select()
      .from(malloyModels)
      .where(and(eq(malloyModels.datasetId, datasetId), eq(malloyModels.active, true)))
  )[0];

/**
 * Assert that a statement is REFUSED BY THE DATABASE, and say which constraint.
 *
 * Postgres puts the useful words in the SQLSTATE and the detail, and
 * drizzle-orm/postgres-js wraps the failure in a `DrizzleQueryError` whose own
 * message is "Failed query: …" and whose `cause` is the `PostgresError`. So the
 * whole chain is searched, and the SQLSTATE is checked as well as the text —
 * 23505 is a unique violation, which is what every pointer constraint here
 * raises.
 */
async function refused(fn: () => Promise<unknown>, wants: RegExp): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected the database to refuse this (${wants})`);
  const chain: string[] = [];
  let codes = "";
  for (let e: unknown = err, i = 0; e && i < 5; i += 1) {
    const rec = e as { message?: string; detail?: string; code?: string; cause?: unknown };
    if (rec.message) chain.push(rec.message);
    if (rec.detail) chain.push(rec.detail);
    if (rec.code) codes += `${rec.code} `;
    e = rec.cause;
  }
  const text = chain.join("\n");
  assert.match(text, wants, `refused, but not for the expected reason:\n${text}`);
  assert.match(codes, /23505|42P07|23514/, `expected a constraint SQLSTATE, got "${codes.trim()}"`);
}

before(async () => {
  const [a] = await db.insert(users).values({ email: "owner@test.local", isAdmin: true }).returning();
  const [b] = await db.insert(users).values({ email: "other@test.local" }).returning();
  owner = a;
  other = b;
});

after(async () => {
  await (globalThis as { __pg__?: { end?: () => Promise<void> } }).__pg__?.end?.().catch(() => {});
});

// ── store → verify → activate ───────────────────────────────────────────────

test("a verified revision goes live, and the datasets it creates commit with their models", async () => {
  const repo = await makeRepo("acme");
  const r = await publishRevision({
    repo,
    raw: multiRepo(["sales", "finance"], { lib: true }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.revision, 1);
  assert.deepEqual(
    r.datasets.map((d) => d.qualified).sort(),
    ["acme:finance", "acme:sales"],
    "the public name is <repo>:<name>",
  );

  const [live] = [await liveRevision(repo.id)];
  assert.ok(live, "the revision is active");
  assert.ok(live.verifiedAt, "and verified");
  assert.equal(live.verifyError, null);
  assert.deepEqual(
    (live.datasets ?? []).map((d) => d.dir).sort(),
    ["datasets/finance", "datasets/sales"],
    "and records what it declared it publishes",
  );

  for (const ds of await datasetsOf(repo.id)) {
    const model = await activeModel(ds.id);
    assert.ok(model, `${ds.name} has an active model`);
    assert.equal(model.revisionId, live.id, "…belonging to the live revision");
    assert.equal(model.version, 1);
    // THE ARCHIVE IS THE STORE OF RECORD. No per-file rows are written: they
    // made "what is in this repo" a question about a table, and duplicated every
    // shared lib/ file into every dataset of the repo.
    const fileRows = await db
      .select()
      .from(malloyModelFiles)
      .where(eq(malloyModelFiles.modelId, model.id));
    assert.equal(fileRows.length, 0, "…and no file rows");
  }
});

test("…and its files are derived from the revision, re-rooted, with the sibling excluded", async () => {
  const repo = await makeRepo("acme2");
  const r = await publishRevision({
    repo,
    raw: multiRepo(["sales", "finance"], { lib: true }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);

  const [sales] = (await datasetsOf(repo.id)).filter((d) => d.name === "sales");
  const model = await activeModel(sales.id);
  const files = await modelFileMap(model, sales.repoDir);
  assert.deepEqual(
    [...files.keys()].sort(),
    ["index.malloy", "lib/shared.malloy", "malloy-config.json"],
    "its own entry at the root, the shared lib at its repo path, the discovered config",
  );
  assert.match(files.get("index.malloy") ?? "", /Pet shop sales/);
  assert.ok(
    ![...files.keys()].some((k) => k.includes("finance")),
    "and nothing of the sibling dataset",
  );
});

// ── a revision that does not verify ─────────────────────────────────────────

test("a broken revision does NOT go live, and the previous one keeps serving", async () => {
  const repo = await makeRepo("atomic");
  const first = await publishRevision({
    repo,
    raw: multiRepo(["alpha", "beta"]),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.ok(first.ok, first.ok ? "" : first.error);
  const v1 = await Promise.all((await datasetsOf(repo.id)).map((d) => activeModel(d.id)));

  // The same repo, with ONE dataset broken, and a THIRD directory that would be
  // created. Nothing may land: not the model for the healthy dataset, and not
  // the new dataset row.
  const second = await publishRevision({
    repo,
    raw: multiRepo(["alpha", "beta", "gamma"], { broken: "beta" }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false ? second.kind : "", "compile");
  assert.match(second.ok === false ? second.error : "", /beta/);

  const live = await liveRevision(repo.id);
  assert.equal(live.revision, 1, "revision 1 is still what the repo serves");
  const after = await Promise.all((await datasetsOf(repo.id)).map((d) => activeModel(d.id)));
  assert.deepEqual(
    after.map((m) => m.id).sort(),
    v1.map((m) => m.id).sort(),
    "every dataset still serves the model it served before",
  );
  assert.equal(
    (await datasetsOf(repo.id)).length,
    2,
    "and `gamma` was NOT created — the publish refused as a unit",
  );
});

test("…and the failed revision STAYS, as the record of the attempt, inert", async () => {
  // NO COMPENSATING ACTION. The revision commits before verification, which is
  // safe precisely because nothing reads one that is not `active`. The old shape
  // inserted `ready` dataset rows, compiled, and deleted them on failure — and a
  // compensating action only runs if the process survives to run it.
  const repo = await makeRepo("record");
  const r = await publishRevision({
    repo,
    raw: multiRepo(["solo"], { broken: "solo" }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.equal(r.ok, false);

  const all = await revisionsOf(repo.id);
  assert.equal(all.length, 1, "the revision was stored");
  assert.equal(all[0].active, false, "and is inert");
  assert.equal(all[0].verifiedAt, null);
  assert.match(all[0].verifyError ?? "", /solo/, "with the reason on it");
  assert.ok(all[0].archiveBytes > 0, "and the bytes that failed, for someone to look at");
  assert.equal(await liveRevision(repo.id), undefined, "the repo serves nothing");
  assert.equal((await datasetsOf(repo.id)).length, 0, "and no dataset row exists");
});

test("…and the next publish succeeds, instead of a 409 nobody can clear", async () => {
  // THE EXACT BUG. A failed publish used to leave `ready` dataset rows with no
  // model, holding their names under a unique index, so the rightful publish
  // afterwards got a 409 permanently — fixable only by hand in the database.
  const repo = await makeRepo("recover");
  const bad = await publishRevision({
    repo,
    raw: multiRepo(["books"], { broken: "books" }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.equal(bad.ok, false);

  const good = await publishRevision({
    repo,
    raw: multiRepo(["books"]),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.ok(good.ok, good.ok ? "" : good.error);
  assert.equal(good.revision, 2, "a second revision, not a blocked name");
  assert.deepEqual(good.datasets.map((d) => d.qualified), ["recover:books"]);
  assert.equal((await liveRevision(repo.id)).revision, 2);
});

test("…and an ORPHAN dataset row — what the old shape left behind — is published into", async () => {
  // Reconstruct the wreckage: a `ready` dataset row at a directory, with no
  // model behind it, exactly as a crash during the old insert-then-compile left.
  // The new publish treats it as the dataset for that directory and gives it its
  // first model, rather than refusing because the name is taken.
  const repo = await makeRepo("orphaned");
  const [orphan] = await db
    .insert(datasets)
    .values({
      userId: owner.id,
      repoId: repo.id,
      repoDir: "datasets/ghost",
      name: "ghost",
      status: "ready",
      readyAt: new Date(),
    })
    .returning();
  assert.equal(await activeModel(orphan.id), undefined, "it really has no model");

  const r = await publishRevision({
    repo,
    raw: multiRepo(["ghost"]),
    source: "cli",
    createdById: owner.id,
    // NOT creating: the row is already there, which is the point.
    createDatasets: false,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.datasets.map((d) => d.id), [orphan.id], "the same row, now with a model");
  assert.ok(await activeModel(orphan.id));
});

// ── names ───────────────────────────────────────────────────────────────────

test("TWO REPOS CAN BOTH PUBLISH A `sales` — and the old global index could not", async () => {
  const a = await makeRepo("north");
  const b = await makeRepo("south");
  for (const repo of [a, b]) {
    const r = await publishRevision({
      repo,
      raw: multiRepo(["ledger"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  assert.deepEqual(
    [...(await datasetsOf(a.id)), ...(await datasetsOf(b.id))].map((d) => d.name),
    ["ledger", "ledger"],
  );

  // AND THE ALTERNATIVE FAILS. Put the pre-rewrite index back — one live dataset
  // per NAME on the instance — and it cannot even be created over this data,
  // which is exactly why two repos with a `sales/` directory could not coexist.
  await refused(
    () => db.execute(sql`create unique index tmp_global_name on datasets (name) where status = 'ready'`),
    /duplicat|unique index/i,
  );
});

test("a bare name that means two datasets is REFUSED, naming both", async () => {
  // Never guessed. Picking one by row order is how the previous design chose a
  // credential, and the failure was intermittent and unexplainable.
  const ambiguous = await resolveDatasetRef("ledger");
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(
    ambiguous.ok === false ? ambiguous.ambiguous?.sort() : [],
    ["north:ledger", "south:ledger"],
  );

  // And each is reachable by its qualified name.
  for (const slug of ["north", "south"]) {
    const r = await resolveDatasetRef(`${slug}:ledger`);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(qualifiedName(r.repo?.slug, r.dataset.name), `${slug}:ledger`);
  }
});

test("an ALIAS freezes the old meaning, so a later repo cannot steal a share link", async () => {
  // The migration writes one of these for every pre-existing dataset name. This
  // is what makes "sales" keep resolving to the dataset it always meant, even
  // after some other repo publishes its own.
  const [north] = (await datasetsOf((await db.select().from(repos).where(eq(repos.slug, "north")))[0].id));
  await db.insert(datasetAliases).values({ alias: "ledger", datasetId: north.id });

  const r = await resolveDatasetRef("ledger");
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.matchedBy, "alias");
  assert.equal(r.dataset.id, north.id, "the dataset the name used to mean");

  // Both directions: remove the alias and the ambiguity comes back, so this test
  // is pinning the alias and not something else.
  await db.delete(datasetAliases).where(eq(datasetAliases.alias, "ledger"));
  assert.equal((await resolveDatasetRef("ledger")).ok, false);
  await db.insert(datasetAliases).values({ alias: "ledger", datasetId: north.id });
});

// ── membership ──────────────────────────────────────────────────────────────

test("MEMBERSHIP CANNOT FAN OUT TO DEAD ROWS, and the old predicate shows why that mattered", async () => {
  const repo = await makeRepo("fanout");
  await db.update(repos).set({ githubRepo: "acme/fanout", githubBranch: "main" }).where(eq(repos.id, repo.id));
  const live = await publishRevision({
    repo,
    raw: multiRepo(["one"]),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.ok(live.ok, live.ok ? "" : live.error);

  // Six dead rows at the SAME directory — the production fork had seven for one
  // repo, none of them live.
  for (let i = 0; i < 6; i += 1) {
    await db.insert(datasets).values({
      userId: owner.id,
      repoId: repo.id,
      repoDir: "datasets/one",
      name: `one_dead_${i}`,
      status: "failed",
    });
  }

  // THE OLD PREDICATE: every row of the repo, with no status filter. (Spelled
  // against repo_id here because the text columns are gone; the shape is the
  // point — an unfiltered membership query.)
  const unfiltered = await db.select().from(datasets).where(eq(datasets.repoId, repo.id));
  assert.equal(unfiltered.length, 7, "an unfiltered membership query matches seven rows");

  // THE NEW ONE. A webhook push compiles once and writes once.
  const refreshed = await publishRevision({
    repo,
    raw: multiRepo(["one"], { lib: true }),
    source: "cli",
    createdById: owner.id,
    createDatasets: false,
  });
  assert.ok(refreshed.ok, refreshed.ok ? "" : refreshed.error);
  assert.equal(refreshed.datasets.length, 1, "one dataset refreshed, not seven");

  const rev = await liveRevision(repo.id);
  const written = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.revisionId, rev.id));
  assert.equal(written.length, 1, "and exactly one model version was written for it");
});

// ── the database enforces the pointers ──────────────────────────────────────

test("a repo cannot have two live revisions, and the database is what says so", async () => {
  const repo = await makeRepo("onelive");
  await publishRevision({
    repo,
    raw: multiRepo(["x"]),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  const second = await publishRevision({
    repo,
    raw: multiRepo(["x"], { lib: true }),
    source: "cli",
    createdById: owner.id,
    createDatasets: false,
  });
  assert.ok(second.ok, second.ok ? "" : second.error);
  const all = await revisionsOf(repo.id);
  assert.deepEqual(all.map((r) => r.active), [false, true], "the flip happened, both ways");

  // A second live revision is not representable.
  await refused(
    () => db.update(repoRevisions).set({ active: true }).where(eq(repoRevisions.id, all[0].id)),
    /repo_revisions_one_active/,
  );
});

test("a dataset cannot have two active models either", async () => {
  // Which replaces `order by created_at desc limit 1` — not a fact but a guess,
  // and one that ties when two versions land in the same millisecond.
  const repo = (await db.select().from(repos).where(eq(repos.slug, "onelive")))[0];
  const [ds] = await datasetsOf(repo.id);
  const versions = await db.select().from(malloyModels).where(eq(malloyModels.datasetId, ds.id));
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.active).length, 1);
  await refused(
    () => db.update(malloyModels).set({ active: true }).where(eq(malloyModels.datasetId, ds.id)),
    /malloy_models_one_active/,
  );
});

// ── credentials and content ─────────────────────────────────────────────────

test("a repo's GitHub credential answer lives on the repo, and there is nowhere else to put one", async () => {
  // `github_use_token` was stored once per DATASET. In the production fork one
  // repo had three rows with two different values and the refresh picked a
  // winner with `rows[0]` on a query with no ORDER BY — an intermittent,
  // unexplainable 404 for a private repo.
  const cols = await db.execute<{ table_name: string; column_name: string }>(
    sql`select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and column_name in ('github_use_token', 'github_repo', 'github_branch')
        order by table_name, column_name`,
  );
  assert.deepEqual(
    cols.map((c) => `${c.table_name}.${c.column_name}`),
    ["repos.github_branch", "repos.github_repo", "repos.github_use_token"],
    "only the repo carries them",
  );
});

test("an archive carrying malloy-config-local.json is REFUSED, and says to rotate", async () => {
  // That file is Malloy's LOCAL override: by design it holds real credentials
  // where the shared one holds {"env": …} references, and it is normally
  // gitignored. The old walker read the filesystem rather than git, so gitignore
  // did not save it and the file was uploaded.
  //
  // Refused rather than ignored: Malloy's own discovery PREFERS it, so ignoring
  // it would mean the model compiles against different connections locally than
  // here — the exact divergence this rewrite exists to remove.
  const repo = await makeRepo("secrets");
  const r = await publishRevision({
    repo,
    raw: zip({
      "index.malloy": MODEL,
      "malloy-config.json": CONFIG,
      "malloy-config-local.json": JSON.stringify({ connections: { duckdb: { is: "duckdb" } } }),
    }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.kind : "", "archive");
  assert.match(r.ok === false ? r.error : "", /malloy-config-local\.json/);
  assert.match(r.ok === false ? r.error : "", /rotate/);
  // Refused at the door: not even a revision was stored, because there is
  // nothing about these bytes worth keeping on a server.
  assert.equal((await revisionsOf(repo.id)).length, 0);
});

test("identical bytes do not mint a revision — a webhook storm is one revision", async () => {
  const repo = await makeRepo("storm");
  const raw = multiRepo(["same"]);
  const first = await publishRevision({
    repo,
    raw,
    source: "github",
    createdById: null,
    createDatasets: true,
  });
  assert.ok(first.ok, first.ok ? "" : first.error);

  for (let i = 0; i < 3; i += 1) {
    const again = await publishRevision({
      repo,
      raw,
      source: "github",
      createdById: null,
      createDatasets: false,
    });
    assert.ok(again.ok, again.ok ? "" : again.error);
    assert.equal(again.unchanged, true);
  }
  assert.equal((await revisionsOf(repo.id)).length, 1);
  const models = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, (await datasetsOf(repo.id))[0].id));
  assert.equal(models.length, 1, "and no model version per push either");
});

test("…but a revision that FAILED with those bytes is retried", async () => {
  // Only the LIVE revision short-circuits. A failure may have been a warehouse
  // that was down rather than the model, and a repo that could never be
  // re-pushed without a cosmetic edit would be a trap.
  const repo = await makeRepo("retry");
  const raw = multiRepo(["r"], { broken: "r" });
  assert.equal((await publishRevision({ repo, raw, source: "github", createdById: null, createDatasets: true })).ok, false);
  assert.equal((await publishRevision({ repo, raw, source: "github", createdById: null, createDatasets: true })).ok, false);
  assert.equal((await revisionsOf(repo.id)).length, 2, "two attempts, both recorded");
});

// ── layouts ─────────────────────────────────────────────────────────────────

test("a repo with BOTH layouts is refused rather than half-published", async () => {
  // Guessing picks one and publishes half of what the author meant, which looks
  // like success.
  const repo = await makeRepo("both");
  const r = await publishRevision({
    repo,
    raw: zip({
      "index.malloy": MODEL,
      "datasets/extra/index.malloy": MODEL,
      "malloy-config.json": CONFIG,
    }),
    source: "cli",
    createdById: owner.id,
    createDatasets: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.kind : "", "layout");
  assert.match(r.ok === false ? r.error : "", /two different layouts/);
  assert.match((await revisionsOf(repo.id))[0].verifyError ?? "", /two different layouts/);
});

test("a single-dataset repo publishes, and takes the name it was given", async () => {
  // Which is the shape every repo on this instance has today, so the GitHub
  // path has to handle it even though `--repo` refuses it at the wire.
  const repo = await makeRepo("solo_repo");
  const r = await publishRevision({
    repo,
    raw: zip({ "index.malloy": MODEL, "malloy-config.json": CONFIG }),
    source: "github",
    createdById: null,
    createDatasets: true,
    rootDatasetName: "petshop",
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.datasets.map((d) => d.qualified), ["solo_repo:petshop"]);
  assert.deepEqual((await datasetsOf(repo.id)).map((d) => d.repoDir), [""], "at the repo root");
});

test("a REFRESH reports an uncovered directory and keeps refreshing the rest", async () => {
  // THE TWO CALLERS WANT OPPOSITE THINGS, and collapsing them was a regression
  // I nearly shipped. Nobody reads a webhook's exit code, so refusing the whole
  // publish would mean a repo that gained a `datasets/newthing/` directory
  // silently STOPS REFRESHING on every push until someone notices — the
  // opposite of what a trigger should do.
  const repo = await makeRepo("unclaimed");
  assert.ok(
    (await publishRevision({
      repo,
      raw: multiRepo(["kept"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    })).ok,
  );
  const r = await publishRevision({
    repo,
    raw: multiRepo(["kept", "newcomer"], { lib: true }),
    source: "github",
    createdById: null,
    createDatasets: false,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.unclaimed.map((u) => u.dir), ["datasets/newcomer"], "reported");
  assert.deepEqual(r.datasets.map((d) => d.name), ["kept"], "and `kept` moved on");
  assert.equal(r.revision, 2, "the repo really is at the new commit");
  // A webhook has no business choosing an owner or a name, so it creates nothing.
  assert.equal((await datasetsOf(repo.id)).length, 1);
});

test("…but a CLI publish REFUSES, because someone is reading an exit code", async () => {
  // The other half of the same decision, and the message the CLI prints.
  const repo = await makeRepo("unclaimed_cli");
  assert.ok(
    (await publishRevision({
      repo,
      raw: multiRepo(["kept"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    })).ok,
  );
  const r = await publishRevision({
    repo,
    raw: multiRepo(["kept", "newcomer"]),
    source: "cli",
    createdById: owner.id,
    createDatasets: false,
    onMissing: "refuse",
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.kind : "", "request");
  assert.match(r.ok === false ? r.error : "", /--create-datasets/);
  assert.deepEqual(r.ok === false ? r.missing?.map((m) => m.name) : [], ["newcomer"]);
  assert.equal((await datasetsOf(repo.id)).length, 1);
});

test("a directory that is GONE leaves its dataset exactly as it was", async () => {
  // Saved queries, share links and history pointing at it are somebody's work,
  // and a commit is not a decision to throw that away.
  const repo = await makeRepo("shrink");
  assert.ok(
    (await publishRevision({
      repo,
      raw: multiRepo(["stays", "goes"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    })).ok,
  );
  const goes = (await datasetsOf(repo.id)).find((d) => d.name === "goes")!;
  const before = await activeModel(goes.id);

  const r = await publishRevision({
    repo,
    raw: multiRepo(["stays"]),
    source: "github",
    createdById: null,
    createDatasets: false,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.unpublished.map((u) => u.name), ["goes"], "reported");
  const after = await db.select().from(datasets).where(eq(datasets.id, goes.id));
  assert.equal(after.length, 1, "and still here");
  assert.equal(after[0].status, "ready");
  assert.equal((await activeModel(goes.id)).id, before.id, "serving what it served");
});

// ── two datasets on one directory ───────────────────────────────────────────

test("two datasets may share a directory: the unit of compile is a DIR, of write a DATASET", async () => {
  // Same model, scoped differently — `required_givens` and `roles` are the
  // dataset's, not the model's. Forbidding it with a unique index would also
  // have made the migration able to fail on real data (a repo added twice under
  // two names is an ordinary thing to find).
  const repo = await makeRepo("twinned");
  assert.ok(
    (await publishRevision({
      repo,
      raw: multiRepo(["shared_dir"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    })).ok,
  );
  await db.insert(datasets).values({
    userId: other.id,
    repoId: repo.id,
    repoDir: "datasets/shared_dir",
    name: "shared_dir_restricted",
    status: "ready",
    readyAt: new Date(),
  });

  const r = await publishRevision({
    repo,
    raw: multiRepo(["shared_dir"], { lib: true }),
    source: "github",
    createdById: null,
    createDatasets: false,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(
    r.datasets.map((d) => d.name).sort(),
    ["shared_dir", "shared_dir_restricted"],
    "both got a version of the one compile",
  );
  const rev = await liveRevision(repo.id);
  const written = await db.select().from(malloyModels).where(eq(malloyModels.revisionId, rev.id));
  assert.equal(written.length, 2);
  assert.equal(
    new Set(written.map((m) => m.source)).size,
    1,
    "and it really is the same model for both",
  );
});

// ── provenance ──────────────────────────────────────────────────────────────

test("the head commit is on the revision, which is what makes 'same commit' checkable", async () => {
  // A GitHub-backed model used to record `github:owner/repo@branch` — the
  // branch, never which commit of it — so a repo whose datasets had drifted
  // apart looked exactly like one that had not.
  const repo = await makeRepo("provenance");
  const r = await publishRevision({
    repo,
    raw: multiRepo(["a", "b"]),
    source: "github",
    createdById: null,
    git: { sha: "0123456789abcdef0123456789abcdef01234567", branch: "main", dirty: false },
    createDatasets: true,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const rev = await liveRevision(repo.id);
  assert.equal(rev.gitSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(rev.source, "github");
  assert.equal(rev.createdById, null, "a webhook has no user, and does not pretend to");

  const models = await db
    .select()
    .from(malloyModels)
    .where(and(eq(malloyModels.revisionId, rev.id), isNotNull(malloyModels.gitSha)));
  assert.equal(models.length, 2);
  assert.equal(new Set(models.map((m) => m.gitSha)).size, 1, "one commit across the repo");
});

test("two publishes racing cannot leave an OLDER revision live", async () => {
  // Both verify independently and both may succeed; without the guard the
  // slower, older one would land last and quietly replace the newer. The repo
  // row is locked at activation and the live revision is compared.
  //
  // A real race, so it is asserted on the INVARIANT rather than on which call
  // won: exactly one revision is live, it is the highest-numbered one that
  // verified, and every dataset serves a model from it.
  //
  // THIS TEST DOES NOT PROVE THE GUARD. The guard only fires when the
  // HIGHER-numbered revision activates FIRST, and nothing here can make that
  // happen — if the two serialize in order, they both land correctly and the
  // comparison never runs, and the test passes either way. Said plainly rather
  // than left to be believed: the mechanism is pinned separately, by
  // src/lib/repos-push-atomic.test.ts, which reads the comparison and the row
  // lock out of the source. What this test IS good for is the invariant, which
  // must hold under either interleaving.
  const repo = await makeRepo("racing");
  assert.ok(
    (await publishRevision({
      repo,
      raw: multiRepo(["r"]),
      source: "cli",
      createdById: owner.id,
      createDatasets: true,
    })).ok,
  );

  const results = await Promise.all([
    publishRevision({ repo, raw: multiRepo(["r"], { lib: true }), source: "cli", createdById: owner.id }),
    publishRevision({ repo, raw: zip({ "malloy-config.json": CONFIG, "datasets/r/index.malloy": `${MODEL}\n// b\n` }), source: "cli", createdById: owner.id }),
  ]);
  const landed = results.filter((r) => r.ok).map((r) => (r.ok ? r.revision : 0));
  assert.ok(landed.length >= 1, "at least one of them verified");

  const live = await liveRevision(repo.id);
  const all = await revisionsOf(repo.id);
  assert.equal(all.filter((r) => r.active).length, 1, "exactly one live revision");
  assert.equal(
    live.revision,
    Math.max(...landed),
    "and it is the highest-numbered revision that verified",
  );
  const ds = (await datasetsOf(repo.id))[0];
  assert.equal((await activeModel(ds.id)).revisionId, live.id, "the dataset serves it");
});

test("serving one dataset INFLATES NOTHING of its siblings — the reason it is a zip", async () => {
  // The claim that made zip the stored format is that a zip can be read
  // PARTIALLY: the central directory gives every member's name and size without
  // inflating anything, so only this dataset's members are decompressed. Gzip is
  // one stream and can do none of it.
  //
  // PROVEN, not asserted. The sibling's compressed bytes are deliberately
  // corrupted, so inflating them throws — and the test shows that inflating
  // everything DOES throw while serving `a` does not. A file-set assertion
  // alone could not tell "excluded from the view" from "inflated and dropped".
  const repo = await makeRepo("partial");
  const good = strToU8("source: a is 1\n".repeat(200));
  const sibling = strToU8("source: b is 2\n".repeat(200));
  const raw = Buffer.from(
    zipSync(
      {
        "malloy-config.json": strToU8(CONFIG),
        "datasets/a/index.malloy": good,
        "datasets/b/index.malloy": sibling,
      },
      { level: 6, mtime: new Date("1980-06-01T12:00:00Z") },
    ),
  );
  // Mangle the deflate stream of `datasets/b/index.malloy`, in place, right
  // after its local file header.
  const name = Buffer.from("datasets/b/index.malloy");
  const dataStart = raw.indexOf(name) + name.length;
  for (let i = dataStart + 4; i < dataStart + 24; i += 1) raw[i] ^= 0xff;

  // The corruption is real: a whole-archive read fails.
  assert.throws(() => unzipSync(new Uint8Array(raw)), /invalid|unexpected|incorrect/i);

  // Stored by hand, because `normalizeArchive` would (rightly) have nothing to
  // say about a member it never inflates either — this is about the SERVING
  // path, so the row is written directly.
  const [rev] = await db
    .insert(repoRevisions)
    .values({
      repoId: repo.id,
      revision: 1,
      source: "cli",
      archive: raw,
      archiveBytes: raw.length,
      archiveSha256: "handmade",
      datasets: [
        { name: "a", dir: "datasets/a" },
        { name: "b", dir: "datasets/b" },
      ],
      active: true,
      activatedAt: new Date(),
      verifiedAt: new Date(),
    })
    .returning();
  const [ds] = await db
    .insert(datasets)
    .values({
      userId: owner.id,
      repoId: repo.id,
      repoDir: "datasets/a",
      name: "a",
      status: "ready",
      readyAt: new Date(),
    })
    .returning();
  const [model] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds.id,
      revisionId: rev.id,
      active: true,
      version: 1,
      source: "source: a is 1",
      generatedBy: "test",
    })
    .returning();

  const files = await modelFileMap(model, ds.repoDir);
  assert.deepEqual([...files.keys()].sort(), ["index.malloy", "malloy-config.json"]);
  assert.match(files.get("index.malloy") ?? "", /source: a is 1/);
});
