-- 0003_history_redesign — folded into the journal 2026-08-07 from
-- drizzle/manual/ (originally applied by hand with psql, July 2026).
--
-- Flattens conversations + inquiries into a single time-window activity log
-- (`history`), renames queries -> saved_queries (durable, favoritable), and
-- re-points favorites at saved_queries.
--
-- The dropped tables are copied to *_bak first (safety net for the backport in
-- 0004); drop the _bak tables once the new schema is verified.
--
-- Converge-safe: `favorites` is only backed up and dropped when it is the OLD
-- shape (keyed by inquiry_id). A database whose vintage postdates this
-- redesign already has the new favorites and must keep it — dropping it there
-- would destroy live data, and 0004 could not restore it (no inquiries_bak).
SET search_path TO public;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  -- 1. Back up the tables we're about to drop (only if they still exist).
  FOREACH t IN ARRAY ARRAY['conversations','inquiries','tool_calls','queries'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', t || '_bak');
      EXECUTE format('CREATE TABLE %I AS SELECT * FROM %I', t || '_bak', t);
    END IF;
  END LOOP;
  -- 2a. Old-shape favorites (FKs inquiries): back up, then drop first — it FKs
  --     inquiries. New-shape favorites (saved_query_id) is left untouched.
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'favorites' AND column_name = 'inquiry_id'
  ) THEN
    DROP TABLE IF EXISTS favorites_bak;
    CREATE TABLE favorites_bak AS SELECT * FROM favorites;
    DROP TABLE favorites CASCADE;
  END IF;
  -- Signal to 0004 — scoped to this session, and 0003/0004 always run in the
  -- same migration transaction — that this run actually processed a
  -- pre-redesign database. Without it, 0004 must NOT touch *_bak tables: a
  -- database that ran the redesign BY HAND in July 2026 and kept its backups
  -- would otherwise get its July favorites re-backported over later deletions.
  IF to_regclass('public.inquiries') IS NOT NULL THEN
    CREATE TEMP TABLE _malloyyo_0003_redesigned (x int) ON COMMIT DROP;
  END IF;
END $$;
--> statement-breakpoint
-- 2b. Drop the old tables.
DROP TABLE IF EXISTS tool_calls CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS inquiries CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS conversations CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS queries CASCADE;--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
-- 5. Favorites, now pointing at durable saved_queries.
CREATE TABLE IF NOT EXISTS "favorites" (
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"saved_query_id" uuid NOT NULL REFERENCES "public"."saved_queries"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_saved_query_id_pk" PRIMARY KEY("user_id","saved_query_id")
);
--> statement-breakpoint
-- 6. Indexes.
CREATE INDEX IF NOT EXISTS "saved_queries_dataset_id_idx" ON "saved_queries" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "history_user_id_idx" ON "history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "history_session_id_idx" ON "history" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "history_user_dataset_created_idx" ON "history" USING btree ("user_id","dataset_id","created_at");
