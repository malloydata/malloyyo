-- A person is a row from the moment they are ADDED, not from the moment they
-- sign in.
--
-- Adding someone ahead of their first sign-in used to write an `invitations`
-- row: an address, and "member" or "admin". The person did not exist until they
-- arrived, so they could not be given a dataset role, shared a dashboard, or
-- impersonated to see what they would see — and what they were to start with
-- had nowhere to live except a second record of who they were. Admin → Users →
-- Add user now creates the user, with the roles ticked for them, and their
-- first sign-in claims that row (src/lib/claim.ts).
--
-- `first_signed_in_at` is what tells an added row from an arrived one: NULL
-- until they sign in. It DEFAULTS TO now() so that every path creating a row
-- because someone signed in — including the version of this code that is live
-- while this migration runs — fills it without knowing the column exists. Only
-- Add user writes NULL.
ALTER TABLE "users" ADD COLUMN "first_signed_in_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "added_by_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Everyone already here is here because they signed in: until now that was the
-- only way a row came to exist. The column default just stamped them all with
-- the time of this migration; the truth is closer to when the row was made.
UPDATE "users" SET "first_signed_in_at" = "created_at";--> statement-breakpoint
-- An earlier revision of this branch put the starting roles on the invitation
-- (`invitations.roles`). It was never merged, but a database that ran that
-- revision has the column and may have roles in it. Added here if absent so
-- the statement below reads the same on every database, and dropped again at
-- the end: nothing that has shipped reads it.
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "roles" text[];--> statement-breakpoint
-- Every OPEN invitation becomes the person it was for.
--
-- Their roles: what was ticked for them where that was recorded; otherwise what
-- this instance gives new users (when one instance owns this database and has
-- said), otherwise the built-in MALLOYYO_USER — and MALLOYYO_ADMIN on top when
-- the invitation carried admin, which is the one thing every invitation could
-- always say. An invitation never minted an owner, and does not here.
INSERT INTO "users" ("email", "status", "role", "is_admin", "roles", "added_by_id", "created_at", "first_signed_in_at")
SELECT lower(i."email"),
       'active'::"user_status",
       CASE WHEN i."role" = 'member' THEN 'member'::"user_role" ELSE 'admin'::"user_role" END,
       i."role" <> 'member',
       CASE
         WHEN i."role" <> 'member' AND NOT ('MALLOYYO_ADMIN' = ANY (r."roles"))
           THEN array_append(r."roles", 'MALLOYYO_ADMIN')
         ELSE r."roles"
       END,
       i."invited_by_id",
       i."created_at",
       NULL
  FROM "invitations" i
 CROSS JOIN LATERAL (
       SELECT COALESCE(
                i."roles",
                NULLIF(
                  (SELECT array_remove(s."default_roles", 'MALLOYYO_ADMIN')
                     FROM "instance_settings" s
                    WHERE (SELECT count(*) FROM "instance_settings") = 1),
                  '{}'::text[]
                ),
                ARRAY['MALLOYYO_USER']::text[]
              ) AS "roles"
     ) r
 WHERE i."accepted_at" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "users" u WHERE lower(u."email") = lower(i."email"));--> statement-breakpoint
-- …and the invitation is spent, so nothing consumes it a second time. (This
-- also closes one whose address had a user row already: there was nothing left
-- for it to do.)
UPDATE "invitations" i
   SET "accepted_at" = now(), "accepted_by_id" = u."id"
  FROM "users" u
 WHERE i."accepted_at" IS NULL
   AND lower(u."email") = lower(i."email");--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "roles";--> statement-breakpoint
-- People an INTEGRATION created, who hold nothing, get the members role.
--
-- 0032 turned "public" into "MALLOYYO_USER has full", on the understanding that
-- every member holds MALLOYYO_USER. Where an integration owns sign-in that was
-- not true: it created people with no roles at all, and they saw public
-- datasets only because the flag opened to everyone signed in. Without this
-- they would lose every one of those datasets when the flag stops being read.
--
-- Only those rows (`external_account_id`), only ones holding nothing, and only
-- people who can sign in. Anywhere else, someone holding no role is someone an
-- admin unticked every box for, and what they open is what was chosen for
-- them: nothing. What this can add beyond what "public" gave: a dataset granted
-- to MALLOYYO_USER that was never public. Granting to that role means "every
-- member", and these are members nobody was ever asked about.
UPDATE "users"
   SET "roles" = ARRAY['MALLOYYO_USER']::text[]
 WHERE "roles" = '{}'::text[]
   AND "status" = 'active'
   AND "external_account_id" IS NOT NULL;
