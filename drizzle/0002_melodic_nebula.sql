CREATE TYPE "public"."tailor_tier" AS ENUM('top', 'middle', 'bottom');--> statement-breakpoint
CREATE TABLE "tailorings" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"tier" "tailor_tier" NOT NULL,
	"model" text NOT NULL,
	"resume" jsonb,
	"issues" jsonb,
	"diff" jsonb,
	"cover_letter" text,
	"gap_report" jsonb,
	"prep" jsonb,
	"pdf_path" text,
	"error" text,
	"usd" numeric DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tailorings" ADD CONSTRAINT "tailorings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tailorings_created" ON "tailorings" USING btree ("created_at");