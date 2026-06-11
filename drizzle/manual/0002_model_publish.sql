-- 0002_model_publish — hand-written, idempotent. Safe to re-run.
--
-- Adds the columns the malloyyo CLI publish path needs:
--   * malloy_models.git_*        — git provenance of a pushed model version
--   * datasets.last_publish_*    — last publish attempt (success or failure)
--
-- The repo uses `drizzle-kit push` (not generated migrations); this ships as a
-- hand-written SQL file so live DBs can be upgraded without an interactive push.
--
-- Run ONCE per deployment with psql, e.g.:
--   npx dotenv-cli -e local/staging -- bash -c 'psql "$DATABASE_URL" -f drizzle/manual/0002_model_publish.sql'

ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_repo   text;
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_branch text;
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_sha    text;
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_dirty  boolean;

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_at     timestamptz;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_sha    text;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_branch text;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_error  text;
