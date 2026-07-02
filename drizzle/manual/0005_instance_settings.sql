-- 0005_instance_settings.sql
-- Per-instance editable presentation settings (front-page tagline). Keyed by
-- INSTANCE_CODE. Idempotent; safe to run once per instance DB.

CREATE TABLE IF NOT EXISTS instance_settings (
  instance_code text PRIMARY KEY,
  tagline text,
  signin_notice text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
