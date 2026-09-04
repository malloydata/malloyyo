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

export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isPublic: boolean("is_public").notNull().default(false),
    status: datasetStatus("status").notNull().default("pending"),
    statusError: text("status_error"),
    githubRepo: text("github_repo"),
    githubBranch: text("github_branch"),
    githubUseToken: boolean("github_use_token").notNull().default(true),
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
    // One live (ready) dataset per name on the server — names are used as URLs.
    // Partial: failed/stale dupes (hidden by visibleDatasetWhere) don't conflict.
    uniqueIndex("datasets_name_ready_unique").on(t.name).where(sql`status = 'ready'`),
  ],
);

export const malloyModels = pgTable(
  "malloy_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
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
  (t) => [index("malloy_models_dataset_id_idx").on(t.datasetId)],
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
export type Favorite = typeof favorites.$inferSelect;
export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type IntegrationSetting = typeof integrationSettings.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type ChatResult = typeof chatResults.$inferSelect;
