-- People an INTEGRATION created, who hold no role, get the members role.
--
-- 0033 turned "public" into "MALLOYYO_USER has full", on the understanding that
-- every member holds MALLOYYO_USER. Where an integration owns sign-in that was
-- not true: it created people with no roles at all, and they saw public
-- datasets only because the flag opened to everyone signed in. Without this
-- they would lose every one of those datasets when the flag stops being read.
-- (New people made that way are given the instance's new-user roles from now
-- on: src/lib/external-user.ts.)
--
-- Only those rows (`external_account_id`), only ones holding nothing, and only
-- people who can sign in. Anywhere else, someone holding no role is someone an
-- admin unticked every box for, and what they open is what was chosen for
-- them: nothing. What this can add beyond what "public" gave: a dataset granted
-- to MALLOYYO_USER that was never public. Granting to that role means "every
-- member", and these are members nobody was ever asked about.
--
-- Safe before the new code is promoted: the live version reads the same column
-- the same way, and the role opens nothing the public flag is not already
-- opening for it.
UPDATE "users"
   SET "roles" = ARRAY['MALLOYYO_USER']::text[]
 WHERE "roles" = '{}'::text[]
   AND "status" = 'active'
   AND "external_account_id" IS NOT NULL;
