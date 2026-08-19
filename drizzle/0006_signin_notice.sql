-- 0006_signin_notice — folded into the journal 2026-08-07 from
-- drizzle/manual/ (originally applied by hand with psql, July 2026).
-- Add the editable sign-in notice to instance_settings. Idempotent; needed for
-- DBs that already ran 0005 before the column existed. Fresh installs get the
-- column from 0005's CREATE and this is a no-op.

ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS signin_notice text;
