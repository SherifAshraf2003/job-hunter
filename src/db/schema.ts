import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, real, jsonb, pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const atsEnum = pgEnum("ats", ["greenhouse", "lever", "ashby", "workable"]);
export const originEnum = pgEnum("company_origin", ["seed_yc", "seed_egypt", "harvested"]);
export const remoteEnum = pgEnum("remote_policy", ["remote", "hybrid", "onsite", "unknown"]);
export const periodEnum = pgEnum("salary_period", ["year", "month", "hour"]);
export const jobStatusEnum = pgEnum("job_status", ["found", "filtered_out", "scored", "score_failed"]);
export const feasibilityEnum = pgEnum("feasibility", ["in_egypt", "remote_from_egypt", "sponsors", "unclear", "not_possible"]);
export const spendCategoryEnum = pgEnum("spend_category", ["scoring", "tailoring"]);
export const runStatusEnum = pgEnum("run_status", ["running", "done", "failed", "abandoned"]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ats: atsEnum("ats").notNull(),
  slug: text("slug").notNull(),
  origin: originEnum("origin").notNull(),
  active: boolean("active").notNull().default(true),
  failCount: integer("fail_count").notNull().default(0),
  lastPolledAt: ts("last_polled_at"),
}, (t) => [uniqueIndex("companies_ats_slug").on(t.ats, t.slug)]);

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  companyName: text("company_name").notNull(),
  location: text("location").notNull().default(""),
  country: text("country"),
  remotePolicy: remoteEnum("remote_policy").notNull().default("unknown"),
  salaryMin: numeric("salary_min", { mode: "number" }),
  salaryMax: numeric("salary_max", { mode: "number" }),
  salaryCurrency: text("salary_currency"),
  salaryPeriod: periodEnum("salary_period"),
  salaryUsdYearMid: numeric("salary_usd_year_mid", { mode: "number" }),
  descriptionText: text("description_text").notNull().default(""),
  applyUrl: text("apply_url").notNull(),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  status: jobStatusEnum("status").notNull().default("found"),
  statusReason: text("status_reason"),
}, (t) => [index("jobs_status").on(t.status)]);

export const jobSources = pgTable("job_sources", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  url: text("url").notNull(),
  boardSlug: text("board_slug"),
}, (t) => [uniqueIndex("job_sources_source_ext").on(t.source, t.externalId), index("job_sources_job").on(t.jobId)]);

export const jobScores = pgTable("job_scores", {
  jobId: integer("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  engine: text("engine").notNull(),
  scope: real("scope").notNull(),
  company: real("company").notNull(),
  pay: real("pay").notNull(),
  level: real("level").notNull(),
  fit: real("fit").notNull(),
  canTake: feasibilityEnum("can_take").notNull(),
  canTakeConfidence: real("can_take_confidence").notNull(),
  raw: jsonb("raw"),
  scoredAt: ts("scored_at").notNull().defaultNow(),
});

export const spend = pgTable("spend", {
  id: serial("id").primaryKey(),
  at: ts("at").notNull().defaultNow(),
  category: spendCategoryEnum("category").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  usd: numeric("usd", { mode: "number" }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const profile = pgTable("profile", {
  id: integer("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  status: runStatusEnum("status"),
  requested: boolean("requested").notNull().default(false),
  stats: jsonb("stats"),
});
