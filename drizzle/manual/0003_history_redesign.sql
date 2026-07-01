-- History / saved_queries redesign.
--
-- Flattens conversations + inquiries into a single time-window activity log
-- (`history`), renames queries → saved_queries (durable, favoritable), and
-- re-points favorites at saved_queries. Adds session_id, user_agent,
-- author_model, question, executed, and a per-row slug to the activity log.
--
-- GREENFIELD: this DROPS the old conversations/inquiries/tool_calls/queries and
-- the old favorites. Share slugs minted before this migration will no longer
-- resolve. The dropped tables are copied to *_bak first (disposable-instance
-- safety net); drop the _bak tables once the new schema is verified.
--
-- Idempotent: re-runnable. Run per instance, e.g.
--   psql "$DATABASE_URL" -f drizzle/manual/0003_history_redesign.sql

SET search_path TO public;

-- 1. Back up the tables we're about to drop (only if they still exist).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','inquiries','tool_calls','queries','favorites'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', t || '_bak');
      EXECUTE format('CREATE TABLE %I AS SELECT * FROM %I', t || '_bak', t);
    END IF;
  END LOOP;
END $$;

-- 2. Drop the old tables (favorites first — it FKs inquiries).
DROP TABLE IF EXISTS favorites CASCADE;
DROP TABLE IF EXISTS tool_calls CASCADE;
DROP TABLE IF EXISTS inquiries CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS queries CASCADE;

-- 3. Durable, favoritable saved queries (was `queries`).
CREATE TABLE IF NOT EXISTS "saved_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text,
	"dataset_id" uuid NOT NULL REFERENCES "public"."datasets"("id") ON DELETE cascade,
	"user_id" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"source" text,
	"question" text NOT NULL,
	"malloy_source" text NOT NULL,
	"compiled_sql" text,
	"author_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_queries_slug_unique" UNIQUE("slug")
);

-- 4. The activity log (was `tool_calls`): every MCP + ltool event, sessionized.
CREATE TABLE IF NOT EXISTS "history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"user_id" uuid REFERENCES "public"."users"("id") ON DELETE set null,
	"dataset_id" uuid REFERENCES "public"."datasets"("id") ON DELETE set null,
	"sequence" integer DEFAULT 0 NOT NULL,
	"tool_name" text NOT NULL,
	"question" text,
	"source" text,
	"malloy_input" text,
	"compiled_sql" text,
	"row_count" integer,
	"duration_ms" integer,
	"executed" boolean,
	"error" text,
	"user_agent" text,
	"author_model" text,
	"slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_slug_unique" UNIQUE("slug")
);

-- 5. Favorites, now pointing at durable saved_queries.
CREATE TABLE IF NOT EXISTS "favorites" (
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"saved_query_id" uuid NOT NULL REFERENCES "public"."saved_queries"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_saved_query_id_pk" PRIMARY KEY("user_id","saved_query_id")
);

-- 6. Indexes.
CREATE INDEX IF NOT EXISTS "saved_queries_dataset_id_idx" ON "saved_queries" USING btree ("dataset_id");
CREATE INDEX IF NOT EXISTS "history_user_id_idx" ON "history" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "history_session_id_idx" ON "history" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "history_user_dataset_created_idx" ON "history" USING btree ("user_id","dataset_id","created_at");
