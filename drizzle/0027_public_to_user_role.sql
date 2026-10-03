-- Carry `is_public` across to the role that replaces it.
--
-- `datasets.is_public` is going away: there is no anonymous read path on this
-- server — even a shared query link requires sign-in — so "public" only ever
-- meant "any signed-in member", which is exactly what granting `MALLOYYO_USER`
-- means, since every active member holds it. Two mechanisms for one fact is two
-- places to look and two answers to keep in step.
--
-- This runs a release BEFORE the column stops being read, and two before it is
-- dropped. That order is the whole point: while both exist, a public dataset is
-- visible by either route, so no deploy window can make one disappear. Doing it
-- the other way round is not a near miss — on the instance this was written
-- against, SIX of the eight live datasets were public with no roles at all, so
-- removing the column first would have taken every one of them away from every
-- non-admin at once.
--
-- Idempotent: the guard means a re-run appends nothing, and a dataset that
-- already carries the role is left alone.
UPDATE "datasets"
   SET "roles" = array_append("roles", 'MALLOYYO_USER')
 WHERE "is_public" = true
   AND NOT ('MALLOYYO_USER' = ANY("roles"));
