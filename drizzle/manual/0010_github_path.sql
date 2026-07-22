-- Add datasets.github_path: subdirectory within the GitHub repo holding the
-- model (index.malloy, dashboards/, malloy-config.json). Empty string = repo
-- root (existing behavior). Stored normalized: no leading/trailing slashes.
-- Idempotent; run once per instance:
--   npx dotenv-cli -e local/<instance> -- bash -c 'psql "$DATABASE_URL" -f drizzle/manual/0010_github_path.sql'

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS github_path text NOT NULL DEFAULT '';
