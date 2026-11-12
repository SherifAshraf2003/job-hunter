# Job Finder Phase 3 (Apply) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension in Sherif's own browser that fills and submits applications on Greenhouse, Lever, Ashby and Workable, fills (never submits) LinkedIn Easy Apply, and collects LinkedIn search results, driven by an apply queue, answer bank and safety guardrails in the local app.

**Architecture:** The local Next.js app owns every decision. It decides which job is next (caps, pauses, trust period), what goes in each field (profile, rules, answer bank, or a drafted answer), and whether to submit. The extension does only DOM work: it extracts form fields, asks the app for a fill plan, fills the fields, submits or stops, and reports what happened. The extension and the app talk over `http://localhost:3100/api/ext/*` with a shared token.

**Tech Stack:** Next.js 15 route handlers, Drizzle and Postgres, Vitest, OpenRouter via the existing `chatJSON`, pdf-lib (cover letter PDF). The Chrome extension uses Manifest V3 and plain JavaScript with no bundler, under `extension/`.

**Spec:** `docs/superpowers/specs/2026-11-11-job-finder-design.md` (sections 4, 5, 6.1 for LinkedIn collection, 6.4, 6.5, 6.6, 8)

## Global Constraints

- LinkedIn is never auto-submitted. The plan for a LinkedIn job always has `action: "stop"`, and the LinkedIn adapter has no submit code path.
- Auto-submit applies on Greenhouse, Lever, Ashby and Workable only. Every other site is `manual` (not queued for the extension).
- **Trust period:** the first 10 auto-submit applications stop at `ready_to_submit` and need one-click approval. `settings.trustRemaining` defaults to 10, each approval decrements it, and Sites & caps can reset it to 10.
- **Salary:** if the form asks for expected salary and the listing posts none, don't submit; status is `needs_you` with the reason "No salary posted". If the form doesn't ask, submit normally.
- **Salary amount:** 10% under the posted midpoint, or under the bottom when `salaryRule = "under_min"`. Answer in the listing's own currency and period.
- **Sponsorship:** job in Egypt → No. Remote job that `canTake = remote_from_egypt` → No. US, or on-site/hybrid anywhere else → Yes.
- **Work authorization:** Yes only for Egypt. Any other country → No.
- **EEO questions:** decline to answer.
- **Caps (editable defaults):**
  - LinkedIn: 15/day.
  - ATS: 3/day per company board, 60/day global.
  - Same company: at most 2 applications in 30 days, best-scoring roles first.
- **Captcha:** a captcha on one form sends that job to `needs_you` with the form filled; the site is not paused. 3 or more captchas in an hour on one site, an "unusual activity" or account-warning page, or a login wall pauses that site and shows an alert.
- **Pacing:**
  - 0.4–1.5s random delay between fields.
  - 90–240s random delay between applications.
  - One application tab at a time.
- **Never half-submit:** forms with unknown required fields, or multi-page flows that break, go to `needs_you` with what's filled. They are never submitted.
- **Never invent:** drafted answers come only from the base profile and answer bank. When the facts don't answer a question, the answer is `null`, and a required `null` field means `needs_you`.
- **Budget:** LLM calls made while applying use spend category `tailoring` (the reserved half) through `chatJSON`. The $10 hard cap holds. When the budget is out, unknown fields become `needs_you` and no call is made.
- **API keys:** keys stay in `.env`. The extension holds only the local token (`settings.extensionToken`, 32 random hex bytes, created on first read).
- **Dry run:** `settings.dryRun` defaults to `true`. The extension fills but never clicks submit, and reports `stopped: dry run`. Every task in this plan verifies with dry run on. Only Sherif turns it off, from Sites & caps.
- **Tests:** Sherif's policy is automated tests only for budget behavior and the truth check. This plan adds tests for the guardrail decisions too (`tests/apply/*`), because they protect the spec's anti-goals: account bans, LinkedIn auto-submit and lying on forms. Everything else is verified by running it.

## Review Focus

1. **Fields the extension can't read:** a required field with a custom widget it can't extract or fill (React combobox, location autocomplete). Expect `needs_you` naming the field, never a submit. Covered by the Task 4 test `required field without answer stops`, plus a Task 7 check that the filler re-reads required fields before submitting.
2. **Same job twice:** the extension crashes or the tab closes mid-fill and the job is handed out twice. Expect the lease to expire after 10 minutes and the job to return to `queued` once. Covered by the Task 2 test `stale lease returns to queue`.
3. **Salary as a select:** a salary question with range options, or a number-only input. Expect the closest option at or above the rule amount, or digits only for a number input. Covered by the Task 3 tests `salary picks range option` and `salary number input is digits`.
4. **Job closed before applying:** the listing closed between tailoring and applying. Expect the job to be marked closed and skipped, with no fill. Covered by the Task 5 test `closed report closes job and skips application`.
5. **Unread approvals:** approving a ready job while the trust count is already 0. Expect submission without the count going negative. Covered by the Task 2 test `approval never drives trustRemaining below 0`.

---

## File Structure

- `src/apply/types.ts`: `FormField`, `Fill`, `FillPlan`, `AppStatus`, `Site`, `ReportOutcome`.
- `src/apply/sites.ts`: `siteOf(url)`, `pickApplyTarget(job, sources)`, `boardKey(url)`.
- `src/apply/queue.ts`: `queueApplications()`, `nextApplication(now)`, `approve(jobId)`, the lease.
- `src/apply/rules.ts`: `classify(field)`, `answerByRule(field, ctx)` for profile facts, salary, sponsorship, work authorization, EEO, files.
- `src/apply/bank.ts`: `normalizeQuestion`, `lookupBank`, `saveDrafted`, `seedBank(setup)`.
- `src/apply/plan.ts`: `buildFillPlan(jobId, fields)`, which runs rules, then the bank, then one batched LLM draft, then the decision.
- `src/apply/report.ts`: `applyReport(jobId, report)`, which handles status changes, site events and the kill switch.
- `src/apply/coverPdf.ts`: `coverLetterPdf(text, profile)`.
- `src/app/api/ext/{next,plan,report,listings,collect}/route.ts`, `src/app/api/ext/file/[jobId]/[kind]/route.ts`, `src/app/api/ext/auth.ts`.
- `src/app/answers/page.tsx` (Answer bank and setup form), `src/app/sites/page.tsx` (Sites & caps).
- `extension/manifest.json`, `extension/background.js`, `extension/options.html`, `extension/options.js`, `extension/content/{common,greenhouse,lever,ashby,workable,linkedin,linkedin-collect}.js`.
- Tests: `tests/apply/queue.test.ts`, `tests/apply/rules.test.ts`, `tests/apply/plan.test.ts`, `tests/apply/report.test.ts`.

---

### Task 1: Schema, settings, site detection

**Files:**
- Modify: `src/db/schema.ts`, `src/db/client.ts` (`resetDb` truncates the new tables), `src/config.ts`
- Create: `src/apply/types.ts`, `src/apply/sites.ts`, a migration via `npm run db:generate && npm run db:migrate`

**Interfaces:**
- Produces tables:
  - `applications`:
    - `jobId` (int pk, FK jobs cascade), `status` (enum `app_status`: `queued|filling|ready_to_submit|needs_you|submitting|applied|skipped|failed|manual|interviewing|rejected|offer`)
    - `site` (enum `site`: `greenhouse|lever|ashby|workable|linkedin|other`), `boardKey` (text, `"{ats}:{slug}"`, or `"linkedin"`), `targetUrl` (text)
    - `reason` (text null), `fills` (jsonb `Fill[]` null), `approved` (bool, default false)
    - `leaseAt`, `filledAt`, `appliedAt` (timestamptz null), `queuedAt` (default now), `attempts` (int, default 0)
  - `answers`: `id` serial, `key` (text unique, normalized question), `question`, `answer`, `source` (`seed|drafted|edited`), `isNew` (bool), `updatedAt`.
  - `sites`: `site` (pk, enum `site`), `autoSubmit` (bool, default true; linkedin row false and not editable), `dailyCap` (int null), `paused` (bool), `pauseReason` (text null), `pausedAt`.
  - `siteEvents`: `id`, `site`, `kind` (`captcha|blocked|login_wall|warning`), `at`, `jobId` (null).
- Produces config defaults: `trustRemaining: 10`, `dryRun: true`, `globalPause: false`, `caps: { linkedinDaily: 15, perBoardDaily: 3, globalDaily: 60, perCompany30d: 2 }`, `salaryRule: "under_mid" as "under_mid" | "under_min"`, `pacing: { fieldMs: [400, 1500], betweenAppsSec: [90, 240] }`, `extensionToken: ""`.
- Produces `siteOf(url: string): Site`, matching `jobs.lever.co`, `jobs.ashbyhq.com`, `(job-)?boards.greenhouse.io`, `apply.workable.com` or `*.workable.com`, and `linkedin.com/jobs`; anything else is `other`.
- Produces `pickApplyTarget(job: {applyUrl: string}, sources: {source: string; url: string}[]): { url: string; site: Site; boardKey: string }`. It prefers an ATS URL from `sources` or `applyUrl` over LinkedIn (spec 6.1). `boardKey` comes from `extractBoardRef` (`src/discovery/boardRefs.ts`).

- [ ] **Step 1:** Add the tables, enums and config keys above. `loadSettings` already overlays any key in `config`.
- [ ] **Step 2:** Run `npm run db:generate && npm run db:migrate`. Expected: a new `drizzle/0004_*.sql` applies to both `jobfinder` and `jobfinder_test`.
- [ ] **Step 3:** Run `npx tsc --noEmit && npm test`. Expected: clean, with 47 tests passing.
- [ ] **Step 4:** Commit with `feat(apply): schema, settings and site detection`.

### Task 2: Apply queue and guardrails

**Files:**
- Create: `src/apply/queue.ts`, `tests/apply/queue.test.ts`
- Modify: `src/pipeline/cycle.ts` (call `queueApplications()` after tailoring)

**Interfaces:**
- Consumes: `pickApplyTarget`, the tables and config from Task 1, `composite`.
- Produces:
  - `queueApplications(): Promise<{ queued: number; manual: number }>` inserts one `applications` row for each job that has `tailorings.pdfPath`, `closedAt` null and `canTake <> not_possible`, with no existing row. Status is `queued` for the four ATSs and LinkedIn, `manual` for `other`.
  - `nextApplication(now?: Date): Promise<{ jobId: number; url: string; site: Site; mode: "fill" | "submit" } | { idle: string }>` hands out the next job and sets `status = filling` (`submitting` for mode submit) and `leaseAt = now`.
  - `approve(jobId: number): Promise<void>` sets `approved = true` and decrements `trustRemaining`, never below 0.
  - `refill(jobId: number): Promise<void>` sets a `needs_you` job back to `queued` with `approved = false`, for "Fill again in Chrome".

Order inside `nextApplication`:
1. Expired leases (`filling` or `submitting` with `leaseAt` older than 10 minutes) go back to their previous state: `queued`, or `ready_to_submit` when approved.
2. `globalPause` returns `{idle: "Paused"}`.
3. Approved `ready_to_submit` jobs come first, in mode `submit`.
4. Then `queued` jobs by composite, best first. Skip a job when:
   - its site is paused;
   - its site has reached today's cap (LinkedIn counts `filledAt` today against `linkedinDaily`);
   - its board has reached `perBoardDaily` (counts `appliedAt` today plus `submitting`);
   - `globalDaily` is reached (all ATS `appliedAt` today);
   - the same normalized `companyName` already has `perCompany30d` applications with `queuedAt` in the last 30 days and status not in `queued|skipped|failed|manual`.
5. If nothing qualifies, return `{idle: reason}`.

- [ ] **Step 1: Write the failing tests** in `tests/apply/queue.test.ts`. Use a helper that inserts a scored, tailored job with a given composite, applyUrl and company.
  - `hands out best composite first`: two queued jobs at 90 and 70 return the 90 job, and its status becomes `filling`.
  - `per-board daily cap`: 3 applications applied today on `greenhouse:acme` make a 4th acme job get skipped, and the next board is handed out instead.
  - `linkedin cap counts fills`: 15 LinkedIn `filledAt` today return `{idle}` when only LinkedIn jobs are queued.
  - `per-company 30d limit`: 2 applied for "Acme" 10 days ago skip a third Acme job. With 2 applied 31 days ago, it is handed out.
  - `paused site skipped and global pause idles`.
  - `approved ready job comes first in submit mode`.
  - `stale lease returns to queue`: `filling` with `leaseAt` 11 minutes ago is handed out again with `attempts` incremented.
  - `approval never drives trustRemaining below 0`: with `trustRemaining = 0`, `approve` leaves it at 0.
  - `queueApplications marks unsupported sites manual`: a RemoteOK-only applyUrl gets status `manual`.
- [ ] **Step 2:** Run `npx vitest run tests/apply/queue.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/apply/queue.ts`, and call `queueApplications()` in `runSearchCycle` right after `tailorPending`, adding its counts to `CycleStats`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit with `feat(apply): queue with caps, pauses, leases and trust approval`.

### Task 3: Rule answers

**Files:**
- Create: `src/apply/rules.ts`, `tests/apply/rules.test.ts`

**Interfaces:**
- Consumes: `BaseProfile`, job row, `jobScores.canTake`, config `salaryRule`.
- Produces:
  - `FormField = { id: string; label: string; kind: "text"|"textarea"|"email"|"tel"|"url"|"number"|"select"|"radio"|"checkbox"|"file"|"date"; required: boolean; options?: string[] }`
  - `Fill = { id: string; label: string; value: string | string[] | boolean | null; file?: "resume" | "cover"; source: "profile" | "rule" | "bank" | "drafted" | "job" }`
  - `classify(f: FormField): Kind`, where `Kind` is one of:
    - profile and bank facts: `first_name`, `last_name`, `full_name`, `email`, `phone`, `linkedin`, `github`, `website`, `location`, `current_company`, `years_experience`
    - rules: `salary`, `sponsorship`, `work_auth`, `eeo`
    - files: `resume_file`, `cover_file`, `cover_text`
    - per-job question: `why_us`
    - anything else: `other`
  - `answerByRule(f: FormField, ctx: { profile: BaseProfile; job: JobRow; canTake: Feasibility; salaryRule: "under_mid" | "under_min" }): Fill | "no_salary" | null`. It returns `null` when no rule applies, and `"no_salary"` for a salary question when the job has no salary.

Rules, written as code over the label (lowercased):
- **Profile facts:** name, email, links, `years_experience` and `location` come from the profile.
  - name and email come from `profile.name` and `profile.links[0]`
  - linkedin, github and website are the links matching those hosts
  - `location` is `"Cairo, Egypt"` unless the bank has `city`
- **Salary:** the target is `0.9 × (min+max)/2`, or `0.9 × min` under `under_min`. Round to 1000 for year, 100 for month and 1 for hour.
  - number input: the digits only
  - text: `"{amount with thousands separators} {CUR} per {period}"`
  - select or radio: pick the first option whose lowest number is ≥ target; if none, the last option
- **Sponsorship:** a yes/no value from the spec rule. For select or radio, pick the option starting with `Yes` or `No` (case-insensitive).
- **Work authorization:**
  - an explicit country name in the label: Egypt → Yes, otherwise No
  - no country named: the job's country (`EG` → Yes, otherwise No)
- **EEO** (gender, race, ethnicity, veteran, disability, hispanic, latino): pick the option matching `/decline|prefer not|don't wish|do not wish|not to (say|answer|disclose)/i`. If there's no such option, return `null`.
- **Files:**
  - a `file` field whose label matches `/resume|cv/` → `{file: "resume"}`
  - a `file` field matching `/cover/` → `{file: "cover"}`
  - a textarea matching `/cover letter/` → `cover_text` (resolved in Task 4)

- [ ] **Step 1: Write the failing tests:**
  - `salary under midpoint in listing currency`: EGP 60,000–80,000 per month gives text `"63,000 EGP per month"`.
  - `salary under_min rule`: USD 150k–180k per year gives `"135,000 USD per year"`.
  - `salary number input is digits`: gives `"63000"`.
  - `salary picks range option`: options `["$100k-$120k", "$120k-$140k", "$140k+"]` with target 148,500 give `"$140k+"`.
  - `no salary posted returns no_salary`.
  - `sponsorship by job`: Egypt → No; remote with `remote_from_egypt` → No; US on-site → Yes; UK hybrid → Yes.
  - `work authorization`: "authorized to work in the United States?" → No; "authorized to work in Egypt?" → Yes.
  - `eeo declines`: "Gender" with `["Male", "Female", "Decline to self-identify"]` gives `"Decline to self-identify"`.
  - `resume file field`.
- [ ] **Step 2:** Run `npx vitest run tests/apply/rules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/apply/rules.ts`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit with `feat(apply): rule answers for profile, salary, sponsorship, work auth, EEO`.

### Task 4: Answer bank, fill plan, cover letter

**Files:**
- Create: `src/apply/bank.ts`, `src/apply/plan.ts`, `src/apply/coverPdf.ts`, `tests/apply/plan.test.ts`

**Interfaces:**
- Consumes: `classify` and `answerByRule` (Task 3), `chatJSON`, `canSpend`, `TOP_MODEL` and `MID_MODEL`, `generateExtras(job, profile, t, {coverLetter: true, insights: false})`, and the `tailorings` row.
- Produces:
  - `normalizeQuestion(label: string): string` lowercases, strips `*`, `(optional)`, `(required)` and punctuation, and collapses whitespace.
  - `lookupBank(label: string): Promise<string | null>` does an exact match on the normalized key.
  - `saveDrafted(label: string, answer: string): Promise<void>` saves with `source: "drafted"` and `isNew: true`, without overwriting `seed` or `edited` rows.
  - `seedBank(setup: { phone: string; city: string; noticePeriod: string; relocate: "Yes" | "No"; heardFrom: string }): Promise<void>` writes `source: "seed"` rows keyed by the normalized questions it answers. Each value is stored under several common phrasings:
    - phone: "phone", "phone number", "mobile"
    - city: "city", "current location"
    - notice period: "notice period", "when can you start", "start date"
    - relocate: "willing to relocate"
    - heard from: "how did you hear about us"
  - `buildFillPlan(jobId: number, fields: FormField[]): Promise<FillPlan>`, where `FillPlan = { fills: Fill[]; action: "submit" | "stop"; status: "applied_pending" | "ready_to_submit" | "needs_you"; reason: string | null }`. It saves `fills` and `filledAt` to the application.
  - `coverLetterPdf(text: string, profile: BaseProfile): Promise<Uint8Array>` is a pdf-lib page in Helvetica 11pt with a name header and wrapped paragraphs.

`buildFillPlan` order:
1. `answerByRule`.
2. The bank for `phone`, `location`, `current_company`, `other` and any rule miss.
3. `cover_text` and `cover_file`: use `tailorings.coverLetter`. If it's null, generate it once with `generateExtras` and save it to `tailorings`.
4. `why_us` and every remaining unanswered field go into ONE `chatJSON` call (model `TOP_MODEL` for top-tier jobs, `MID_MODEL` otherwise, category `tailoring`, estimate 0.004). The prompt:
   - System: "Answer job application questions for Sherif using ONLY these facts. If the facts don't answer a question, return null. For select/radio return one of the given options exactly. `why_us` answers: 2–4 sentences, specific to this company from the listing, no invented experience."
   - Input: profile, bank, job title, company and description (first 4000 chars), and the fields.
   - Output: `{answers: {[id]: string|null}}`.
   - A select or radio answer not among its options counts as null. Non-`why_us` answers are passed to `saveDrafted`.
5. Decision, first match wins:
   - any salary field returned `no_salary` → stop, `needs_you`, "No salary posted"
   - any required field null → stop, `needs_you`, `Unknown required field: {label}` (first one)
   - site is linkedin → stop, `needs_you`, "LinkedIn: review and submit"
   - `sites.autoSubmit` false for the site → stop, `needs_you`, "Auto-submit is off for this site"
   - `trustRemaining > 0` and not approved → stop, `ready_to_submit`, null
   - `dryRun` → stop, `ready_to_submit`, "Dry run"
   - otherwise → submit, `applied_pending`

   When `canSpend` is false, skip the LLM call: drafted fields stay null and fall through to the decision.

- [ ] **Step 1: Write the failing tests** (mock `fetch` for the LLM the way `tests/budget/unreportedUsage.test.ts` does):
  - `no salary posted stops even when everything else is known`.
  - `required field without answer stops`: the model returns null for a required "Security clearance level", giving `needs_you` and a reason naming the field.
  - `linkedin never submits`: a fully answered LinkedIn form gives action `stop`.
  - `trust period holds auto-submit`: with `trustRemaining = 3` and not approved, the result is `ready_to_submit`. When approved and `dryRun = false`, the result is `submit`.
  - `dry run never submits`: with approval and `trustRemaining = 0` but `dryRun = true`, the result is `stop`.
  - `budget out: no LLM call, unknown required field goes to needs_you`: spend is at $9.999, the `fetch` mock is never called, and the status is `needs_you`.
  - `drafted option outside choices is null`.
  - `bank answer used before LLM`: a seeded phone means the LLM is not called for it.
- [ ] **Step 2:** Run `npx vitest run tests/apply/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement bank, plan and coverPdf.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit with `feat(apply): answer bank and fill plan with decision rules`.

### Task 5: Extension API, report handling, kill switch

**Files:**
- Create: `src/app/api/ext/auth.ts`, `src/app/api/ext/next/route.ts`, `src/app/api/ext/plan/route.ts`, `src/app/api/ext/report/route.ts`, `src/app/api/ext/file/[jobId]/[kind]/route.ts`, `src/apply/report.ts`, `tests/apply/report.test.ts`

**Interfaces:**
- Consumes: `nextApplication`, `buildFillPlan`, `coverLetterPdf`, `tailorings.pdfPath`.
- Produces HTTP endpoints. All of them require header `x-jobfinder-token` equal to `settings.extensionToken`; otherwise they return 401. `getExtensionToken()` in `auth.ts` creates the token on first read with `crypto.randomBytes(32).toString("hex")` and saves it.
  - `GET /api/ext/next` → `nextApplication()` plus `{pacing, dryRun}`.
  - `POST /api/ext/plan {jobId, fields}` → `FillPlan`.
  - `GET /api/ext/file/{jobId}/resume|cover` → PDF, named `Sherif_Ashraf_Mohamed_Resume.pdf` or `Sherif_Ashraf_Mohamed_Cover_Letter.pdf`; 404 if missing.
  - `POST /api/ext/report {jobId, outcome, reason?, url?}`. `outcome` is one of `applied|stopped|needs_you|closed|failed|captcha|blocked|login_wall`.
- Produces `applyReport(jobId: number, r: Report, now?: Date): Promise<void>`. Each outcome does the following:
  - `applied`: status `applied`, `appliedAt = now`.
  - `stopped`: status from the saved plan (`ready_to_submit` or `needs_you`) with its reason.
  - `needs_you`: status `needs_you` with the given reason.
  - `closed`: `jobs.closedAt = now`, status `skipped`, reason "Listing closed".
  - `failed`: `attempts++`. Back to `queued` while attempts < 3, otherwise `failed` with the reason.
  - `captcha`: status `needs_you`, reason "Captcha: solve it and submit", plus a `siteEvents` captcha row. If there are ≥3 captcha events for the site in the last hour, also pause the site with the reason "3 captchas in an hour".
  - `blocked`, `login_wall`: status `needs_you`, plus a site event, and the site is paused immediately with the reason "Unusual activity page" or "Logged out".

- [ ] **Step 1: Write the failing tests:**
  - `closed report closes job and skips application`.
  - `third captcha in an hour pauses the site, two do not`.
  - `captchas spread over two hours do not pause`.
  - `blocked pauses immediately`.
  - `failed retries twice then fails`.
- [ ] **Step 2:** Run `npx vitest run tests/apply/report.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `report.ts` and the routes.
- [ ] **Step 4:** Run `npm test`, then check by hand with the dev server running:
  - `curl -s localhost:3100/api/ext/next`. Expected: 401.
  - The same request with the token header. Expected: JSON with `jobId` or `idle`.
- [ ] **Step 5:** Commit with `feat(apply): extension API, reports and kill switch`.

### Task 6: Extension core (dry run on Greenhouse)

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/options.html`, `extension/options.js`, `extension/content/common.js`, `extension/content/greenhouse.js`

**Interfaces:**
- Consumes: the Task 5 endpoints.
- Produces (in `common.js`, attached to `globalThis.JF`):
  - `extractFields(root: Element): FormField[]`. A field's label comes from `<label for>`, `aria-labelledby`, `aria-label`, the fieldset legend, or the nearest preceding label text. Required comes from `required`, `aria-required`, or a `*` in the label. Options come from `<option>` and radio labels. Fields get stable ids, written as `data-jf-id` on the element.
  - `fill(root, fills, pacing): Promise<{ unfilled: string[] }>` sets values through the native value setter and dispatches `input`, `change` and `blur`, so React forms register them. It checks radios and checkboxes by option label. For a file field it fetches `/api/ext/file/...` through the background worker (message `getFile`), builds a `File` and assigns it via `DataTransfer`. It waits a random time in `pacing.fieldMs` between fields.
  - `captchaPresent(): boolean` detects a visible iframe whose src contains `recaptcha`, `hcaptcha` or `turnstile`.
  - `requiredEmpty(root): string[]` returns the labels of required fields that are still empty after filling.
  - Each adapter exports `JF.adapter = { formRoot(): Element | null; openForm(): Promise<void>; isClosed(): boolean; submit(): Promise<void>; confirmed(): boolean }`.
- `background.js`:
  - Every 60s (`chrome.alarms`), while no tab is active, it calls `next`.
  - It opens the URL in a new background tab and waits for load. It injects `common.js` and then the site adapter with `chrome.scripting.executeScript`, and sends `{jobId, mode}`.
  - The content script runs:
    1. `isClosed()` → report `closed`.
    2. `openForm()`, then `extractFields()`, then POST `plan`, then `fill()`.
    3. `captchaPresent()` → report `captcha`, leaving the tab open.
    4. Anything in `requiredEmpty()` → report `needs_you` with "Could not fill: {labels}", leaving the tab open.
    5. Plan action `stop` → report `stopped`, leaving the tab open.
    6. Otherwise `submit()`, then poll `confirmed()` for up to 20s → `applied` and close the tab, or `needs_you` with "No confirmation after submit".
  - It waits a random time in `pacing.betweenAppsSec` before the next `next` call.
  - It keeps at most 8 open "needs you" tabs. Once there are 8, it idles with the badge "8".
- `options.html` has a field to paste the token (stored in `chrome.storage.local`), a Pause toggle and a status line.
- `manifest.json`:
  - `manifest_version: 3`, `permissions: ["storage", "tabs", "scripting", "alarms"]`
  - `host_permissions` covering `http://localhost:3100/*`, `https://*.greenhouse.io/*`, `https://jobs.lever.co/*`, `https://jobs.ashbyhq.com/*`, `https://apply.workable.com/*`, `https://*.workable.com/*` and `https://www.linkedin.com/*`
- Greenhouse adapter:
  - form root: `#application-form`, `form#application_form`, or the job-boards `form`
  - `openForm`: click "Apply" if the form is collapsed
  - `isClosed`: the page says the job is no longer available, or there's a 404
  - `submit`: the submit button inside the form
  - `confirmed`: URL contains `/confirmation` or the text matches `/thank you for applying|application (has been )?(submitted|received)/i`

- [ ] **Step 1:** Write the files above.
- [ ] **Step 2:** Sherif loads `extension/` unpacked in `chrome://extensions` and pastes the token from Sites & caps. Until Task 10 exists, read it with `psql -d jobfinder -Atc "select value from settings where key='extensionToken'"`.
- [ ] **Step 3:** With `dryRun` true, queue one real Greenhouse job (`psql`: set the other queued applications' `site` to paused, or call `/api/ext/next` until it returns that job). Expected:
  - a tab opens, the fields fill at human pace, and the resume uploads
  - no submit click happens
  - the application ends `ready_to_submit` with reason "Dry run", and `fills` is saved
- [ ] **Step 4:** Commit with `feat(extension): core loop, form filler and Greenhouse adapter`.

### Task 7: Lever, Ashby, Workable adapters

**Files:**
- Create: `extension/content/lever.js`, `extension/content/ashby.js`, `extension/content/workable.js`

**Interfaces:** Each file implements the Task 6 adapter contract.
- **Lever:** the form is at `{posting}/apply` (`openForm` navigates there). Submit with `#btn-submit` or `button[type=submit]`. Confirmed when the URL ends `/thanks` or the text says "Application submitted".
- **Ashby:** open the "Application" tab. It uses custom radio and select widgets, so `extractFields` must read `[role=radiogroup]`, `[role=combobox]` and `[role=option]`. If a required widget can't be read, `requiredEmpty` reports it and the job goes to `needs_you`. Confirmed on the text "Thanks for applying" or "Application submitted".
- **Workable:** click "Apply for this job" to open the form. Fields carry `data-ui` attributes. Confirmed on the text "Application submitted" or "Thank you".

- [ ] **Step 1:** Write the three adapters.
- [ ] **Step 2:** Dry-run one real job on each ATS. Expected for each:
  - all standard fields fill and the resume uploads
  - the status is `ready_to_submit` "Dry run", or `needs_you` naming any widget the filler couldn't handle
  - no submit happens
- [ ] **Step 3:** Commit with `feat(extension): Lever, Ashby and Workable adapters`.

### Task 8: LinkedIn fill-only and search collection

**Files:**
- Create: `extension/content/linkedin.js`, `extension/content/linkedin-collect.js`, `src/app/api/ext/listings/route.ts`, `src/app/api/ext/collect/route.ts`

**Interfaces:**
- `linkedin.js` (apply):
  - Click "Easy Apply". For each modal step: extract, plan, fill, then click "Next" or "Review".
  - Stop when the step shows "Submit application". It never clicks it and reports `stopped`; the plan reason is "LinkedIn: review and submit".
  - The file has no code that clicks a submit control.
  - A job without Easy Apply (an external apply link) reports `needs_you` with "Applies on company site", including the external URL as `url`. The server then sets `targetUrl` and `site` with `pickApplyTarget`, and requeues the job if the URL is a supported ATS.
  - Pages matching `/checkpoint|authwall|login/` in the URL, or the text "unusual activity", report `blocked` or `login_wall`.
- `GET /api/ext/collect` → `{ due: boolean; searches: string[] }`.
  - `due` is true when `settings.linkedinCollectedAt` is older than `searchIntervalHours`.
  - The searches are LinkedIn job search URLs, one per role title (AI engineer, founding engineer, full-stack engineer, product engineer, software engineer), with `f_TPR=r86400` and no location filter.
- `linkedin-collect.js`:
  - Scrolls each search's result list (pages 1–2), then opens each card's detail pane.
  - Reads the title, company, location, description text, job id, and whether it's Easy Apply or the external apply URL.
  - Waits 2–6s between cards and stays under 50 cards per run.
- `POST /api/ext/listings {jobs}`:
  - Maps each listing to `NormalizedJob` with `source: "linkedin"`, `externalId` = job id, url `https://www.linkedin.com/jobs/view/{id}/`, `applyUrl` the external URL if present else the view URL, and `inferRemote` and `inferCountry`. Then `upsertJobs`.
  - Harvests board refs from external URLs into `companies` (origin `harvested`), the same as the Phase 1 harvest.
  - Sets `linkedinCollectedAt`.
- Background: when no application is in flight and `collect.due` is true, it runs the collection in one background tab before the next apply.

- [ ] **Step 1:** Write the files above.
- [ ] **Step 2:** Run one collection pass. Expected:
  - dozens of LinkedIn jobs appear in "Found" and get scored on the next cycle
  - no "unusual activity" page appears
- [ ] **Step 3:** Dry-run one Easy Apply job. Expected: the steps fill, it stops at the "Submit application" screen, the status is `needs_you` "LinkedIn: review and submit", and the tab stays open.
- [ ] **Step 4:** Commit with `feat(extension): LinkedIn fill-only apply and search collection`.

### Task 9: Dashboard: statuses, actions, Form answers

**Files:**
- Modify: `src/queries/jobs.ts`, `src/app/page.tsx`, `src/app/components/ui.tsx`, `src/app/globals.css`

**Interfaces:**
- Consumes: `approve`, `refill`, and the `applications` table.
- Produces:
  - The `JobFilters.stage` values `ready`, `needs_you`, `applied`, `interviewing`, `manual`.
  - `stageCounts()` gains those counts.
  - `getApplication(jobId)`.
  - `todayCounts()` returns `{ applied: number; linkedin: number }`.
- UI:
  - **Header:** "Applied today **N** of {globalDaily}", "LinkedIn **N** of 15", and a "Paused" badge when `globalPause` is on or any site is paused.
  - **Pipeline strip:** Found, Scored, Resume tailored, Ready to submit, Needs you (amber), Applied, Interviewing, Apply yourself (`manual`), Filtered out, Scoring failed.
  - **Detail:** an amber alert banner with the reason when the job is `needs_you`. Actions by status:
    - `ready_to_submit` → "Approve and submit"
    - `needs_you` → "Fill again in Chrome" (`refill`) and "I submitted it" (sets status `applied`, `appliedAt` now)
    - `applied` and later → "Interviewing", "Rejected", "Offer" (manual status, spec 6.6)
    - `manual` → "Open listing"
  - **Form answers tab** (shown when `fills` exists): each field's label, value, and a source pill (Profile, Rule, Bank, Drafted, Job). Drafted answers link to the Answer bank.

- [ ] **Step 1:** Implement the UI and queries above.
- [ ] **Step 2:** Run the dev server and open a `ready_to_submit` job from Task 6. Expected:
  - the Form answers tab lists the fields with sources
  - "Approve and submit" changes `trustRemaining` from 10 to 9 and puts the job first in `next` with mode submit (still a dry-run stop while `dryRun` is on)
- [ ] **Step 3:** Commit with `feat(dashboard): apply statuses, actions and form answers`.

### Task 10: Answer bank and Sites & caps pages

**Files:**
- Create: `src/app/answers/page.tsx`, `src/app/sites/page.tsx`
- Modify: `src/app/page.tsx` (header links)

**Interfaces:**
- **Answer bank `/answers`:**
  - A setup form (phone, city, notice period, relocate, how you heard) that calls `seedBank`. It is shown at the top while there are no seed rows.
  - A table of every answer with inline edit (saving sets `source: "edited"` and `isNew: false`) and delete.
  - A "New" filter for `isNew` rows, with the count shown in the header link.
  - Read-only cards that explain the rules: salary rule (with a toggle between `under_mid` and `under_min`), sponsorship, work authorization and EEO.
- **Sites & caps `/sites`:**
  - A row per site: auto-submit toggle (LinkedIn is locked off and labeled "Fill only"), daily cap, paused state with its reason, and Resume.
  - Global pause.
  - Caps: per board, global, per company per 30 days.
  - Pacing.
  - Trust period: "{n} approvals left", plus "Restart trust period" (sets it to 10).
  - Dry run toggle, with the warning "Off means the extension really submits applications."
  - Extension token with copy, and "Regenerate".

- [ ] **Step 1:** Implement the pages.
- [ ] **Step 2:** Run the dev server. Expected:
  - seeding phone and city makes them appear in the bank
  - re-running the Task 6 dry run fills the phone from the bank (pill "Bank")
  - pausing Greenhouse makes `next` skip Greenhouse jobs
- [ ] **Step 3:** Commit with `feat(dashboard): answer bank and sites & caps`.

### Task 11: Docs and first live application

**Files:**
- Modify: `README.md` (Phase 3 section covering extension install, token, dry run, trust period, caps and kill switch), `.env.example` if anything new is added

- [ ] **Step 1:** Write the README section.
- [ ] **Step 2:** Run `npm test` and `npx tsc --noEmit`. Expected: all green.
- [ ] **Step 3:** With Sherif present: he turns dry run off on one job he chooses on an ATS, approves it (trust period), and the extension submits. Expected:
  - status `applied` with `appliedAt`
  - the confirmation page was detected
  - "Applied today 1"
- [ ] **Step 4:** Commit with `docs: Phase 3 setup and safety notes`.
