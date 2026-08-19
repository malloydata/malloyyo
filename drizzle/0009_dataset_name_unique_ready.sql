-- One live (ready) dataset per name on the server, so names can be used as URLs.
-- Partial index: only READY datasets are constrained — failed/stale dupes (which
-- are already hidden by visibleDatasetWhere) are ignored. Applies cleanly since
-- every name currently has exactly one ready dataset.
-- Folded into the journal 2026-08-07 from drizzle/manual/ (originally applied
-- by hand with psql, July 2026).
CREATE UNIQUE INDEX IF NOT EXISTS datasets_name_ready_unique
  ON datasets (name) WHERE status = 'ready';
