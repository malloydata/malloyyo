-- 0007_compiled_model_def — folded into the journal 2026-08-07 from
-- drizzle/manual/0008_compiled_model_def.sql (originally applied by hand with
-- psql, July 2026). Two manual files were numbered 0008; this one landed first
-- (2026-07-03), so it takes the 0007 slot the manual sequence skipped.
--
-- Durable compiled-ModelDef cache.
-- Adds a nullable bytea column holding gzip(JSON(Model._modelDef)) so a cold
-- serverless instance can rehydrate a fully-compiled model via
-- Runtime._loadModelFromModelDef instead of paying the per-source schema-fetch
-- compile. Keyed implicitly by the immutable malloy_models.id (a repo edit is a
-- new row), so it never needs invalidation. Nullable => write-through backfill.
--
-- Idempotent.

ALTER TABLE malloy_models
  ADD COLUMN IF NOT EXISTS compiled_model_def bytea;
