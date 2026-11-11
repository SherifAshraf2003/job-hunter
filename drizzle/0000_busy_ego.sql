CREATE TYPE "public"."ats" AS ENUM('greenhouse', 'lever', 'ashby', 'workable');--> statement-breakpoint
CREATE TYPE "public"."feasibility" AS ENUM('in_egypt', 'remote_from_egypt', 'sponsors', 'unclear', 'not_possible');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('found', 'filtered_out', 'scored', 'score_failed');--> statement-breakpoint
CREATE TYPE "public"."company_origin" AS ENUM('seed_yc', 'seed_egypt', 'harvested');--> statement-breakpoint
CREATE TYPE "public"."salary_period" AS ENUM('year', 'month', 'hour');--> statement-breakpoint
CREATE TYPE "public"."remote_policy" AS ENUM('remote', 'hybrid', 'onsite', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'done', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."spend_category" AS ENUM('scoring', 'tailoring');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ats" "ats" NOT NULL,
	"slug" text NOT NULL,
	"origin" "company_origin" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_scores" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"engine" text NOT NULL,
	"scope" real NOT NULL,
	"company" real NOT NULL,
	"pay" real NOT NULL,
	"level" real NOT NULL,
	"fit" real NOT NULL,
	"can_take" "feasibility" NOT NULL,
	"can_take_confidence" real NOT NULL,
	"raw" jsonb,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"board_slug" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"company_name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"country" text,
	"remote_policy" "remote_policy" DEFAULT 'unknown' NOT NULL,
	"salary_min" numeric,
	"salary_max" numeric,
	"salary_currency" text,
	"salary_period" "salary_period",
	"salary_usd_year_mid" numeric,
	"description_text" text DEFAULT '' NOT NULL,
	"apply_url" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"status" "job_status" DEFAULT 'found' NOT NULL,
	"status_reason" text,
	CONSTRAINT "jobs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status" "run_status",
	"requested" boolean DEFAULT false NOT NULL,
	"stats" jsonb
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" "spend_category" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"usd" numeric NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_ats_slug" ON "companies" USING btree ("ats","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "job_sources_source_ext" ON "job_sources" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "job_sources_job" ON "job_sources" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status");