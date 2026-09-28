CREATE TABLE "roles" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "default_roles" text[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- The three built-in roles. Capability on this instance, not reach into data:
-- a dataset is opened by the roles it lists, and it may list these like any
-- other. Seeded here so the admin UI has something to show on a fresh install.
INSERT INTO "roles" ("name", "description", "builtin") VALUES
  ('MALLOYYO_USER', 'Sign in, query the datasets your roles allow, save and share queries, build draft dashboards.', true),
  ('MALLOYYO_DEVELOPER', 'Everything a user may do, plus create datasets and publish models.', true),
  ('MALLOYYO_ADMIN', 'Everything a developer may do, plus manage people, roles and instance settings.', true)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- Carry existing authority forward. Admins keep administering; everyone else
-- becomes an ordinary user. Nobody gains reach into data here: dataset access
-- is granted separately, and datasets.roles starts empty for every row.
UPDATE "users" SET "roles" =
  CASE WHEN "role" IN ('owner', 'admin') OR "is_admin" THEN ARRAY['MALLOYYO_USER','MALLOYYO_ADMIN']
       ELSE ARRAY['MALLOYYO_USER'] END
WHERE cardinality("roles") = 0;
