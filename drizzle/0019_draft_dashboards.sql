CREATE TABLE "draft_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"user_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"manifest" jsonb NOT NULL,
	"malloy" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"promoted_as" text,
	"promoted_hash" text,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_dashboards_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "draft_dashboards" ADD CONSTRAINT "draft_dashboards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_dashboards" ADD CONSTRAINT "draft_dashboards_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_dashboards" ADD CONSTRAINT "draft_dashboards_model_id_malloy_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."malloy_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_dashboards_user_idx" ON "draft_dashboards" USING btree ("user_id","updated_at");