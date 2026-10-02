-- The three columns that made a repo a query predicate.
--
-- A SEPARATE ENTRY from 0026 on purpose. A Vercel build applies the journal
-- BEFORE the new code is promoted, so an entry that removes something the
-- currently live version still selects takes that version down for the length of
-- the deploy. 0026 is additive and can ship with the old code running; this one
-- must ship in the release AFTER the one that stopped reading these columns.
-- 0014 is the archaeology of getting that wrong.
--
-- Nothing is lost: 0026 copied every fact these held onto `repos`
-- (github_repo, github_branch, github_use_token) and `datasets.repo_id`.

ALTER TABLE "datasets" DROP COLUMN "github_repo";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN "github_branch";--> statement-breakpoint
ALTER TABLE "datasets" DROP COLUMN "github_use_token";