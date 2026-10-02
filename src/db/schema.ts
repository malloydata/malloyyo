// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from "drizzle-orm/pg-core";

// Postgres bytea (binary blob). Used for the gzip-compressed compiled ModelDef.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
import type { AdapterAccountType } from "next-auth/adapters";
import { instanceSlug } from "../lib/slug";
// "mcp" is query traffic against /mcp; "publish" is the CLI's model surface
// (push + status). Defined away from here so a client component can read it.
import { API_TOKEN_SCOPES, type ApiTokenScope } from "../lib/api-token-scopes";
export { API_TOKEN_SCOPES };
export type { ApiTokenScope };

export const datasetStatus = pgEnum("dataset_status", [
  "pending",
  "ingesting",
  "introspecting",
  "modeling",
  "ready",
  "failed",
]);

// Membership is a fact about a person, recorded durably — the row, not an env
// var, answers "may they use this instance." `pending` is a newcomer awaiting
// approval; `disabled` is revocation, effective on the next request because
// every request re-reads the row (src/lib/authorize.ts).
export const userStatus = pgEnum("user_status", ["pending", "active", "disabled"]);

// owner = provisioned the instance (always ≥1 admin, not demotable by non-owners);
// admin = invite/revoke/manage; member = ordinary use. Where sign-in is owned by
// an integration this column mirrors the provider's role claim (like is_admin);
// it is authoritative only for the application's own sign-in.
export const userRole = pgEnum("user_role", ["owner", "admin", "member"]);

// Shared with Auth.js via @auth/drizzle-adapter.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
  image: text("image"),
  isAdmin: boolean("is_admin").notNull().default(false),
  // Fail-closed default: a row minted by any path that forgets to decide lands
  // `pending`, never `active`. The paths that do decide: the createUser event
  // (src/lib/admission.ts) for the application's own sign-in, and
  // findOrCreateExternalUser for an integration's.
  status: userStatus("status").notNull().default("pending"),
  role: userRole("role").notNull().default("member"),
  /**
   * Every role this person holds — built-in and your own, in one list.
   *
   * Supersedes the single `role` column above, which stays for now because
   * older rows carry their authority there and `isAdmin()` still reads it. New
   * grants land here; see src/lib/roles.ts.
   */
  roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
  // The stable subject identifier from an external identity provider, for deployments
  // whose sign-in is provided by one rather than by the OAuth providers above. Null
  // everywhere else, and nothing about the default NextAuth path reads it.
  //
  // It exists because email is not a reliable key for such providers: a sign-in may
  // reveal no address at all (enterprise SSO commonly does not), and a subject identifier
  // survives the person changing theirs. See docs/authentication.md.
  externalAccountId: text("external_account_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const authenticators = pgTable(
  "authenticators",
  {
    credentialID: text("credential_id").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: text("provider_account_id").notNull(),
    credentialPublicKey: text("credential_public_key").notNull(),
    counter: integer("counter").notNull(),
    credentialDeviceType: text("credential_device_type").notNull(),
    credentialBackedUp: boolean("credential_backed_up").notNull(),
    transports: text("transports"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.credentialID] })],
);

/**
 * The roles this instance knows about.
 *
 * A catalog rather than free text on each user, so the admin UI can offer a
 * list, a typo cannot silently create a role nobody holds, and a role can be
 * described ("who should have this?") where it is defined.
 *
 * Two namespaces share the table. BUILT-IN roles (`MALLOYYO_*`) say what a
 * person may DO on this instance and cannot be created or deleted. Everything
 * else is yours — `finance`, `sales` — and says which datasets a person may
 * OPEN. The split is the whole access model: capability from the instance,
 * reach from you.
 */
export const roles = pgTable("roles", {
  /** Lowercase for yours; `MALLOYYO_*` for the built-ins. The primary key,
      because a role IS its name everywhere else — on a user, on a dataset, and
      in `$MALLOYYO_ROLES` inside a model. */
  name: text("name").primaryKey(),
  description: text("description"),
  /** Built-ins are seeded and undeletable; the UI hides their delete button and
      the route refuses anyway. */
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * The givens a dataset can be scoped by — the checkbox list an admin sees.
 *
 * A catalog rather than a hardcoded pair, because the interesting version of
 * this is the one that is not built in: `ORGANIZATION` on a customer-reports
 * dataset, satisfied from a value set on the user or on one of their roles.
 * That work is designed but not built (docs/given-variables.md); the table
 * exists now so adding it is rows and a resolver rather than another migration
 * through every call site.
 *
 * BUILT-IN givens resolve from the session itself and are seeded here. Anything
 * else will resolve from a value attached to the user or to a role they hold,
 * and cannot be created yet.
 */
export const givens = pgTable("givens", {
  /** The name a model declares and a dataset requires — `MALLOYYO_EMAIL`,
      later `ORGANIZATION`. The primary key, because the name IS the identity
      everywhere else. */
  name: text("name").primaryKey(),
  description: text("description"),
  /** Resolved from the session. The others (none yet) resolve from variables. */
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * What made a revision: a `malloyyo publish`, or a GitHub pull.
 *
 * On the REVISION rather than the repo, because they are not alternatives — a
 * repo attached to GitHub can also be pushed to directly, and which one produced
 * the bytes that are live is the question people actually ask.
 */
export const repoRevisionSource = pgEnum("repo_revision_source", ["cli", "github"]);

/**
 * A MODEL REPO — the unit of publish, as a thing rather than a coincidence.
 *
 * It used to be a query predicate: `datasets` rows that happened to share
 * `(github_repo, github_branch)`, two nullable text columns any admin could edit
 * one row at a time. Nearly every serious bug in that design was a consequence —
 * a credential stored per dataset and resolved by `rows[0]` on an unordered
 * query, a refresh fanning out to seven dead rows, a CLI publish stamping a
 * branch that made its own output GitHub-overwritable, and no owner and no head
 * commit anywhere.
 *
 * So: one row per repo. Everything that is true of the REPO lives here, once.
 *
 * GITHUB IS OPTIONAL AND SEPARATE. `github_repo` null means "this repo arrived
 * by `malloyyo publish` and is not attached to GitHub" — which is the common case
 * and used to be unexpressible, because one pair of columns meant both "these
 * datasets belong together" and "GitHub backs this". A CLI publish therefore had
 * to assert the second to say the first, and stamped the author's local branch
 * name; the refresh button then pulled `github.com/<slug>@wip` over the top of
 * what had just been pushed. Attaching a repo to GitHub is now a separate,
 * deliberate act.
 */
export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The repo's name on this instance, and the NAMESPACE its datasets live in:
     * a dataset is addressed `<slug>:<name>`, which is what makes two repos able
     * to publish a `sales` each.
     *
     * Defaulted from the GitHub repo name on creation and never changed by a
     * publish — it is baked into every qualified name, so it is the repo's
     * identity, not a label that follows the config.
     */
    slug: text("slug").notNull(),
    /** Presentation only, as on a dataset. Null means derive from the slug. */
    title: text("title"),
    /**
     * WHO OWNS THE REPO. Publishing to it is the owner's or an admin's, which is
     * the gate the first implementation shipped without — a repo had no owner to
     * check, so any member with a publish token could overwrite anyone's
     * datasets, and compiling a model resolves schemas by running SQL against
     * this server's own configured connections.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `owner/name`, or null for a repo that is not attached to GitHub. */
    githubRepo: text("github_repo"),
    /** Only meaningful with `github_repo`. The branch a refresh pulls. */
    githubBranch: text("github_branch"),
    /**
     * May this server send its `GITHUB_TOKEN` when reading the repo?
     *
     * A property of A REPO — can we read it? — and it used to be stored once per
     * dataset. In the production fork one repo had three rows with two different
     * values and the refresh picked a winner with `rows[0]` on a query with no
     * ORDER BY; for a private repo that is an intermittent failure that flips
     * with row order. One repo, one answer.
     */
    githubUseToken: boolean("github_use_token").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("repos_slug_unique").on(t.slug),
    // One repo per GitHub (repo, branch). Two repos claiming the same one would
    // make a webhook push ambiguous and let two owners overwrite each other's
    // datasets from the same commit.
    uniqueIndex("repos_github_unique")
      .on(t.githubRepo, t.githubBranch)
      .where(sql`github_repo is not null`),
    index("repos_owner_idx").on(t.ownerId),
  ],
);

/**
 * ONE PUBLISH OF A REPO — the bytes, and what became of them.
 *
 * A revision is created by a `malloyyo publish` or a GitHub push, holds the
 * repo's content as a ZIP, and is INERT until it is activated. Nothing serves
 * from a revision that is not `active`, which is the whole point:
 *
 *   store the archive  →  materialize it  →  compile every dataset in it
 *                      →  activate, or record why not
 *
 * The store happens first and commits on its own. That is safe precisely because
 * the row is inert — a process that dies mid-compile leaves a revision nobody
 * reads, with the previous one still serving. The design it replaces inserted
 * `ready` dataset rows, compiled, and deleted them again on failure; that is a
 * compensating action, and a compensating action only runs if the process
 * survives to run it. A timeout during a compile (which does network I/O and
 * resolves schemas by running SQL, so it is the slow part) left dataset rows
 * holding their names under a unique index with nothing able to release them.
 *
 * A ZIP, not a tar.gz and not per-file rows. Per-file rows made "what is in this
 * repo" a question about a table rather than about the repo. Between the two
 * archive formats, gzip is one stream and cannot be read partially, while a zip
 * has a central directory with per-member offsets and independent deflate — so
 * one dataset's files can be read without inflating the rest, and a member's
 * uncompressed size is known before anything is inflated, which is what bounds
 * a decompression bomb.
 */
export const repoRevisions = pgTable(
  "repo_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** 1, 2, 3 … within the repo. What a human calls it. */
    revision: integer("revision").notNull(),
    source: repoRevisionSource("source").notNull(),
    /** Who published it. Null for a GitHub webhook, which has no user. */
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * THE HEAD COMMIT, which the old design had nowhere to put. For a GitHub
     * revision this is the commit the branch pointed at; for a CLI revision it
     * is what the author's working tree was on, and `git_dirty` says whether it
     * was the commit or something on top of it.
     */
    gitSha: text("git_sha"),
    gitBranch: text("git_branch"),
    gitDirty: boolean("git_dirty"),
    /** The repo, as a zip. See the note above. */
    archive: bytea("archive").notNull(),
    archiveBytes: integer("archive_bytes").notNull(),
    /** sha256 of the zip. Lets a webhook storm recognise bytes it already has. */
    archiveSha256: text("archive_sha256").notNull(),
    /**
     * What this revision DECLARES it publishes, from the layout rules — one
     * entry per dataset directory. Recorded at verify time so "what does the
     * live revision publish" is answerable without unpacking the archive, and so
     * a directory no dataset covers yet is reportable.
     */
    datasets: jsonb("datasets").$type<Array<{ name: string; dir: string }>>(),
    /**
     * Does this revision carry `.devcontainer/devcontainer.json` — i.e. does the
     * repo open as a working codespace?
     *
     * A fact about the REPO's content, recorded once at verify time, because the
     * alternative is asking GitHub on every page view (which with GITHUB_TOKEN
     * unset spends a 60/hour budget on the home page) or probing a per-file
     * table (which no longer exists for revision-backed models).
     */
    hasDevcontainer: boolean("has_devcontainer").notNull().default(false),
    /** Set when every dataset in it compiled. Null means it never did. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Why verification failed, for the revision that did not go live. */
    verifyError: text("verify_error"),
    /**
     * IS THIS WHAT THE REPO SERVES? Exactly one revision per repo may be, and
     * the partial unique index below is what guarantees it — a flag with a
     * constraint rather than a pointer column on `repos`, so a repo cannot be
     * made to point at another repo's revision at all.
     */
    active: boolean("active").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("repo_revisions_repo_revision_unique").on(t.repoId, t.revision),
    uniqueIndex("repo_revisions_one_active").on(t.repoId).where(sql`active`),
    index("repo_revisions_repo_created_idx").on(t.repoId, t.createdAt),
  ],
);

export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * What to CALL it, as against what it is.
     *
     * `name` is the identity — a slug, the URL, what a publish matches on and
     * what a role is granted against. This is presentation only: the model
     * declares it with `## dataset { title="HubSpot CRM" }`. Null means derive
     * it from the name (`hub_spot` → "Hub Spot"), so a dataset that never says
     * anything still reads properly. Never used to look a dataset up — two
     * datasets may share a title, and nothing stops them.
     */
    title: text("title"),
    /** The model's own doc string (`##"`) — what this dataset is, for someone
        deciding whether they want it or who should see it. */
    description: text("description"),
    isPublic: boolean("is_public").notNull().default(false),
    status: datasetStatus("status").notNull().default("pending"),
    statusError: text("status_error"),
    /**
     * WHICH REPO PUBLISHES THIS DATASET. A real foreign key, which is the whole
     * rewrite in one column: membership used to be recomputed on every refresh by
     * matching two denormalized text columns, with no status filter — measured
     * against the production fork, one repo matched seven rows, none of them
     * `ready`, so a single webhook push compiled the same model seven times and
     * wrote seven model versions for datasets nobody could see.
     *
     * NULL is a dataset that no repo publishes: a Claude-authored one, or the
     * single-dataset `malloyyo publish --dataset x` path, which sends no repo.
     */
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    /**
     * Where in the repo this dataset lives: the directory holding its
     * `index.malloy` and its `dashboards/`, e.g. `datasets/finance`.
     *
     * `''` IS THE REPO ROOT — not null, deliberately. A nullable column cannot
     * be constrained by a partial unique index (two `(repo_id, NULL)` rows do not
     * conflict in Postgres), and `datasets_repo_dir_ready_unique` below is what
     * makes "seven live rows for one directory" impossible rather than merely
     * unexpected.
     *
     * `malloy-config.json` is NOT necessarily under here. The nearest one wins,
     * walking up to the repo root — which is `discoverConfig`'s rule, and what
     * makes a shared `lib/` importable by relative path from any dataset.
     */
    repoDir: text("repo_dir").notNull().default(""),
    /**
     * The givens this dataset is scoped by: supplied on every query against it,
     * locked so no caller can choose them, and required of every model
     * published to it (src/lib/tenancy.ts).
     *
     * CONFIGURED, not derived. An admin ticks them; the model must then declare
     * them or its publish is refused. The authority sits with the dataset
     * because that is where access is decided — a model arriving from a repo
     * should not be able to decide, by what it happens to import, whether the
     * data it serves is scoped.
     *
     * The exception is dataset CREATION, which has no admin to have ticked
     * anything yet: a dataset created by a publish takes its requirements from
     * that first model. From then on the list is the admin's.
     *
     * Empty (the default) is an ordinary, unscoped dataset.
     */
    requiredGivens: text("required_givens").array().notNull().default(sql`'{}'::text[]`),
    /**
     * The roles that may OPEN this dataset. Hold one of them and you may query
     * its sources and read its dashboards; hold none and it is not in your
     * answer at all — not listed, not queryable.
     *
     * Empty is not "everyone": it means nobody but the owner (and anyone, if
     * `isPublic`). Access only ever widens by someone granting it.
     */
    roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
    // Last malloyyo-CLI publish attempt (success OR failure). Failures are recorded here
    // for visibility but never become a servable model version — see the transactional
    // publish design (docs/model-publishing-design.md §4.4). lastPublishError is null on success.
    lastPublishAt: timestamp("last_publish_at", { withTimezone: true }),
    lastPublishSha: text("last_publish_sha"),
    lastPublishBranch: text("last_publish_branch"),
    lastPublishError: text("last_publish_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    index("datasets_user_id_idx").on(t.userId),
    index("datasets_repo_idx").on(t.repoId),
    /**
     * Names are unique WITHIN A REPO, not on the instance.
     *
     * The global index this replaces (`datasets_name_ready_unique`) is why two
     * repos could not both publish a `sales`: a repo brings N common nouns into
     * one namespace, and `sales`, `orders` and `users` are what model
     * directories are actually called. The public name is now `<repo>:<name>`
     * (src/lib/repos.ts), so the collision has nowhere left to happen.
     */
    uniqueIndex("datasets_repo_name_ready_unique")
      .on(t.repoId, t.name)
      .where(sql`status = 'ready' and repo_id is not null`),
    /**
     * NOT unique, deliberately.
     *
     * Two live datasets on one directory is a real configuration: the same model
     * served twice, scoped differently — `required_givens` and `roles` are the
     * dataset's, not the model's. Forbidding it would also have made the
     * migration able to FAIL on real data (a repo added twice under two names
     * is an ordinary thing to find in production), and a migration that can fail
     * on data it did not choose is a landmine in a deploy.
     *
     * The bug this looks like it should prevent — a refresh fanning out to seven
     * rows for one directory, none of them live — is prevented by `repo_id`
     * being a foreign key and by the `status = 'ready'` filter on membership,
     * not by this. So: the unit of COMPILE is a directory, and the unit of
     * WRITE is a dataset (src/lib/repo-publish.ts).
     */
    index("datasets_repo_dir_idx").on(t.repoId, t.repoDir),
    /**
     * A dataset no repo publishes still has only its bare name to be addressed
     * by, so that name still has to be unique — among the repo-less ones.
     */
    uniqueIndex("datasets_unscoped_name_ready_unique")
      .on(t.name)
      .where(sql`status = 'ready' and repo_id is null`),
  ],
);

/**
 * AN OLD NAME, PINNED TO THE DATASET IT USED TO MEAN.
 *
 * Dataset names were globally unique and are now scoped to a repo, so the public
 * name of `sales` became `acme:sales`. More things depended on the old spelling
 * than it looks: shareable query slugs and saved MCP client configs are out in
 * the world, `--dataset <name>` targets by name, and `malloy-config.json` files
 * in people's repos name their target. Renaming every dataset without an alias
 * path would break all of it silently.
 *
 * The table FREEZES the historical meaning, which a plain fall-back-to-bare-name
 * rule cannot. Without it, the day a second repo publishes its own `sales` every
 * old link to the first becomes ambiguous — with it, `sales` keeps resolving to
 * the dataset it always meant, and the newcomer is reachable as `other:sales`.
 *
 * `alias` is the primary key: one global namespace, one answer, no ordering.
 */
export const datasetAliases = pgTable(
  "dataset_aliases",
  {
    alias: text("alias").primaryKey(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("dataset_aliases_dataset_idx").on(t.datasetId)],
);

export const malloyModels = pgTable(
  "malloy_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    /**
     * The repo revision this model was compiled out of. Null for a model that
     * came from somewhere else: a Claude-authored one, or the single-dataset
     * `--dataset x` push, which carries no repo.
     *
     * It is what makes activation one act for a whole repo. The datasets of a
     * repo move together because they share a revision, so "are these four at
     * the same commit?" is a column comparison rather than four timestamps that
     * happen to be close. Uniform staleness is one comparison; mixed staleness
     * is an investigation.
     */
    revisionId: uuid("revision_id").references(() => repoRevisions.id, { onDelete: "cascade" }),
    /**
     * IS THIS THE MODEL THE DATASET SERVES? Exactly one per dataset, enforced by
     * the partial unique index below.
     *
     * This replaces `order by created_at desc limit 1`, which is not a fact but
     * a guess: two versions written in the same millisecond tie, and the winner
     * is whichever Postgres returned. Activation now says which one, and a read
     * asks instead of ordering.
     */
    active: boolean("active").notNull().default(false),
    version: integer("version").notNull().default(1),
    source: text("source").notNull(),
    generatedBy: text("generated_by").notNull(),
    compiledAt: timestamp("compiled_at", { withTimezone: true }),
    compileError: text("compile_error"),
    // Sources/explores declared in this model, with optional doc-string descriptions.
    // New format: Array<{name, description?}>. Legacy format: string[] (no descriptions).
    sources: jsonb("sources").$type<Array<string | { name: string; description?: string | null }>>(),
    // Git provenance for models pushed via the malloyyo CLI. Null for Claude-authored
    // and (legacy) github-pull models. Stored structured so the UI can render a short
    // SHA, a commit link, and a "dirty" badge.
    gitRepo: text("git_repo"),
    gitBranch: text("git_branch"),
    gitSha: text("git_sha"),
    gitDirty: boolean("git_dirty"),
    // gzip(JSON(Model._modelDef)) — the fully-compiled model. Lets a cold
    // instance rehydrate via Runtime._loadModelFromModelDef instead of paying the
    // per-source schema-fetch compile (worldcup: ~8s → ~0ms). Nullable; null =>
    // compile on the request path, which write-through-backfills this column.
    // Keyed implicitly by the immutable model.id (a repo edit is a new row), so it
    // never needs invalidation. Read lazily (only on a cold-instance miss).
    compiledModelDef: bytea("compiled_model_def"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("malloy_models_dataset_id_idx").on(t.datasetId),
    index("malloy_models_revision_idx").on(t.revisionId),
    uniqueIndex("malloy_models_one_active").on(t.datasetId).where(sql`active`),
  ],
);

// One row per file in a multi-file GitHub-loaded model.
// Keyed by model version (malloy_models.id) + relative path within the repo.
export const malloyModelFiles = pgTable(
  "malloy_model_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id")
      .notNull()
      .references(() => malloyModels.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
  },
  (t) => [
    index("malloy_model_files_model_id_idx").on(t.modelId),
  ],
);

// Dashboard artifacts that ship in the model's repo under ./dashboards/<name>/.
// Ingested the SAME way model files are — on a GitHub refresh or a CLI publish —
// and keyed to the model VERSION, so a reload/publish just re-inserts the current
// dashboards for the new version (mirrors malloy_model_files).
// See docs/repo-artifacts.md.
export const malloyArtifacts = pgTable(
  "malloy_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id")
      .notNull()
      .references(() => malloyModels.id, { onDelete: "cascade" }),
    // Dashboard directory name = slug within the model, e.g. "over-represented".
    name: text("name").notNull(),
    // manifest.title, hoisted for listing without parsing the manifest.
    title: text("title"),
    // Parsed manifest.json (query + givens + layout hints).
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    // The Dashboard.tsx source; bundled at serve time.
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("malloy_artifacts_model_id_idx").on(t.modelId)],
);

// Durable, favoritable queries — the ones we deliberately keep. Created when a
// user saves an edited query in ltool or favorites a run (which promotes the
// run's history row into here). Holds a full COPY of the query so `history` can
// be trimmed without losing saved/shared queries. `slug` is the shareable
// deep-link id, carried over from the history row it was promoted from so
// existing share links keep resolving.
export const savedQueries = pgTable(
  "saved_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").unique().$defaultFn(() => instanceSlug()),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source"),
    question: text("question").notNull(),
    malloySource: text("malloy_source").notNull(),
    compiledSql: text("compiled_sql"),
    authorModel: text("author_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("saved_queries_dataset_id_idx").on(t.datasetId)],
);

// Every event — MCP tool calls AND human ltool runs — one row each, ordered
// within time-window sessions. The trimmable activity log the /ltool history
// view and analytics read from. A successful run mints a `slug` so it's
// immediately shareable; favoriting/saving promotes it into saved_queries
// (which is what survives a trim). Validate-only and failed attempts are kept
// here too (with `error` / `executed=false`) for syntax-error analytics.
export const history = pgTable(
  "history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Time-window session: consecutive activity by one user on one dataset.
    sessionId: uuid("session_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    datasetId: uuid("dataset_id").references(() => datasets.id, { onDelete: "set null" }),
    // Order within the session.
    sequence: integer("sequence").notNull().default(0),
    toolName: text("tool_name").notNull(),
    // Plain-English synopsis of what this query answers. Required on `query`
    // (run AND validate); null on discovery tools.
    question: text("question"),
    source: text("source"),
    malloyInput: text("malloy_input"),
    compiledSql: text("compiled_sql"),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    // true = executed run, false = validate-only (dry run), null = non-query tool.
    executed: boolean("executed"),
    error: text("error"),
    // The client that ran it (MCP client / browser), from the User-Agent header.
    userAgent: text("user_agent"),
    // Who authored the Malloy: a model id, 'human' (ltool edits), or 'assistant'
    // when an MCP client didn't declare one via x-author-model.
    authorModel: text("author_model"),
    // Shareable deep-link id, minted for successful runs (else null).
    slug: text("slug").unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("history_user_id_idx").on(t.userId),
    index("history_session_id_idx").on(t.sessionId),
    index("history_user_dataset_created_idx").on(t.userId, t.datasetId, t.createdAt),
  ],
);

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    savedQueryId: uuid("saved_query_id").notNull().references(() => savedQueries.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.userId, t.savedQueryId] })],
);

// OAuth 2.1 client registry (RFC 7591). One row per MCP client.
export const oauthClients = pgTable("oauth_clients", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull(),
  responseTypes: jsonb("response_types").$type<string[]>().notNull(),
  scope: text("scope").notNull().default("mcp"),
  registeredFromIp: text("registered_from_ip"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// One-time-use authorization codes, 60s TTL, PKCE S256 mandatory.
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("oauth_auth_codes_expires_idx").on(t.expiresAt)],
);

// Bearer access tokens, 24h TTL. Hash stored, never the raw token.
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("oauth_access_tokens_user_client_idx").on(t.userId, t.clientId),
    index("oauth_access_tokens_expires_idx").on(t.expiresAt),
  ],
);

// Refresh tokens, rotated on every use, 90d TTL. replacedById is the theft canary.
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tokenHash: text("token_hash").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: text("replaced_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("oauth_refresh_tokens_user_client_idx").on(t.userId, t.clientId),
  ],
);

// Personal API tokens: the credential a person hands to the `malloyyo` CLI or a
// CI job. Separate from the OAuth tables above on purpose — those model an
// interactive client (a client row, a refresh token rotated on every use, a 24h
// access token), and an unattended build has none of that: no browser to
// redirect, and a 24h expiry that guarantees a red pipeline the next morning
// (docs/model-publishing-design.md §8).
//
// Anyone admitted to the instance may mint one for themselves. That is safe
// because a token is never more than its owner: every request re-reads the
// user row and re-runs authorize() + the dataset check, so a token grants what
// the person can do AT THAT MOMENT, not what they could do when it was minted.
// `scopes` only narrows that further.
//
// The raw value is never stored — only its sha256 (`tokenHash`) and the
// human-readable head (`prefix`, e.g. "myo_stg_a1b2c3d4"), which is enough to
// tell two tokens apart in the UI and nowhere near enough to use one.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // What it is for, in the owner's words ("github actions", "laptop").
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    // Which surfaces this token may reach: "mcp" (query) and/or "publish"
    // (model push + status). jsonb rather than an enum array so adding a scope
    // is data, not a migration — the same reasoning as instanceSettings.accessPolicy.
    scopes: jsonb("scopes").$type<ApiTokenScope[]>().notNull(),
    // NULL means never expires — a deliberate choice, not a missing value: a CI
    // credential that lapses silently breaks the build at 3am. `lastUsedAt` is
    // what makes a forgotten one visible instead.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

// A standing invitation: an address an admin admitted before the person ever
// arrived. Consumed on first sign-in (acceptedAt set, the new row lands
// `active`). A separate table rather than a placeholder `users` row on purpose:
// Auth.js refuses an OAuth sign-in whose email matches an existing unlinked
// user (OAuthAccountNotLinked), so a placeholder would block the very sign-in
// it meant to permit.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored lowercase; matched case-insensitively at sign-in.
    email: text("email").notNull(),
    role: userRole("role").notNull().default("member"),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedById: uuid("accepted_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    // One OPEN invitation per address; accepted ones are history and may repeat.
    uniqueIndex("invitations_email_open_unique").on(t.email).where(sql`accepted_at IS NULL`),
  ],
);

// Per-instance, editable presentation settings. Keyed by INSTANCE_CODE so
// several instances sharing one DB stay distinct. Currently just the front-page
// tagline; a null/absent row means "use the built-in default".
export const instanceSettings = pgTable("instance_settings", {
  instanceCode: text("instance_code").primaryKey(),
  // Stable, anonymous identity for this installation. Hosted analytics use the
  // control-plane tenant id as their instance id, but still use this random UUID
  // as the salt when pseudonymizing local users.
  telemetryId: uuid("telemetry_id").notNull().defaultRandom(),
  tagline: text("tagline"),
  signinNotice: text("signin_notice"),
  // Who may join: 'open' | 'invite' (see src/lib/access-policy.ts). Text rather
  // than an enum so a future policy ('domain') is data, not a schema migration.
  // Null means the safe default, 'invite' — except on databases upgraded from
  // the EMAIL_ALLOW_LIST era, where seeding records the equivalent policy
  // explicitly (src/lib/access-upgrade.ts).
  accessPolicy: text("access_policy"),
  /**
   * The roles a person is given when they are first admitted. Null means the
   * safe default — `MALLOYYO_USER` alone, so a new arrival can sign in and sees
   * nothing until someone grants them a dataset-bearing role deliberately.
   */
  defaultRoles: text("default_roles").array(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// The settings namespace lent to an authentication integration (see
// src/lib/hosted-auth.ts): key/value per instance, reached only through
// src/lib/integration-settings.ts. Separate from instance_settings on purpose —
// that table is the application's, typed column by column; this one belongs to
// code the application does not own, so its keys are data and adding one is not
// a migration. Absence of a row means unset.
export const integrationSettings = pgTable(
  "integration_settings",
  {
    instanceCode: text("instance_code").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.instanceCode, t.key] })],
);

// ── chat ─────────────────────────────────────────────────────────────
// A conversation with a model about ONE source. Scoped that narrowly on
// purpose: the model is given that source's schema and nothing else, which is
// what keeps a turn cheap and the answers grounded.
export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The dataset by NAME and the source within it. Names are not unique across
    // datasets — two may each define "orders" — so the pair is the identity,
    // the same pair the source pickers carry (see SchemaPanel's SourceOption).
    dataset: text("dataset").notNull(),
    source: text("source").notNull(),
    // Written from the first question, so the list reads as questions asked
    // rather than "New chat (3)".
    title: text("title"),
    // Shared READ-ONLY with anyone signed in to this instance. Not an ACL and
    // not an invitation to join: a public chat can be read, never added to, so
    // it stays one person's conversation rather than becoming a room. Only
    // grantable on a PUBLIC dataset — a chat carries rows, and publishing one on
    // a private dataset would route around that dataset's own privacy.
    isPublic: boolean("is_public").notNull().default(false),
    // What answered. Recorded per chat rather than per message because a
    // conversation the model switched mid-way through is a different artifact,
    // and knowing which one it was is how a cheaper model gets evaluated.
    model: text("model"),
    effort: text("effort"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("chats_user_updated_idx").on(t.userId, t.updatedAt)],
);

// One row per message, holding the RAW Anthropic content-block array.
//
// Not flattened to text, and not normalised: thinking blocks must be echoed
// back unchanged on the same model, and tool_use/tool_result blocks have to
// round-trip exactly or the next turn is rejected. The array as the API
// returned it is the only faithful record, and it is what gets replayed.
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    // Order within the conversation. Explicit rather than inferred from
    // created_at, which ties on a fast turn.
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("chat_messages_chat_seq_unique").on(t.chatId, t.seq)],
);

// What a query in a chat produced, for the SCREEN.
//
// Deliberately not inside chat_messages.content. The message array is replayed
// to the model on every turn, and a stable_result is large and useless to it —
// it already read the rows. The two transcripts differ: the model's is compact
// text, the human's is a rendered result. `tool_use_id` is what joins them.
export const chatResults = pgTable(
  "chat_results",
  {
    // The model's own id for the tool call this answers. Unique per chat, and
    // the join key back into the message that requested it.
    toolUseId: text("tool_use_id").primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    malloy: text("malloy"),
    sql: text("sql"),
    rowCount: integer("row_count"),
    // The Malloy interfaces-format result, for @malloydata/render on the
    // client. Row-capped upstream — this is a transcript, not a warehouse.
    stableResult: jsonb("stable_result"),
    // The history slug the run minted, which is the ltool deep link.
    slug: text("slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("chat_results_chat_idx").on(t.chatId)],
);

// Draft dashboards: made from the MCP surface (save_draft_dashboard), stored
// here until they are promoted into the model repo. Each is one
// dashboard's pair of files — the `dashboards/<name>.malloy` text and the
// optional component — pinned to the model version it was built against, and
// addressed as the dashboard name `draft-<slug>` so every dashboard route
// (page, frame, bundle, run, the MCP panel) serves it unchanged.
//
// Unlisted, not private: anyone who can read the dataset and has the slug can
// view it; only its creator can overwrite it. The .malloy text has passed the
// restricted gate (no raw SQL / connections / imports) before it is stored —
// see src/lib/dashboards/draft.ts — which is what makes it safe to compile
// as a model file.
export const draftDashboards = pgTable(
  "draft_dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    // The model version this draft was last saved against — provenance. A
    // draft RENDERS against the dataset's current model, so an additive model
    // change reaches it and a real break shows up instead of being deferred.
    modelId: uuid("model_id")
      .notNull()
      .references(() => malloyModels.id, { onDelete: "cascade" }),
    // The dashboard's own name (its file basename), e.g. "trend".
    name: text("name").notNull(),
    title: text("title"),
    // Same shape as malloy_artifacts.manifest (entryFile, tiles/query, …).
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    // dashboards/<name>.malloy, as submitted.
    malloy: text("malloy").notNull(),
    // The optional component (JSX/TSX); empty for a tag-only dashboard.
    source: text("source").notNull().default(""),
    // Set when the draft has been promoted into a repo: the dashboard name it
    // was written as, and a hash of what was written. Kept so a promoted draft
    // can later forward to the published dashboard instead of 404ing, and so
    // divergence (the draft kept being edited after promotion) is detectable.
    // The draft row is never deleted by promotion.
    promotedAs: text("promoted_as"),
    promotedHash: text("promoted_hash"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("draft_dashboards_user_idx").on(t.userId, t.updatedAt)],
);

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type RepoRevision = typeof repoRevisions.$inferSelect;
export type RepoRevisionSource = (typeof repoRevisionSource.enumValues)[number];
export type DatasetAlias = typeof datasetAliases.$inferSelect;
export type Dataset = typeof datasets.$inferSelect;
export type NewDataset = typeof datasets.$inferInsert;
export type DatasetStatus = (typeof datasetStatus.enumValues)[number];
export type MalloyModel = typeof malloyModels.$inferSelect;
export type MalloyModelFile = typeof malloyModelFiles.$inferSelect;
export type SavedQuery = typeof savedQueries.$inferSelect;
export type HistoryRow = typeof history.$inferSelect;
export type User = typeof users.$inferSelect;
export type UserStatus = (typeof userStatus.enumValues)[number];
export type UserRole = (typeof userRole.enumValues)[number];
export type Invitation = typeof invitations.$inferSelect;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Favorite = typeof favorites.$inferSelect;
export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type IntegrationSetting = typeof integrationSettings.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type ChatResult = typeof chatResults.$inferSelect;
export type DraftDashboard = typeof draftDashboards.$inferSelect;
