-- Deployments whose sign-in comes from an external identity provider key the local user
-- row on that provider's stable subject identifier rather than on email — a sign-in may
-- reveal no address at all, and a subject survives an address change. Nullable and
-- additive: every existing user keeps a NULL here and nothing about their sign-in changes.
-- Folded into the journal 2026-08-07 from drizzle/manual/ (originally applied
-- by hand with psql, August 2026).
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_account_id text;

-- Unique so two rows can never claim the same subject. NULLs do not conflict in Postgres,
-- so existing users are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS users_external_account_id_unique
  ON users (external_account_id);
