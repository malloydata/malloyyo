-- 0002_model_publish — folded into the journal 2026-08-07 from drizzle/manual/
-- (originally applied by hand with psql, June 2026). Idempotent.
--
-- Adds the columns the malloyyo CLI publish path needs:
--   * malloy_models.git_*        — git provenance of a pushed model version
--   * datasets.last_publish_*    — last publish attempt (success or failure)
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_repo   text;--> statement-breakpoint
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_branch text;--> statement-breakpoint
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_sha    text;--> statement-breakpoint
ALTER TABLE malloy_models ADD COLUMN IF NOT EXISTS git_dirty  boolean;--> statement-breakpoint
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_at     timestamptz;--> statement-breakpoint
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_sha    text;--> statement-breakpoint
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_branch text;--> statement-breakpoint
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_publish_error  text;
