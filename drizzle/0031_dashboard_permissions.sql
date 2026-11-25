CREATE TABLE "dashboard_grants" (
	"dataset_id" uuid NOT NULL,
	"dashboard" text NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_grants_dataset_id_dashboard_user_id_pk" PRIMARY KEY("dataset_id","dashboard","user_id")
);
--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "view_only_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "dashboard_audience" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_dashboards" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
-- Every draft that exists today was listed to everyone who could open its
-- dataset, and people hold links to them. The column default is for drafts
-- saved from now on; these keep the audience they have always had.
UPDATE "draft_dashboards" SET "visibility" = 'dataset';--> statement-breakpoint
ALTER TABLE "dashboard_grants" ADD CONSTRAINT "dashboard_grants_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_grants" ADD CONSTRAINT "dashboard_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_grants" ADD CONSTRAINT "dashboard_grants_granted_by_id_users_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_grants_user_idx" ON "dashboard_grants" USING btree ("user_id");