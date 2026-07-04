-- One live (ready) dataset per name on the server, so names can be used as URLs.
-- Partial index: only READY datasets are constrained — failed/stale dupes (which
-- are already hidden by visibleDatasetWhere) are ignored. Applies cleanly since
-- every name currently has exactly one ready dataset.
--   npx dotenv-cli -e local/<env> -- bash -c 'psql "$DATABASE_URL" -f drizzle/manual/0009_dataset_name_unique_ready.sql'
CREATE UNIQUE INDEX IF NOT EXISTS datasets_name_ready_unique
  ON datasets (name) WHERE status = 'ready';
