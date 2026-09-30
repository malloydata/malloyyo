CREATE TABLE "givens" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The givens that resolve from the session. Everything else a dataset could be
-- scoped by will resolve from a value on the user or on one of their roles,
-- which is designed but not built — see docs/given-variables.md.
INSERT INTO "givens" ("name", "description", "builtin") VALUES
  ('MALLOYYO_EMAIL', 'The signed-in address. Scope rows to the person asking.', true),
  ('MALLOYYO_ROLES', 'Every role the person holds, as a list. Scope rows to what they belong to.', true)
ON CONFLICT ("name") DO NOTHING;
