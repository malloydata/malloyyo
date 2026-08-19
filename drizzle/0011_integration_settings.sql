-- 0011_integration_settings — folded into the journal 2026-08-07 from
-- drizzle/manual/ (originally applied by hand with psql, August 2026).
-- Key/value settings owned by an installed auth integration (see
-- src/lib/hosted-auth.ts), keyed by INSTANCE_CODE like instance_settings.
-- Absence of a row means unset. Idempotent.

CREATE TABLE IF NOT EXISTS integration_settings (
  instance_code text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_code, key)
);
