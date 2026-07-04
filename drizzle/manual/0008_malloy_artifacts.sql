-- Dashboard artifacts shipped in a model's repo under ./dashboards/<name>/.
-- Idempotent; run once per instance:
--   npx dotenv-cli -e local/<env> -- bash -c 'psql "$DATABASE_URL" -f drizzle/manual/0008_malloy_artifacts.sql'
CREATE TABLE IF NOT EXISTS malloy_artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id   uuid NOT NULL REFERENCES malloy_models(id) ON DELETE CASCADE,
  name       text NOT NULL,
  title      text,
  manifest   jsonb NOT NULL,
  source     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS malloy_artifacts_model_id_idx ON malloy_artifacts (model_id);
