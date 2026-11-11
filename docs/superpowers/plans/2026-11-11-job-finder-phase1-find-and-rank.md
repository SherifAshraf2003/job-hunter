# Job Finder Phase 1 (Find and Rank) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local app that finds software jobs from public APIs and feeds, scores them with Jev, and shows them ranked in a Graphite-themed dashboard. All paid calls stay under a hard monthly budget.

**Architecture:** One TypeScript repo. A Next.js App Router app serves the dashboard and a tiny API. A separate Node worker process (`tsx src/worker/index.ts`) runs the search cycle on a schedule: discover companies → fetch sources → normalize → dedupe/upsert → pre-filter → score. Postgres (Drizzle ORM) holds everything. The composite score is computed at read time, so changing weights re-ranks instantly.

**Tech Stack:** Node 25, TypeScript, Next.js 15 (App Router), Drizzle ORM + `postgres` driver, drizzle-kit, Vitest (budget tests only), `@typesafe-ai/sdk` (Jev), OpenRouter HTTP API, `p-limit`, `fast-xml-parser` (RSS), `geist` font package. Postgres 17 via Homebrew.

**Spec:** `docs/superpowers/specs/2026-11-11-job-finder-design.md` (Phase 1 = section 10, item 1). Read sections 3, 6.1, 6.2, 7, 8 before starting.

## Global Constraints

- Runs locally on macOS. No cloud services except the APIs listed here.
- Secrets live only in `.env` (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `DATABASE_URL`, `DATABASE_URL_TEST`). `.env` is git-ignored; `.env.example` lists every key.
- Monthly LLM budget default **$10**. Scoring may use at most **50%** of it ($5). Daily scoring cap = scoring share / 30. **Never start a paid call that would exceed either cap.**
- Default ranking weights: scope 0.26, company 0.20, pay 0.16, level 0.10, fit 0.28. Default score cutoff 60. Default search interval 4 hours.
- Feasibility categories exactly: `in_egypt`, `remote_from_egypt`, `sponsors`, `unclear`, `not_possible`. `unclear` = −5 composite points; `not_possible` always sorts after every other job.
- Pay is judged against the job's own local market (spec 6.2). USD conversion is only for display.
- Location is never a search filter. Egyptian jobs are in scope.
- Dashboard: Graphite tokens and Geist font exactly as in spec section 8. Copy is in sentence case, plain verbs, and no all-caps labels.
- Sources must be polite: max 4 concurrent HTTP requests per host, User-Agent `job-finder/0.1 (personal job search)`.
- **Testing policy (Sherif's call):** no automated tests except the **budget/spend-cap tests** (Task 5, plus one in Task 7). Every other task is verified by running it and checking the listed results.
- **Scoring engine: Jev for every pre-filtered job.** Price: $0.042 per million input tokens (from Sherif). Output-token price unknown; set `JEV_USD_PER_MTOK_OUTPUT=0` and treat output as negligible (about 20 tokens per call). At about 3.5k input tokens per job, that's about $0.00015 per job, so the $5 scoring share covers about 30,000 jobs a month. No OpenRouter scorer and no funnel.
- Never send the user's email address to any third-party service other than OpenRouter/TypeSafe prompts that contain the resume.

## Review Focus

1. **A company board 404s or a source API is down.** The cycle keeps going with the other sources. The board gets `failCount++`, and after 3 consecutive failures it is set `active=false`. Check: Task 8 step 2.
2. **The budget runs out mid-cycle.** Scoring stops cleanly. Remaining jobs stay `found` (not `score_failed`) and are scored in the next cycle with budget. Spend never exceeds the cap. Test: Task 7 `stops scoring when budget would be exceeded` (kept, since it's budget).
3. **The LLM returns malformed or partial JSON.** Retry once. If it fails again, the job becomes `score_failed` with the error, and nothing crashes. Check: Task 6 step 2 (HN extraction) and Task 7 step 2.
4. **The worker is killed or the laptop sleeps mid-cycle.** A rerun creates no duplicate jobs or sources (unique constraints plus upserts), and a run left `running` for more than 1 hour is marked `abandoned` at the next start. Check: Task 8 step 2.
5. **A job disappears from its board.** It is marked `closedAt` and hidden by default, never deleted. Check: Task 6 step 2.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, drizzle.config.ts, vitest.config.ts, .env.example, .gitignore
data/egypt-companies.json          hand seed: [{ "name": string, "slugs": string[] }]
src/config.ts                      env + defaults + settings loader
src/db/schema.ts                   Drizzle tables
src/db/client.ts                   db instance; getTestDb()/resetDb() for tests
src/profile/types.ts               BaseProfile type
src/profile/parseLatex.ts          resume.tex → BaseProfile
src/profile/load.ts                load/save profile row
src/sources/types.ts               NormalizedJob, BoardRef, SourceResult
src/sources/text.ts                htmlToText, parseSalary, toUsdYearMid, inferRemote
src/sources/{greenhouse,lever,ashby,workable}.ts   per-board fetchers
src/sources/{remoteok,wwr,hn}.ts   feed fetchers
src/discovery/boardRefs.ts         extractBoardRef(url)
src/discovery/probe.ts             probeSlugs(name) → BoardRef[]
src/discovery/seed.ts              seedCompanies()
src/pipeline/upsert.ts             jobKey, upsertJobs, markClosed
src/pipeline/prefilter.ts          prefilter(job)
src/pipeline/cycle.ts              runSearchCycle()
src/llm/openrouter.ts              chatJSON()
src/budget/budget.ts               canSpend, recordSpend, spendSummary
src/scoring/types.ts               DimensionScores, Scorer
src/scoring/state.ts               buildScoringState(job, profile)
src/scoring/jev.ts                 jevScorer
src/scoring/composite.ts           composite(scores, weights)
src/scoring/scoreJobs.ts           scorePending()
src/worker/index.ts                scheduler loop
src/queries/jobs.ts                listJobs(filters), getJob(id), stageCounts()
src/app/layout.tsx, globals.css, page.tsx, settings/page.tsx, api/run/route.ts
src/app/components/{Header,StageStrip,Filters,JobRow,ScoreBar,JobDetail}.tsx
tests/budget/                      the only automated tests
scripts/                           small run-and-print check scripts
```

---

### Task 1: Scaffold, Postgres, schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `drizzle.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`, `src/config.ts`, `src/db/schema.ts`, `src/db/client.ts`

**Interfaces:**
- Produces: `db` (Drizzle), `getTestDb()`, `resetDb()` (truncate all tables), tables below, `config` object:
  `config.budgetUsdMonthly=10, config.scoringShare=0.5, config.weights={scope:.26,company:.20,pay:.16,level:.10,fit:.28}, config.cutoff=60, config.searchIntervalHours=4, config.fxToUsd: Record<string,number>` (USD 1, EUR 1.08, GBP 1.27, CAD 0.73, AED 0.272, SAR 0.267, EGP 0.0205, INR 0.012). `loadSettings(): Promise<typeof config>` merges the `settings` table over defaults.
- Tables (all with `id` serial unless noted, timestamps `timestamptz`):
  - `companies`: name, ats (`greenhouse|lever|ashby|workable`), slug, origin (`seed_yc|seed_egypt|harvested`), active bool default true, failCount int default 0, lastPolledAt. Unique (ats, slug).
  - `jobs`: key text unique, title, companyName, location, country (nullable ISO-2), remotePolicy (`remote|hybrid|onsite|unknown`), salaryMin, salaryMax (numeric nullable), salaryCurrency, salaryPeriod (`year|month|hour`), salaryUsdYearMid numeric nullable, descriptionText, applyUrl, firstSeenAt, lastSeenAt, closedAt nullable, status (`found|filtered_out|scored|score_failed`), statusReason text nullable.
  - `jobSources`: jobId fk, source text, externalId text, url. Unique (source, externalId).
  - `jobScores`: jobId pk/fk, engine (`jev|openrouter`), scope, company, pay, level, fit (real 0–100), canTake (feasibility enum), canTakeConfidence real, raw jsonb, scoredAt.
  - `spend`: at, category (`scoring|tailoring`), provider, model, usd numeric, inputTokens, outputTokens.
  - `settings`: key text pk, value jsonb.
  - `profile`: id=1 singleton, data jsonb, updatedAt.
  - `runs`: startedAt, finishedAt, status (`running|done|failed|abandoned`), requested bool, stats jsonb.

- [ ] **Step 1:** `brew install postgresql@17 && brew services start postgresql@17`, then `createdb jobfinder && createdb jobfinder_test`. Expected: `psql jobfinder -c 'select 1'` prints 1.
- [ ] **Step 2:** `git init`. Scaffold Next.js (`npx create-next-app@15 . --ts --app --src-dir --no-tailwind --eslint --import-alias "@/*"`; keep existing `resume.tex`, `resume.pdf`, `docs/`). Add deps listed in Tech Stack plus `tsx`, `dotenv`, `vitest`. `.gitignore` adds `.env`, `.superpowers/`.
- [ ] **Step 3:** Implement the schema, client, and config; generate + apply migrations (`npx drizzle-kit generate && npx drizzle-kit migrate`, and the same against `DATABASE_URL_TEST`; add `npm run db:migrate` doing both).
- [ ] **Step 4: Check:** `npm run db:migrate` succeeds, and `psql jobfinder -c '\dt'` lists companies, jobs, job_sources, job_scores, spend, settings, profile, runs.
- [ ] **Step 5:** Commit `feat: scaffold app, postgres schema, config`.

---

### Task 2: Base profile from resume.tex

**Files:** Create `src/profile/types.ts`, `src/profile/parseLatex.ts`, `src/profile/load.ts`, `scripts/print-profile.ts`.

**Interfaces:**
- Produces:
```ts
type BaseProfile = {
  name: string; headline: string; links: string[];
  roles: { title: string; org: string; dates: string; bullets: string[] }[];
  quote?: string;
  projects: { name: string; text: string }[];
  skills: Record<string, string[]>;           // "Languages" → ["TypeScript", ...]
  education: { degree: string; school: string; dates: string; coursework: string[] }[];
  awards: { name: string; text: string }[];
  facts: { citizenship: "Egypt"; location: "Egypt"; yearsExperience: number };
};
parseResumeTex(tex: string): BaseProfile
loadProfile(): Promise<BaseProfile>   // reads profile row; if empty, parses resume.tex and saves
```
- `yearsExperience` = 2 (constant in parser output; spec section 3).

- [ ] **Step 1:** Implement the parser. Split on `\section{...}`, read `\role{a}{b}{c}`, `\item`, `\textbf{X:}`. Unescape `\%`→`%` and `--`→`–`, turn ``` ``…'' ``` into curly quotes, and strip `\href{u}{t}`→t and `\par`/`\vspace{..}`. `loadProfile` parses and saves on first call.
- [ ] **Step 2: Check:** `npx tsx scripts/print-profile.ts` prints the profile JSON parsed from the real `resume.tex`, and these hold:

```ts
const p = parseResumeTex(readFileSync("resume.tex", "utf8"));
expect(p.name).toBe("Sherif Ashraf Mohamed");
expect(p.headline).toBe("Full-Stack AI Engineer");
expect(p.roles.map(r => r.org)).toEqual(["Dialbird", "PlawLabs (Vulnzap, Brief)", "Upwork", "Orange Egypt"]);
expect(p.roles[0].bullets).toHaveLength(7);
expect(p.roles[0].bullets[5]).toBe("Reduced AWS costs by approximately 30% by optimizing ECS services and EC2 instances across staging and production.");
expect(p.roles[0].dates).toBe("Feb 2026 – Oct 2026");
expect(p.projects[0].name).toBe("LeadMate (Co-Founder)");
expect(p.skills["AI"]).toEqual(["LLMs", "RAG", "Voice Agents", "Pinecone", "MCP"]);
expect(p.education[0].coursework).toContain("Information Retrieval");
expect(p.awards).toHaveLength(3);
```
- [ ] **Step 3:** Commit `feat: parse base profile from resume.tex`.

---

### Task 3: Shared source types and text utilities

**Files:** Create `src/sources/types.ts`, `src/sources/text.ts`, `scripts/check-text.ts`.

**Interfaces:**
```ts
type BoardRef = { ats: "greenhouse" | "lever" | "ashby" | "workable"; slug: string };
type NormalizedJob = {
  source: string; externalId: string; url: string; applyUrl: string;
  title: string; companyName: string; location: string; country: string | null;
  remotePolicy: "remote" | "hybrid" | "onsite" | "unknown";
  salary: { min: number | null; max: number | null; currency: string; period: "year" | "month" | "hour" } | null;
  descriptionText: string; postedAt: Date | null;
};
type SourceResult = { jobs: NormalizedJob[]; harvested: BoardRef[] };
htmlToText(html: string): string            // decodes entities (incl. double-escaped Greenhouse content), strips tags, keeps paragraph breaks
parseSalary(text: string): NormalizedJob["salary"]
toUsdYearMid(s: NonNullable<NormalizedJob["salary"]>, fx: Record<string, number>): number | null
inferRemote(location: string, text: string): NormalizedJob["remotePolicy"]
inferCountry(location: string): string | null   // ISO-2; recognizes Egypt/Cairo/Alexandria/Giza → "EG", common US states/cities → "US", plus UK, DE, AE, SA, CA, NL, FR, ES, PL
```

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check:** `npx tsx scripts/check-text.ts` prints each case and its result, and every case matches:
  - `htmlToText("&lt;p&gt;Hello &amp;amp; bye&lt;/p&gt;")` → `"Hello & bye"`
  - `parseSalary("$150,000 - $180,000 per year")` → `{min:150000,max:180000,currency:"USD",period:"year"}`
  - `parseSalary("$150k–$180k")` → min 150000, max 180000, USD, year
  - `parseSalary("EGP 60,000 - 80,000 monthly")` → EGP, month
  - `parseSalary("£70k")` → `{min:70000,max:70000,currency:"GBP",period:"year"}`
  - `parseSalary("competitive salary")` → `null`
  - `toUsdYearMid({min:60000,max:80000,currency:"EGP",period:"month"}, config.fxToUsd)` → `≈ 17220` (70000×12×0.0205, toBeCloseTo 0)
  - `inferRemote("Remote - Worldwide","")` → `"remote"`; `inferCountry("Cairo, Egypt")` → `"EG"`
- [ ] **Step 3:** Commit `feat: source types and text utilities`.

---

### Task 4: ATS board fetchers (Greenhouse, Lever, Ashby, Workable)

**Files:** Create `src/sources/{greenhouse,lever,ashby,workable}.ts`, `src/sources/http.ts` (shared `getJson(url)` with UA, 20s timeout, per-host limit of 4 via `p-limit`). `scripts/fetch-board.ts <ats> <slug>`.

**Interfaces:**
- Produces: `fetchBoard(ref: BoardRef): Promise<NormalizedJob[]>` in `src/sources/index.ts`, dispatching to:
  - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`, source `"greenhouse"`, externalId `id`, description from `content` (double-escaped HTML).
  - Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`, externalId `id`, `categories.location`, `workplaceType`, description `descriptionPlain` + lists, `salaryRange` if present.
  - Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`, `isRemote`, `compensation` → salary.
  - Workable: `https://apply.workable.com/api/v1/widget/accounts/{slug}`, `jobs[]` with `shortcode`, `city`, `country`, `telecommuting`, `url`. Companyname from top-level `name`.
- `companyName` for ATS sources comes from the board (Greenhouse/Lever/Ashby: title-cased slug unless the payload carries a name).
- Throws `BoardNotFoundError` on 404 (used by Task 8 for failCount).

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check** live with `npx tsx scripts/fetch-board.ts` for greenhouse `airbnb`, lever `palantir`, ashby `ramp`, workable `instabug`: each prints a job count > 0, every job has non-empty `title`, `applyUrl` starting `https://`, `descriptionText` without `<`, and the right `source`. Ashby `ramp` shows at least one job with non-null `salary`. `fetch-board.ts greenhouse this-board-does-not-exist-xyz` prints `BoardNotFoundError`.
- [ ] **Step 3:** Commit `feat: greenhouse, lever, ashby, workable fetchers`.

---

### Task 5: OpenRouter client and budget

**Files:** Create `src/llm/openrouter.ts`, `src/budget/budget.ts`. Tests `tests/budget/budget.test.ts` (budget tests are the ones Sherif kept).

**Interfaces:**
```ts
// POST https://openrouter.ai/api/v1/chat/completions with
// { model, messages, response_format: { type: "json_object" }, usage: { include: true } }.
// Cost = response.usage.cost (USD).
chatJSON<T>(opts: { model: string; system: string; user: string; category: "scoring" | "tailoring"; estimateUsd: number }): Promise<T>
  // 1) await canSpend(category, estimateUsd) else throw BudgetExceededError
  // 2) call; JSON.parse content; on parse failure retry once; second failure throws InvalidLLMOutputError
  // 3) recordSpend for every call made (including the failed attempt)
canSpend(category: "scoring" | "tailoring", estimateUsd: number, now?: Date): Promise<boolean>
recordSpend(e: { category; provider: "openrouter" | "typesafe"; model: string; usd: number; inputTokens: number; outputTokens: number }): Promise<void>
spendSummary(now?: Date): Promise<{ todayUsd: number; monthUsd: number; monthScoringUsd: number; capUsd: number }>
class BudgetExceededError, InvalidLLMOutputError
```
- Rules: month total + estimate ≤ `budgetUsdMonthly`. For scoring: month scoring + estimate ≤ `budgetUsdMonthly × scoringShare`, and today's scoring + estimate ≤ that ÷ 30. Calendar month and day in local time.
- Env: `OPENROUTER_CHEAP_MODEL` (required). The implementer chooses it by querying `https://openrouter.ai/api/v1/models`, picking a capable model with prompt price ≤ $0.15/M tokens that supports `response_format`, and writing the choice into `.env.example`.

- [ ] **Step 1: Failing budget tests:**
  - With $4.99 of scoring spend recorded this month, `canSpend("scoring", 0.02)` → false; `canSpend("tailoring", 0.02)` → true.
  - With $0.16 of scoring spend today, `canSpend("scoring", 0.01)` → false (daily cap 5/30 ≈ 0.1667).
  - With $9.99 of total spend this month, `canSpend("tailoring", 0.02)` → false.
  - Last month's spend is ignored.
- [ ] **Step 2: Failing budget test for the client** (mock fetch): `chatJSON` throws `BudgetExceededError` without calling fetch when `canSpend` is false, and records a spend row with `usage.cost` after a successful call.
- [ ] **Step 3:** `npx vitest run tests/budget` → FAIL. **Step 4:** Implement (including the retry-once rule). **Step 5:** `npx vitest run tests/budget` → PASS.
- [ ] **Step 6:** Commit `feat: openrouter client with hard budget`.

---

### Task 6: Feed sources, discovery, upsert

**Files:** Create `src/sources/{remoteok,wwr,hn}.ts`, `src/discovery/{boardRefs,probe,seed}.ts`, `src/pipeline/upsert.ts`, `data/egypt-companies.json`. `scripts/check-feeds.ts`, `scripts/check-upsert.ts`.

**Interfaces:**
- `fetchRemoteOk(): Promise<SourceResult>`: `https://remoteok.com/api` (skip element 0, the legal notice), remotePolicy `remote`.
- `fetchWwr(): Promise<SourceResult>`: `https://weworkremotely.com/categories/remote-programming-jobs.rss` and `.../remote-full-stack-programming-jobs.rss`. Title format `Company: Role`.
- `fetchHn(): Promise<SourceResult>`: finds the latest story by `whoishiring` with title starting "Ask HN: Who is hiring" (`https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring`), loads `https://hn.algolia.com/api/v1/items/{id}`, and takes top-level comments only. Each comment goes to `chatJSON` (category `scoring`, cheap model), which returns `{ jobs: [{ company, title, location, remote: boolean, visa: boolean|null, url|null, salaryText|null }] }`. It processes only comments not yet stored (externalId = comment id, then `hn:{commentId}:{index}`). On `BudgetExceededError` it stops and returns what it has.
- Every source returns `harvested` = `extractBoardRef` over all URLs it saw.
- `extractBoardRef(url: string): BoardRef | null` recognizes `boards.greenhouse.io/{slug}`, `job-boards.greenhouse.io/{slug}`, `jobs.lever.co/{slug}`, `jobs.ashbyhq.com/{slug}`, `apply.workable.com/{slug}`.
- `probeSlugs(name: string, website?: string): Promise<BoardRef[]>`: candidate slugs = lowercase name without spaces, hyphenated name, and the website domain stem. Tries each ATS endpoint; 200 with ≥1 job = hit.
- `seedCompanies(): Promise<{ added: number }>`: runs once if `companies` is empty. YC: `https://yc-oss.github.io/api/companies/hiring.json` (`name`, `slug`, `website`). Egypt: `data/egypt-companies.json`, a hand list of ≥25 Egyptian tech employers with candidate slugs (e.g. Instabug, Paymob, Swvl, MoneyFellows, Breadfast, Thndr, Valu, Halan, Rabbit, Khazna, Vezeeta, Elmenus, Trella, Bosta, Sylndr, Nawy, Raya, Valeo Egypt, Siemens EDA Cairo, Synapse Analytics — **the implementer verifies each by probing and keeps only hits**). Probing runs with concurrency 4 and is resumable: it skips names already probed (`settings.probed_names`).
- `jobKey(j: NormalizedJob): string` = `normalize(companyName) + "|" + normalize(title)`. Normalize: lowercase, strip punctuation, collapse whitespace, drop suffixes `inc|llc|ltd|gmbh|co`, and drop the title's parenthetical/after " - " location parts.
- `upsertJobs(js: NormalizedJob[]): Promise<{ inserted: number; updated: number }>`: on key conflict, update `lastSeenAt`, clear `closedAt`, and add a `jobSources` row. `applyUrl` prefers ATS sources (greenhouse/lever/ashby/workable) over feeds. A new job gets `status: "found"`.
- `markClosed(ref: BoardRef, seenExternalIds: string[]): Promise<number>` sets `closedAt=now` for jobs whose only source rows for that board are missing from `seenExternalIds`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check** (`npx tsx scripts/check-feeds.ts` live, `scripts/check-upsert.ts` against `jobfinder_test`):
  - feeds: RemoteOK → no job has `title` undefined, and element 0 is skipped. WWR splits `"Acme: Senior AI Engineer"` into company `Acme`, title `Senior AI Engineer`. HN on the live thread, limited to 5 comments: a comment listing 2 roles yields 2 jobs with externalIds `hn:<id>:0`, `hn:<id>:1`, and a reply with invalid JSON twice is skipped with a logged reason (no crash).
  - `extractBoardRef("https://jobs.lever.co/palantir/abc")` → `{ats:"lever",slug:"palantir"}`; `extractBoardRef("https://job-boards.greenhouse.io/anthropic/jobs/1")` → greenhouse/anthropic; `extractBoardRef("https://example.com")` → null.
  - upsert: the same job from greenhouse and remoteok → one `jobs` row and two `jobSources` rows, with `applyUrl` the greenhouse one. `jobKey` of "Acme, Inc." + "AI Engineer (Remote)" equals "acme" + "ai engineer".
  - Closed jobs: upsert 2 greenhouse jobs, then `markClosed(ref,[id1])` → the second has `closedAt` set and the first doesn't. Re-upserting the second clears `closedAt`.
- [ ] **Step 3:** Commit `feat: feeds, company discovery, dedupe upsert`.

---

### Task 7: Pre-filter and scoring

**Files:** Create `src/pipeline/prefilter.ts`, `src/scoring/{types,state,jev,composite,scoreJobs}.ts`, `scripts/score-one.ts <jobId>`. Test `tests/budget/scoreJobs.test.ts` (budget only).

**Interfaces:**
```ts
prefilter(j: { title: string; descriptionText: string }): { pass: true } | { pass: false; reason: string }
type Feasibility = "in_egypt" | "remote_from_egypt" | "sponsors" | "unclear" | "not_possible";
type DimensionScores = { scope: number; company: number; pay: number; level: number; fit: number; canTake: Feasibility; canTakeConfidence: number; raw: unknown };
type JobRow = typeof jobs.$inferSelect;
interface Scorer { engine: "jev"; estimateUsd(): number; score(job: JobRow, profile: BaseProfile): Promise<DimensionScores> }
buildScoringState(job, profile): object   // { job: {title, company, location, country, remotePolicy, salary, description (first 6000 chars)}, candidate: {headline, roles (title/org/dates/bullets), projects, skills, facts} }
composite(s: DimensionScores, w: Weights): { score: number; sortGroup: 0 | 1 }   // score = Σ w_i·d_i, minus 5 if unclear, clamped 0–100, rounded; sortGroup 1 iff not_possible
scorePending(opts?: { limit?: number }): Promise<{ scored: number; failed: number; stoppedForBudget: boolean }>
```
- Pre-filter rules (applied to title unless noted). Include if `/\b(software|engineer|engineering|developer|full[- ]?stack|back[- ]?end|front[- ]?end|ai|ml|machine learning|llm|founding|product engineer)\b/i`. Exclude if `/\b(intern|internship|staff|principal|director|vp|vice president|head of|manager|sales|account executive|recruit\w*|designer|analyst|qa|tester|support|technician|mechanical|electrical|civil|hardware)\b/i`. Also exclude if the description matches `/\b([89]|1\d)\+?\s*(years|yrs)\b/i`. Reasons: `"not a software role"`, `"excluded title: <word>"`, `"requires 8+ years"`.
- Dimensions (each is a Jev `score` with 5 levels, normalized `score/4×100`). Level wording is the implementer's, following the TypeSafe Score docs (levels describe concrete situations), anchored as:
  - scope: 0 no software work … 4 core AI/LLM product engineering or founding engineer
  - company: 0 no signal or weak … 4 well-funded, strong, fast-growing or top-tier
  - pay: 0 well below the local market for this role … 4 top of the local market (not posted → the question says to answer level 1)
  - level: 0 far too junior or senior for ~2 years incl. two founding roles … 4 exact match (mid-level, founding, or "early career OK")
  - fit: 0 needs skills he lacks entirely … 4 his shipped work maps directly onto the requirements
  - canTake: Jev `choice` over the 5 feasibility keys, with definitions in the question. `canTakeConfidence` = the choice confidence.
- `jevScorer`: one `client.systemOne({ state, questions })` call with all 6 questions. Cost = usage tokens × `JEV_USD_PER_MTOK_INPUT` (default `0.042`) / `JEV_USD_PER_MTOK_OUTPUT` (default `0`), and `recordSpend` provider `typesafe`. `estimateUsd()` = 0.0003 (2× the expected cost, to stay conservative). Check `canSpend` before the call.
- `scorePending` takes `status="found"` jobs, runs `prefilter` (failures → `filtered_out` + reason, free), scores the rest highest-`salaryUsdYearMid`-first then newest. On `BudgetExceededError` it stops and returns `stoppedForBudget: true`, leaving the rest `found`. On a Jev API error, retry once after 2s, then the job becomes `score_failed` with the reason.

- [ ] **Step 1: Failing budget test** `tests/budget/scoreJobs.test.ts`: `stops scoring when budget would be exceeded`. A fake Scorer throws `BudgetExceededError` on the 3rd job → 2 scored, the rest still `found`, `stoppedForBudget` true. Run `npx vitest run tests/budget` → FAIL.
- [ ] **Step 2:** Implement. Then `npx vitest run tests/budget` → PASS, and **check** with `npx tsx scripts/score-one.ts <id>` on 3 real jobs from the Task 6 data:
  - prefilter: "Senior Software Engineer" passes; "Software Engineering Intern" fails `excluded title: intern`; "Account Executive" fails; "AI Engineer" with "10+ years of experience" fails `requires 8+ years`; "Founding Engineer" passes.
  - Each scored job prints 5 dimensions between 0 and 100, a feasibility key, a composite, and one `spend` row with provider `typesafe` and usd < 0.001.
  - composite: all dims 100 + `sponsors` → 100; all 50 + `unclear` → 45; `not_possible` → sortGroup 1.
  - With `TYPESAFE_API_KEY` set to a bad value, the job ends `score_failed` with a reason and the script doesn't crash.
- [ ] **Step 3:** Commit `feat: prefilter and job scoring`.

---

### Task 8: Search cycle and worker

**Files:** Create `src/pipeline/cycle.ts`, `src/worker/index.ts`, `src/app/api/run/route.ts`.

**Interfaces:**
```ts
runSearchCycle(): Promise<{ boards: number; boardFailures: number; inserted: number; updated: number; closed: number; harvested: number; scored: number; stoppedForBudget: boolean }>
```
- Order: mark stale `running` runs older than 1h `abandoned` → insert a `runs` row → `seedCompanies()` → fetch all active boards (concurrency 4; per board: `fetchBoard`, `upsertJobs`, `markClosed`, `lastPolledAt`; `BoardNotFoundError` or a network error → `failCount++`, `active=false` at 3, success resets it to 0) → feeds (RemoteOK, WWR, HN), each wrapped so one failing feed is logged into `stats.errors` and skipped → insert harvested BoardRefs as `origin: "harvested"` (on conflict do nothing) → `scorePending()` → finish the run with stats.
- Worker: on start and every `searchIntervalHours`, run a cycle unless one is `running`. It also polls `runs` every 30s for a row with `requested=true` and status null, which is created by `POST /api/run` (the "Run now" button). Logs one line per cycle with the stats. `npm run worker` = `tsx src/worker/index.ts`; `--once` runs a single cycle and exits.
- Env `MAX_BOARDS` (optional integer) limits how many active boards a cycle polls, ordered by `lastPolledAt` asc nulls first. Default: no limit.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check** with `MAX_BOARDS=20 npm run worker -- --once`, after manually inserting one bogus board (`greenhouse`, `this-board-does-not-exist-xyz`):
  - The cycle completes. The bogus board has failCount 1, and its error appears in the run's `stats.errors`.
  - Running `--once` again leaves `select count(*) from jobs` and `from job_sources` unchanged (or grows only by genuinely new postings), and the bogus board reaches failCount 2.
  - `update runs set status='running', started_at=now()-interval '2 hours'` on the last run, then `--once` → that run becomes `abandoned`.
- [ ] **Step 3:** Commit `feat: search cycle and scheduler worker`.

---

### Task 9: Dashboard (ranked list, detail panel, settings)

**Files:** Create `src/queries/jobs.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/settings/page.tsx` (+ server actions), `src/app/components/*.tsx`.

**Interfaces:**
```ts
type JobFilters = { stage?: "found" | "scored" | "filtered_out" | "score_failed"; canTake?: boolean; salaryPosted?: boolean; minScore?: number; ai?: boolean; founding?: boolean; remote?: boolean; source?: string; includeClosed?: boolean };
listJobs(f: JobFilters, weights: Weights): Promise<RankedJob[]>  // RankedJob = job + scores + composite + sources[]; sorted by sortGroup asc, composite desc, firstSeenAt desc
getJob(id: number, weights: Weights): Promise<RankedJob | null>
stageCounts(): Promise<{ found: number; scored: number; filteredOut: number; failed: number }>
```
- Filters: `canTake` = canTake ∉ {not_possible}; `ai` = title or descriptionText matches `/\b(ai|ml|llm|machine learning)\b/i`; `founding` = title matches `/founding/i`; closed jobs are hidden unless `includeClosed`.
- UI follows the approved mockup `.superpowers/brainstorm/79783-1794396116/content/dashboard-themes.html` with the Graphite skin. Port its layout and CSS tokens, using plain CSS in `globals.css` and Geist via the `geist` package. Phase 1 differences:
  - Header: run status ("Last search 14 min ago across N sources" from the latest `runs` row), a **Run now** button (POST `/api/run`), spend today / month vs cap from `spendSummary`. No applied counts.
  - Stage strip: Found (unscored), Scored, Filtered out, Failed. Clicking one sets `?stage=`.
  - Filter chips map to `JobFilters` via query params. The list is server-rendered from `listJobs`.
  - Row: rank, title, "Company, location", composite + stacked bar (each segment width = w_i·d_i), salary (original currency; "Not posted" in italic) with the feasibility label under it ("In Egypt", "Remote OK", "Sponsors", "Unclear", "Can't take"), source.
  - Detail panel (`?job=id`): title, company + location, facts (score, salary + "≈ $X/yr" from `salaryUsdYearMid`, feasibility, sources with links), "Why it ranks here" per-dimension bars, and buttons **View listing** (applyUrl) and **Skip job** (status `filtered_out`, reason "skipped by you"). The tailoring tabs are not in Phase 1; show the job description text in their place.
  - Settings page: weights (5 number inputs; saved normalized to sum 1), cutoff, search interval hours, monthly budget, scoring engine. Saved into `settings`. Plus a **Base profile** editor: a JSON textarea of the `profile` row. Save rejects JSON missing `roles` or `skills` and shows the error in place, and **Re-import from resume.tex** re-runs `parseResumeTex`. (Spec section 3: Sherif can edit the profile.)
- [ ] **Step 1:** Implement the queries and UI.
- [ ] **Step 2: Check** in the running app with real data from Task 8: `not_possible` jobs sit at the bottom; the 60+ chip hides lower scores; the salary-posted chip hides "Not posted"; closed jobs are hidden; changing a weight in Settings re-orders the list without a new run.
- [ ] **Step 3:** Verify with `npm run dev` and the `run` skill: screenshot `/` with seeded test data at 1440px and 390px wide. Check that no horizontal scroll appears at 390px, the keyboard focus is visible on chips and rows, and the colors match the Graphite tokens.
- [ ] **Step 4:** Commit `feat: graphite dashboard and settings`.

---

### Task 10: Live end-to-end run

**Files:** Create `README.md` (setup: brew Postgres, `.env`, `npm run db:migrate`, `npm run dev` + `npm run worker` in two terminals, Jev price env vars).

- [ ] **Step 1:** With real keys, temporarily set `MAX_BOARDS=50` (env read by the cycle; default unlimited) and run one cycle via `npm run worker -- --once`. Expected: the log shows boards > 0, inserted > 0, scored > 0, and spend recorded below $0.50.
- [ ] **Step 2:** Open the dashboard. Confirm that ranked jobs appear, Egyptian jobs (from the seed) show "In Egypt", detail panel bars render, and Run now creates a run.
- [ ] **Step 3:** Remove the `MAX_BOARDS` limit from `.env` and commit `docs: setup readme and phase 1 verification`.
