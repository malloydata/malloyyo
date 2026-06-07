-- 0001_ltool_slugs — hand-written, idempotent. Safe to re-run.
--
-- Run ONCE per deployment with psql, e.g.:
--   psql "$DATABASE_URL" -f drizzle/manual/0001_ltool_slugs.sql
--
-- The repo uses `drizzle-kit push` (not generated migrations), so this data
-- backfill ships as a hand-written SQL file rather than a generated one.
--
-- IMPORTANT: pass THIS deployment's INSTANCE_CODE (e.g. main / stg / gld) so
-- backfilled slugs carry the right instance prefix:
--   psql "$DATABASE_URL" -v code=stg -f drizzle/manual/0001_ltool_slugs.sql
-- If you omit -v code=..., it defaults to 'main'.
\if :{?code}
\else
  \set code main
\endif

BEGIN;

-- 1. Shareable slug column on inquiries (DDL is also in schema.ts for db:push).
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS slug text;

-- 2. Backfill slugs for existing inquiries: <code>_<10 url-safe chars>.
UPDATE inquiries
SET slug = :'code' || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
WHERE slug IS NULL;

-- 3. Enforce uniqueness (matches the schema.ts .unique() constraint).
CREATE UNIQUE INDEX IF NOT EXISTS inquiries_slug_idx ON inquiries (slug);

-- 4. Rename historical tool_calls so existing ltool history survives the
--    MCP tool rename (run_analytical_query -> run_query, etc.).
UPDATE tool_calls SET tool_name = 'run_query'      WHERE tool_name = 'run_analytical_query';
UPDATE tool_calls SET tool_name = 'compile_query'  WHERE tool_name = 'compile_analytical_query';
UPDATE tool_calls SET tool_name = 'describe_source' WHERE tool_name = 'describe_semantic_model';

COMMIT;
