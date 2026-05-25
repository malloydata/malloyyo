import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const datasetStatus = pgEnum("dataset_status", [
  "pending",
  "ingesting",
  "introspecting",
  "modeling",
  "ready",
  "failed",
]);

// Shared with Auth.js via @auth/drizzle-adapter. slug is malloyyo-specific
// (the /mcp/<slug> path segment) assigned on first sign-in.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").unique(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
  image: text("image"),
  isAdmin: boolean("is_admin").notNull().default(false),
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
    sourceUrl: text("source_url").notNull(),
    mdTable: text("md_table").notNull(),
    rowCount: integer("row_count"),
    isPublic: boolean("is_public").notNull().default(false),
    status: datasetStatus("status").notNull().default("pending"),
    statusError: text("status_error"),
    schemaJson: jsonb("schema_json"),
    sampleRowsJson: jsonb("sample_rows_json"),
    workflowRunId: text("workflow_run_id"),
    githubRepo: text("github_repo"),
    githubBranch: text("github_branch"),
    githubUseToken: boolean("github_use_token").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [index("datasets_user_id_idx").on(t.userId)],
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
    // Names of Malloy sources/explores declared in this model.
    // Populated for GitHub-loaded models; null for Claude-generated single-file models.
    sources: jsonb("sources").$type<string[]>(),
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

export const queries = pgTable(
  "queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    malloySource: text("malloy_source").notNull(),
    compiledSql: text("compiled_sql"),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("queries_dataset_id_idx").on(t.datasetId)],
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

export type Dataset = typeof datasets.$inferSelect;
export type NewDataset = typeof datasets.$inferInsert;
export type DatasetStatus = (typeof datasetStatus.enumValues)[number];
export type MalloyModel = typeof malloyModels.$inferSelect;
export type MalloyModelFile = typeof malloyModelFiles.$inferSelect;
export type Query = typeof queries.$inferSelect;
export type User = typeof users.$inferSelect;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
