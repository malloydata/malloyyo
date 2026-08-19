-- 0001_ltool_slugs — folded into the journal 2026-08-07 from drizzle/manual/
-- (originally applied by hand with psql, June 2026).
--
-- Adds shareable slugs to `inquiries` and renames historical `tool_calls` rows
-- for the MCP tool rename. Both tables were created by drizzle-kit push (never
-- journaled) and are dropped again in 0003, so everything here is guarded: on a
-- fresh replay, or on a database whose vintage postdates the 0003 redesign,
-- this entry is a no-op. It still matters for pre-redesign databases: 0004's
-- favorites backport keys on inquiry slugs and the renamed tool names.
--
-- The original took the instance code as a psql variable (-v code=...). The
-- journaled form can't; it uses 'main', the INSTANCE_CODE default. Slugs it
-- mints only survive until 0003 drops the table, so the prefix is cosmetic.
DO $$
BEGIN
  IF to_regclass('public.inquiries') IS NOT NULL THEN
    ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS slug text;
    UPDATE inquiries
    SET slug = 'main_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
    WHERE slug IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS inquiries_slug_idx ON inquiries (slug);
  END IF;
  IF to_regclass('public.tool_calls') IS NOT NULL THEN
    UPDATE tool_calls SET tool_name = 'run_query'       WHERE tool_name = 'run_analytical_query';
    UPDATE tool_calls SET tool_name = 'compile_query'   WHERE tool_name = 'compile_analytical_query';
    UPDATE tool_calls SET tool_name = 'describe_source' WHERE tool_name = 'describe_semantic_model';
  END IF;
END $$;
