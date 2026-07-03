-- Durable compiled-ModelDef cache.
-- Adds a nullable bytea column holding gzip(JSON(Model._modelDef)) so a cold
-- serverless instance can rehydrate a fully-compiled model via
-- Runtime._loadModelFromModelDef instead of paying the per-source schema-fetch
-- compile. Keyed implicitly by the immutable malloy_models.id (a repo edit is a
-- new row), so it never needs invalidation. Nullable => write-through backfill.
--
-- Idempotent; safe to re-run per instance. Run once per DB, e.g.:
--   npx dotenv-cli -e local/staging -- bash -c 'psql "$DATABASE_URL" -f drizzle/manual/0008_compiled_model_def.sql'

ALTER TABLE malloy_models
  ADD COLUMN IF NOT EXISTS compiled_model_def bytea;
