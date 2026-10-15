ALTER TABLE "repo_revisions" ADD COLUMN "preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_revisions" ADD COLUMN "preview_datasets" jsonb;--> statement-breakpoint
CREATE INDEX "repo_revisions_preview_branch_idx" ON "repo_revisions" USING btree ("repo_id","git_branch","created_at") WHERE preview;--> statement-breakpoint
