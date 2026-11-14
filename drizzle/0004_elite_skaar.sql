CREATE TYPE "public"."answer_source" AS ENUM('seed', 'drafted', 'edited');--> statement-breakpoint
CREATE TYPE "public"."app_status" AS ENUM('queued', 'filling', 'ready_to_submit', 'needs_you', 'submitting', 'applied', 'skipped', 'failed', 'manual', 'interviewing', 'rejected', 'offer');--> statement-breakpoint
CREATE TYPE "public"."site" AS ENUM('greenhouse', 'lever', 'ashby', 'workable', 'linkedin', 'other');--> statement-breakpoint
CREATE TYPE "public"."site_event" AS ENUM('captcha', 'blocked', 'login_wall', 'warning');--> statement-breakpoint
CREATE TABLE "answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source" "answer_source" NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"status" "app_status" DEFAULT 'queued' NOT NULL,
	"site" "site" NOT NULL,
	"board_key" text NOT NULL,
	"target_url" text NOT NULL,
	"reason" text,
	"fills" jsonb,
	"approved" boolean DEFAULT false NOT NULL,
	"lease_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"site" "site" NOT NULL,
	"kind" "site_event" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" integer
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"site" "site" PRIMARY KEY NOT NULL,
	"auto_submit" boolean DEFAULT true NOT NULL,
	"daily_cap" integer,
	"paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_status" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "site_events_site_at" ON "site_events" USING btree ("site","at");