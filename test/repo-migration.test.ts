// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// THE BACKFILL, against the mess it is actually going to find.
//
// `0026_repos_first_class.sql` turns `(github_repo, github_branch)` pairs into
// repo rows, and it has to do that over data that disagrees with itself. The
// production fork had a repo with three dataset rows carrying two different
// values for `github_use_token`; the old refresh resolved that with `rows[0]` on
// a query with no ORDER BY, which for a private repo is an intermittent failure
// that flips between refreshes. It also had repos with several dead rows and no
// live one.
//
// So this test replays the journal up to 0025, seeds exactly those shapes, runs
// 0026 and 0027, and checks the answers. It also checks the property that
// matters more than any individual answer: THE MIGRATION CANNOT FAIL ON DATA IT
// DID NOT CHOOSE. Every unique index it creates is implied by an index that
// already exists or by its own backfill, and a migration that can fail on real
// rows is a landmine in a deploy — a Vercel build applies the journal before
// promoting the code, so a failure there takes the deploy down.
//
// It talks to Postgres directly rather than through drizzle, because the point
// is the SQL files and the schema they leave behind.
//
// Run via `npm run test:hosted`.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { repoSlugFromGitHub } from "@/lib/repo-names";

const ROOT = join(import.meta.dirname, "..");
const DRIZZLE = join(ROOT, "drizzle");

type JournalEntry = { idx: number; tag: string };
const journal = (
  JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  }
).entries;

const sqlOf = (tag: string) =>
  readFileSync(join(DRIZZLE, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

let client: ReturnType<typeof postgres>;

/** Replay the journal from scratch up to and including `through`. */
async function replayTo(through: string): Promise<void> {
  await client.unsafe("drop schema if exists public cascade; create schema public;");
  for (const entry of journal) {
    for (const statement of sqlOf(entry.tag)) await client.unsafe(statement);
    if (entry.tag === through) return;
  }
  throw new Error(`${through} is not in the journal`);
}

async function apply(tag: string): Promise<void> {
  for (const statement of sqlOf(tag)) await client.unsafe(statement);
}

const PRE = "0025_dataset_description";
const MIGRATION = "0026_repos_first_class";
const PRE_REWRITE_LAST = MIGRATION;

/**
 * Journal entries added AFTER the rewrite, each one checked safe to apply
 * before the new code is promoted — see the test at the bottom of this file for
 * why that ordering is the hazard. Appending a tag here is the act of having
 * checked it; the test fails until you do, which is the point.
 *
 *  - 0027_public_to_user_role — data only (UPDATE). Adds MALLOYYO_USER to
 *    datasets already flagged `is_public`. The live version still reads
 *    `is_public`, which is untouched, and the added role only grants what that
 *    column already granted, so no deploy window can hide a dataset.
 *  - 0028_drop_failed_datasets — data only (DELETE of `status = 'failed'`).
 *    No schema change; the live version simply stops listing debris.
 *
 * Neither drops a column, which is the thing that cannot ride along in a
 * build-time migration.
 */
const REVIEWED_AFTER_REWRITE = ["0027_public_to_user_role", "0028_drop_failed_datasets"];

/** What the journal should currently end with. */
const JOURNAL_TIP = REVIEWED_AFTER_REWRITE.at(-1) ?? PRE_REWRITE_LAST;

/**
 * The mess. Every row here is a shape the production fork actually had, or one
 * the schema at 0025 permits and the backfill therefore has to survive.
 */
async function seedPreJournalData(): Promise<void> {
  await client.unsafe(`
    insert into users (id, email, status, role) values
      ('11111111-1111-1111-1111-111111111111', 'first@test.local', 'active', 'admin'),
      ('22222222-2222-2222-2222-222222222222', 'second@test.local', 'active', 'member');

    -- A repo with THREE rows and TWO different answers about its credential, one
    -- of them dead. The owner must come out as the oldest LIVE row's owner.
    insert into datasets (id, user_id, name, status, github_repo, github_branch, github_use_token, repo_dir, created_at) values
      ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        'private_dead', 'failed', 'acme/private', 'main', false, null, now() - interval '10 days'),
      ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'private_live', 'ready', 'acme/private', 'main', true, null, now() - interval '5 days'),
      ('aaaaaaaa-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222',
        'private_other', 'ready', 'acme/private', 'main', false, 'datasets/other', now() - interval '1 day');

    -- The same GitHub repo on TWO branches: two repos, and their slugs collide.
    insert into datasets (id, user_id, name, status, github_repo, github_branch, github_use_token, repo_dir, created_at) values
      ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'twig_main', 'ready', 'acme/twig', 'main', true, null, now() - interval '3 days'),
      ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'twig_dev', 'ready', 'acme/twig', 'dev', true, null, now() - interval '2 days');

    -- A repo recorded as a URL rather than owner/name, and with a NULL branch,
    -- which the old read path coalesced to 'main' at every call site.
    insert into datasets (id, user_id, name, status, github_repo, github_branch, github_use_token, repo_dir, created_at) values
      ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'urly', 'ready', 'https://github.com/acme/Url-Repo.git', null, true, null, now());

    -- A dataset NO repo publishes: Claude-authored, or a single-dataset CLI push.
    insert into datasets (id, user_id, name, status, github_repo, github_branch, github_use_token, created_at) values
      ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'scratch', 'ready', null, null, true, now());

    -- Two model versions for one dataset, written in the SAME instant. This is
    -- the tie that made ORDER BY created_at DESC LIMIT 1 a guess.
    insert into malloy_models (id, dataset_id, version, source, generated_by, created_at) values
      ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 1,
        'source: old is 1', 'test', '2026-01-01T00:00:00Z'),
      ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 2,
        'source: new is 1', 'test', '2026-01-01T00:00:00Z');
    insert into malloy_models (id, dataset_id, version, source, generated_by) values
      ('eeeeeeee-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 1,
        'source: scratch is 1', 'test');
  `);
}

/**
 * Run a query and hand back a PLAIN array.
 *
 * postgres.js returns a `Result`, an Array subclass — and `assert.deepEqual` is
 * strict about the prototype, so comparing one to a literal fails with a diff
 * that shows identical contents. Spreading it is the whole fix and it belongs
 * here rather than at twelve call sites.
 */
async function rows<T>(q: string): Promise<T[]> {
  return [...((await client.unsafe(q)) as unknown as T[])];
}

before(async () => {
  client = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false });
});

after(async () => {
  await client.end().catch(() => {});
  await (globalThis as { __pg__?: { end?: () => Promise<void> } }).__pg__?.end?.().catch(() => {});
});

test("the journal replays to the entry before the rewrite", async () => {
  await replayTo(PRE);
  const [{ n }] = await rows<{ n: string }>(
    `select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and table_name = 'datasets' and column_name = 'github_repo'`,
  );
  assert.equal(n, "1", "the column the rewrite removes is still here at 0025");
});

test("0026 applies over the mess without failing", async () => {
  // THE PROPERTY THAT MATTERS MOST. A Vercel build migrates BEFORE promoting
  // the new code, so a migration that throws on real rows takes the deploy down
  // — and the data here is deliberately the worst of what the fork held.
  await seedPreJournalData();
  await apply(MIGRATION);
});

test("one repo per (github_repo, branch) pair, and no row invented", async () => {
  const repos = await rows<{ slug: string; github_repo: string; github_branch: string }>(
    `select slug, github_repo, github_branch from repos order by github_repo, github_branch`,
  );
  assert.deepEqual(
    repos.map((r) => `${r.github_repo}@${r.github_branch}`),
    ["acme/Url-Repo@main", "acme/private@main", "acme/twig@dev", "acme/twig@main"],
    "the NULL branch coalesced to main, and the URL form normalized to owner/name",
  );
});

test("the credential answer is bool_or, so a private repo keeps working", async () => {
  // Three rows, two answers. A token sent where it is not needed is read by
  // GitHub and ignored; a token NOT sent to a private repo is a 404 and a dead
  // dataset. The failure modes are not symmetric, so prefer sending.
  const [repo] = await rows<{ github_use_token: boolean }>(
    `select github_use_token from repos where github_repo = 'acme/private'`,
  );
  assert.equal(repo.github_use_token, true);
});

test("the owner is the oldest LIVE row's owner, chosen deterministically", async () => {
  // The oldest row of `acme/private` is `failed` and belongs to the second user;
  // the oldest LIVE one belongs to the first. The person whose dataset is
  // actually serving is the one who publishes.
  const [repo] = await rows<{ owner_id: string }>(
    `select owner_id from repos where github_repo = 'acme/private'`,
  );
  assert.equal(repo.owner_id, "11111111-1111-1111-1111-111111111111");
});

test("a slug collision is broken deterministically, not left to fail", async () => {
  // `acme/twig@main` and `acme/twig@dev` are two repos whose names slugify the
  // same. `_2` is a name nobody chose and the only alternative that cannot fail;
  // it is renameable afterwards, and the ORDER is stable (repo, then branch).
  const twigs = await rows<{ slug: string; github_branch: string }>(
    `select slug, github_branch from repos where github_repo = 'acme/twig' order by github_branch`,
  );
  assert.deepEqual(twigs, [
    { slug: "twig_2", github_branch: "dev" },
    { slug: "twig", github_branch: "main" },
  ]);
  // Both directions on the ORDER, not just the pair of names: re-running the
  // same window function must give the same answer, which is the property that
  // `rows[0]` on an unordered query did not have.
  const again = await rows<{ slug: string }>(
    `select slug from repos where github_repo = 'acme/twig' order by github_branch`,
  );
  assert.deepEqual(again.map((r) => r.slug), ["twig_2", "twig"]);
});

test("a repo recorded as a URL is NORMALIZED, so the CLI can ever find it", async () => {
  // `findRepoForPublish` matches `github_repo` exactly against what the CLI
  // sends (`--repo owner/name`). A row left holding
  // `https://github.com/acme/Url-Repo.git` could never be found: the lookup
  // misses, falls to the slug, sees a different `github_repo`, and refuses with
  // advice pointing at a flag the CLI does not have. A permanent dead end for a
  // repo that worked the day before.
  const [repo] = await rows<{ slug: string; github_repo: string }>(
    `select slug, github_repo from repos where slug = 'url_repo'`,
  );
  assert.equal(repo.github_repo, "acme/Url-Repo", "stored as owner/name");
  assert.equal(repo.slug, "url_repo", "and named after the repo");
  // And its datasets really did land in it, which the join has to do on the
  // canonical form on both sides.
  const [{ n }] = await rows<{ n: string }>(
    `select count(*)::text as n from datasets where repo_id = (select id from repos where slug = 'url_repo')`,
  );
  assert.equal(n, "1");
});

test("the migration's slug is CHARACTER-FOR-CHARACTER the one the server derives", async () => {
  // Not four hand-written expectations: the actual SQL, run, compared against
  // the actual TypeScript. They had already diverged — the SQL fell back to
  // `'repo'` on an empty leaf where `nameToSlug` returns `'dataset'`, so
  // `owner/---` would have minted a repo the server then failed to find,
  // creating a SECOND row for the same GitHub repo.
  //
  // Only the rows that did NOT collide: a collision is broken by `_2`, which is
  // the migration's own business and has no TypeScript counterpart.
  const repos = await rows<{ slug: string; github_repo: string }>(
    `select slug, github_repo from repos
      where slug not like '%\\_2' and slug not like '%\\_3'
      order by slug`,
  );
  assert.ok(repos.length >= 3, "there are rows to compare");
  for (const r of repos) {
    assert.equal(r.slug, repoSlugFromGitHub(r.github_repo), `slug for ${r.github_repo}`);
  }
});

test("…including a repo whose name slugifies to NOTHING", async () => {
  // The divergence above, exercised directly. `'---'` has no alphanumerics, so
  // both sides have to reach for the same fallback.
  await client.unsafe(`
    insert into datasets (user_id, name, status, github_repo, github_branch, github_use_token)
    values ('11111111-1111-1111-1111-111111111111', 'odd', 'ready', 'acme/---', 'main', false)
  `);
  const [{ base }] = await rows<{ base: string }>(`
    select COALESCE(
      NULLIF(left(btrim(regexp_replace(lower(
        regexp_replace(regexp_replace(btrim('acme/---'), '\\.git$', ''), '^.*[/:]', '')
      ), '[^a-z0-9]+', '_', 'g'), '_'), 48), ''),
      'dataset'
    ) AS base
  `);
  assert.equal(base, repoSlugFromGitHub("acme/---"), "the SQL fallback and nameToSlug agree");
  await client.unsafe(`delete from datasets where name = 'odd'`);
});

test("membership became a foreign key — including the dead rows, which is correct", async () => {
  // A dead row still BELONGS to the repo; what changed is that membership is now
  // filtered by status wherever it is used, rather than being a text match that
  // never was.
  const members = await rows<{ name: string; repo_slug: string | null }>(
    `select d.name, r.slug as repo_slug
       from datasets d left join repos r on r.id = d.repo_id
      order by d.name`,
  );
  assert.deepEqual(members, [
    { name: "private_dead", repo_slug: "private" },
    { name: "private_live", repo_slug: "private" },
    { name: "private_other", repo_slug: "private" },
    { name: "scratch", repo_slug: null },
    { name: "twig_dev", repo_slug: "twig_2" },
    { name: "twig_main", repo_slug: "twig" },
    { name: "urly", repo_slug: "url_repo" },
  ]);
});

test("repo_dir became NOT NULL with '' for the root, so an index can constrain it", async () => {
  // A nullable column cannot be constrained by a partial unique index: two
  // `(repo_id, NULL)` rows do not conflict in Postgres, so the bug would have
  // come straight back.
  const [{ nullable, def }] = await rows<{ nullable: string; def: string }>(
    `select is_nullable as nullable, column_default as def
       from information_schema.columns
      where table_schema = 'public' and table_name = 'datasets' and column_name = 'repo_dir'`,
  );
  assert.equal(nullable, "NO");
  assert.match(def, /''/);
  const dirs = await rows<{ repo_dir: string }>(`select distinct repo_dir from datasets order by 1`);
  assert.deepEqual(dirs.map((d) => d.repo_dir), ["", "datasets/other"]);
});

test("every repo-backed live dataset got its old name pinned as an alias", async () => {
  // This is what keeps share links, saved MCP client configs and committed
  // `malloy-config.json` targets resolving after the public name became
  // `<repo>:<name>`.
  const aliases = await rows<{ alias: string; name: string }>(
    `select a.alias, d.name from dataset_aliases a join datasets d on d.id = a.dataset_id order by a.alias`,
  );
  assert.deepEqual(
    aliases.map((a) => a.alias),
    ["private_live", "private_other", "twig_dev", "twig_main", "urly"],
    "live and repo-backed only",
  );
  // `scratch` has no repo, so its bare name is still its own identity — an alias
  // for it would be a second copy of the same fact that could then drift.
  assert.ok(!aliases.some((a) => a.alias === "scratch"));
  // `private_dead` is not live, so it is not addressable and gets none.
  assert.ok(!aliases.some((a) => a.alias === "private_dead"));
});

test("exactly one model per dataset is ACTIVE, and the tie was broken by version", async () => {
  // Two versions written in the same instant. `order by created_at desc limit 1`
  // ties and returns whichever row Postgres felt like; `version` is monotonic
  // per dataset, so it leads the order.
  const active = await rows<{ dataset_id: string; id: string; version: number }>(
    `select dataset_id, id, version from malloy_models where active order by dataset_id`,
  );
  assert.equal(active.length, 2, "one per dataset that had a model");
  const tied = active.find((a) => a.dataset_id === "aaaaaaaa-0000-0000-0000-000000000002")!;
  assert.equal(tied.id, "eeeeeeee-0000-0000-0000-000000000002");
  assert.equal(tied.version, 2);
});

test("the global name index is gone and the repo-scoped ones are in", async () => {
  const idx = await rows<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'datasets' and indexname like '%name%'
      order by indexname`,
  );
  assert.deepEqual(idx.map((i) => i.indexname), [
    "datasets_repo_name_ready_unique",
    "datasets_unscoped_name_ready_unique",
  ]);
});

test("…so two repos can now hold a dataset of the same name, which they could not", async () => {
  // The collision the whole rewrite is for. Both directions: the insert succeeds
  // now, and putting the pre-rewrite index back makes it impossible.
  await client.unsafe(`
    insert into datasets (user_id, name, status, repo_id, repo_dir)
      select '11111111-1111-1111-1111-111111111111', 'shared', 'ready', id, 'datasets/shared'
        from repos where slug in ('private', 'twig')
  `);
  const [{ n }] = await rows<{ n: string }>(
    `select count(*)::text as n from datasets where name = 'shared' and status = 'ready'`,
  );
  assert.equal(n, "2");
  await assert.rejects(
    () =>
      client.unsafe(
        `create unique index tmp_global on datasets (name) where status = 'ready'`,
      ) as unknown as Promise<unknown>,
    /duplicat|unique index/i,
    "the index 0026 dropped is unsatisfiable over this, which is what it cost",
  );
  await client.unsafe(`delete from datasets where name = 'shared'`);
});

test("the three old columns are still THERE, and that is the point", () => {
  // No entry in this release DROPS them. A Vercel build applies the journal
  // before promoting the new code, so an entry dropping a column the currently
  // live version still selects takes that version down for the length of the
  // deploy — and the live version selects whole `datasets` rows in half a dozen
  // places. The drop is one command in a LATER release.
  //
  // What stops anything reading them meanwhile is
  // src/lib/dead-columns.test.ts, which greps the source. This test only
  // records the decision where someone looking at the migration will see it.
  //
  // The tip assertion is a tripwire, not bookkeeping: it fails on ANY new
  // journal entry so that whoever added it has to come here, decide whether it
  // is safe to apply before promotion, and say so in REVIEWED_AFTER_REWRITE.
  // It has already earned its keep once.
  const entries = journal.map((e) => e.tag);
  assert.ok(!entries.some((t) => t.includes("drop_dataset_github")), "no drop entry in this release");
  assert.equal(
    entries[entries.length - 1],
    JOURNAL_TIP,
    "a new journal entry was added — check it is safe to apply BEFORE the new code is promoted, then list it in REVIEWED_AFTER_REWRITE",
  );
});

test("a full journal replay reproduces the same schema as a staged one", async () => {
  // The migration path and `drizzle-kit export` agreeing is pinned by
  // scripts/migrate-test.sh. What is pinned HERE is narrower and is the thing a
  // hand-reordered migration can break: replaying the whole journal on an empty
  // database lands on the same columns and indexes as replaying to 0025,
  // seeding, and then migrating.
  const staged = await rows<{ sig: string }>(`
    select coalesce(string_agg(sig, E'\\n' order by sig), '') as sig from (
      select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable as sig
        from information_schema.columns where table_schema = 'public'
      union all
      select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
    ) t
  `);
  await replayTo(MIGRATION);
  const fresh = await rows<{ sig: string }>(`
    select coalesce(string_agg(sig, E'\\n' order by sig), '') as sig from (
      select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable as sig
        from information_schema.columns where table_schema = 'public'
      union all
      select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
    ) t
  `);
  assert.equal(fresh[0].sig, staged[0].sig);
});
