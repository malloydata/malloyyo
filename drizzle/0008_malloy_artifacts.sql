-- 0008_malloy_artifacts — folded into the journal 2026-08-07 from
-- drizzle/manual/0008_malloy_artifacts.sql (originally applied by hand with
-- psql, July 2026; it shared the number 0008 with compiled_model_def, which
-- landed a day earlier and is journaled as 0007). Idempotent.
--
-- Dashboard artifacts shipped in a model's repo under ./dashboards/<name>/.
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
