-- `is_public` is retired. A role's level on a dataset is the only thing that
-- opens it.
--
-- The flag gave everyone signed in full access to a dataset whatever any role
-- said, so Admin → Roles could show MALLOYYO_USER at None on a dataset every
-- member could still open and query — a switch that did nothing, and a page
-- that disagreed with the one beside it listing what each person gets.
-- 0027 copied the flag onto the role once; anything made public since then
-- (the dataset config page's toggle wrote only the flag) was missed.
--
-- So carry it across one last time, as the new code stops reading the flag
-- altogether. Every dataset that is public now is open in full to MALLOYYO_USER
-- afterwards, which is what "public" meant: nobody loses a dataset in this
-- deploy. (Someone who holds no MALLOYYO_USER is the exception, and the point:
-- what they open is now what their roles say.)
--
-- Safe before the new code is promoted. The live version reads the flag, which
-- is untouched, and the role it gains only grants what the flag already did.
-- The column itself is NOT dropped here, for that same live version: it still
-- selects it. Dropping it is for the release after this one.
--
-- Idempotent: a dataset that already carries the role at full is left alone.
UPDATE "datasets"
   SET "roles" = array_append("roles", 'MALLOYYO_USER')
 WHERE "is_public" = true
   AND NOT ('MALLOYYO_USER' = ANY("roles"));
--> statement-breakpoint
-- Public was full access. A members role held at dashboards-only on a public
-- dataset was being overridden by the flag, so full is what people had.
UPDATE "datasets"
   SET "view_only_roles" = array_remove("view_only_roles", 'MALLOYYO_USER')
 WHERE "is_public" = true
   AND 'MALLOYYO_USER' = ANY("view_only_roles");
