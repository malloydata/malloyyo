-- Backport favorited queries from the pre-redesign backups (created by
-- 0003_history_redesign.sql) into the durable saved_queries + favorites tables,
-- so users' favorites survive the greenfield. History itself is disposable and
-- is intentionally NOT backported.
--
-- Idempotent, and a clean no-op on a fresh install (where *_bak don't exist).
-- Run AFTER 0003, per instance:
--   psql "$DATABASE_URL" -f drizzle/manual/0004_backport_favorites.sql

SET search_path TO public;

DO $$
BEGIN
  IF to_regclass('public.favorites_bak') IS NULL
     OR to_regclass('public.inquiries_bak') IS NULL
     OR to_regclass('public.tool_calls_bak') IS NULL THEN
    RAISE NOTICE 'backport: *_bak tables absent — nothing to backport';
    RETURN;
  END IF;

  -- 1. One durable saved_query per favorited inquiry that has a resolvable
  --    successful run (carries dataset_id + Malloy). author_model = 'assistant'
  --    (these were LLM-authored over MCP; the old schema didn't record it).
  INSERT INTO saved_queries (slug, dataset_id, user_id, source, question, malloy_source, compiled_sql, author_model, created_at)
  SELECT DISTINCT ON (i.slug)
    i.slug, tc.dataset_id, tc.user_id, tc.source, i.question, tc.malloy_input, tc.compiled_sql, 'assistant', i.created_at
  FROM (SELECT DISTINCT inquiry_id FROM favorites_bak) fav
  JOIN inquiries_bak i ON i.id = fav.inquiry_id
  JOIN LATERAL (
    SELECT dataset_id, user_id, source, malloy_input, compiled_sql
    FROM tool_calls_bak t
    WHERE t.inquiry_id = fav.inquiry_id
      AND t.tool_name IN ('query','run_query') AND t.error IS NULL
      AND t.dataset_id IS NOT NULL AND t.malloy_input IS NOT NULL
    ORDER BY t.created_at DESC
    LIMIT 1
  ) tc ON true
  WHERE i.slug IS NOT NULL
  ORDER BY i.slug
  ON CONFLICT (slug) DO NOTHING;

  -- 2. Re-create the favorites, re-pointed at the new saved_queries (by slug).
  INSERT INTO favorites (user_id, saved_query_id, created_at)
  SELECT f.user_id, sq.id, f.created_at
  FROM favorites_bak f
  JOIN inquiries_bak i ON i.id = f.inquiry_id
  JOIN saved_queries sq ON sq.slug = i.slug
  ON CONFLICT (user_id, saved_query_id) DO NOTHING;
END $$;
