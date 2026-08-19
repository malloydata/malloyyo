-- 0005_instance_settings — folded into the journal 2026-08-07 from
-- drizzle/manual/ (originally applied by hand with psql, July 2026).
-- Per-instance editable presentation settings (front-page tagline). Keyed by
-- INSTANCE_CODE. Idempotent.

CREATE TABLE IF NOT EXISTS instance_settings (
  instance_code text PRIMARY KEY,
  tagline text,
  signin_notice text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
