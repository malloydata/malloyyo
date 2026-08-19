-- 0012_push_catchup — written 2026-08-07, when the journal became the boot
-- path (drizzle-orm's migrate() replacing the hand-rolled baseline applier).
--
-- Between 0000 (May 2026) and this entry, schema changes on the managed
-- instances were applied with interactive `drizzle-kit push` and recorded
-- nowhere; only the data-touching subset was written down (the manual files,
-- now journaled as 0001-0011). This entry is the archaeology of everything
-- push applied that no file recorded, so that replaying the whole journal on
-- an empty database reproduces src/db/schema.ts exactly (pinned by
-- scripts/migrate-test.sh against `drizzle-kit export`).
--
-- Every statement is guarded: on a database that already carries these changes
-- (any live managed instance, and any pre-journal self-hosted database that
-- initialized from a newer baseline) this entry is a no-op.
SET search_path TO public;
--> statement-breakpoint

-- 1. NextAuth tables (accounts / sessions / verification_tokens /
--    authenticators) — sign-in moved from slug-only users to Google/Okta.
CREATE TABLE IF NOT EXISTS "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id"),
	CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authenticators" (
	"credential_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"credential_device_type" text NOT NULL,
	"credential_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "authenticators_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id"),
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

-- 2. OAuth 2.0 server tables — bearer tokens on the MCP endpoint.
CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"grant_types" jsonb NOT NULL,
	"response_types" jsonb NOT NULL,
	"scope" text DEFAULT 'mcp' NOT NULL,
	"registered_from_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

-- 3. Per-model source files (the GitHub-loaded Malloy tree).
CREATE TABLE IF NOT EXISTS "malloy_model_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "malloy_model_files_model_id_malloy_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."malloy_models"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

-- 4. datasets: MotherDuck-ingest columns retired, GitHub-repo columns added.
ALTER TABLE "datasets" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN IF NOT EXISTS "github_repo" text;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN IF NOT EXISTS "github_branch" text;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN IF NOT EXISTS "github_use_token" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "source_url";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "md_table";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "row_count";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "schema_json";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "sample_rows_json";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN IF EXISTS "workflow_run_id";--> statement-breakpoint

-- 5. users: profile columns for provider sign-in; slug becomes optional.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "image" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "slug" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_constraint
    WHERE conname = 'users_email_unique' AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email");
  END IF;
  -- 0010 created external_account_id's uniqueness as an INDEX; schema.ts
  -- declares it as a table CONSTRAINT. Converge on the constraint form,
  -- adopting the existing index where one is present.
  IF NOT EXISTS (
    SELECT FROM pg_constraint
    WHERE conname = 'users_external_account_id_unique' AND conrelid = 'public.users'::regclass
  ) THEN
    IF EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'users_external_account_id_unique' AND c.relkind = 'i'
    ) THEN
      ALTER TABLE "users" ADD CONSTRAINT "users_external_account_id_unique" UNIQUE USING INDEX "users_external_account_id_unique";
    ELSE
      ALTER TABLE "users" ADD CONSTRAINT "users_external_account_id_unique" UNIQUE ("external_account_id");
    END IF;
  END IF;
END $$;
--> statement-breakpoint

-- 6. malloy_models: per-source metadata blob.
ALTER TABLE "malloy_models" ADD COLUMN IF NOT EXISTS "sources" jsonb;--> statement-breakpoint

-- 7. Canonicalize constraint names: 0003/0008/0011 created their FKs and one
--    PK inline (auto-named *_fkey / *_pkey); schema.ts names them explicitly.
--    Rename wherever the auto-named form exists so every path — fresh replay,
--    live managed database, pre-journal self-hosted — converges on one name.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('saved_queries', 'saved_queries_dataset_id_fkey',    'saved_queries_dataset_id_datasets_id_fk'),
      ('saved_queries', 'saved_queries_user_id_fkey',       'saved_queries_user_id_users_id_fk'),
      ('history',       'history_user_id_fkey',             'history_user_id_users_id_fk'),
      ('history',       'history_dataset_id_fkey',          'history_dataset_id_datasets_id_fk'),
      ('favorites',     'favorites_user_id_fkey',           'favorites_user_id_users_id_fk'),
      ('favorites',     'favorites_saved_query_id_fkey',    'favorites_saved_query_id_saved_queries_id_fk'),
      ('malloy_artifacts', 'malloy_artifacts_model_id_fkey', 'malloy_artifacts_model_id_malloy_models_id_fk'),
      ('integration_settings', 'integration_settings_pkey', 'integration_settings_instance_code_key_pk')
    ) AS v(tbl, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT FROM pg_constraint
      WHERE conname = r.old_name AND conrelid = ('public.' || r.tbl)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- 8. Indexes for the tables above.
CREATE INDEX IF NOT EXISTS "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "malloy_model_files_model_id_idx" ON "malloy_model_files" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_user_client_idx" ON "oauth_access_tokens" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_expires_idx" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_auth_codes_expires_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_user_client_idx" ON "oauth_refresh_tokens" USING btree ("user_id","client_id");
