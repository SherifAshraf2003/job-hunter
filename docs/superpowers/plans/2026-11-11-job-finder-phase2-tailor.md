# Job Finder Phase 2 (Tailor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every open, takeable job scoring at or above the cutoff, produce a tailored one-page resume PDF in Sherif's own LaTeX layout. Each tailored resume is truth-checked against his real experience and comes with a gap report, interview prep, and a cover letter only when the listing asks for one. All of it shows in the dashboard.

**Architecture:** A new `tailorPending()` step runs in the search cycle after scoring. It assigns each eligible job a tier and picks a model from the tier and current budget use. It asks the model for a structured resume whose every bullet points to a source item in the base profile. A truth check verifies the structured resume in code, plus a cheap model check for new claims. The result is rendered into `resume.tex`'s own preamble and macros, compiled with Tectonic, and trimmed until it fits one page. Results live in a `tailorings` table, and files go under `data/out/<jobId>/`.

**Tech Stack:** Existing Phase 1 stack, plus Tectonic (LaTeX engine, Homebrew) and OpenRouter models `anthropic/claude-sonnet-5.5` (top tier, $2/$10 per M) and `anthropic/claude-haiku-5.5` (middle/bottom tier and checks, $0.10/$0.50 per M).

**Spec:** `docs/superpowers/specs/2026-11-11-job-finder-design.md`, sections 2 (anti-goals), 6.3, 7, 8, and 10 item 2. Phase 1 code is on `main`.

**Deferred to Phase 3:** custom answers to a form's open questions ("why us?"), which need the real form, and the answer bank.

## Global Constraints

- **Never invent experience** (spec anti-goal). No new employers, titles, dates, numbers, or skills that aren't in the base profile. Reframing and reordering are allowed.
- **Cover letters are not written by default.** Write one only when the listing asks for one (description matches `/cover letter/i`). Otherwise `coverLetter` is null.
- Tailored resume = exactly **one page**, same preamble/macros/sections as `resume.tex`, Helvetica-style font. Contact header copied verbatim from the base profile.
- Budget: tailoring is category `tailoring` and may use the whole $10 monthly cap minus what's spent (scoring's 50% share is a ceiling for scoring only). Degradation by **month-to-date total spend ÷ cap**: <70% normal; ≥70% the top tier uses the middle model; ≥90% everything gets the bottom treatment; when `canSpend` refuses, tailoring stops and resumes next cycle.
- Eligible jobs: `status='scored'`, `closedAt is null`, `canTake <> 'not_possible'`, composite ≥ `cutoff` (default 60), no `tailorings` row yet.
- Tiers (my call, editable in Settings): **top** = composite ≥ 80, max **5 per day**, best first; **middle** = composite ≥ 70, plus any top-eligible jobs over the daily limit; **bottom** = the rest down to the cutoff.
- Models via env: `OPENROUTER_TOP_MODEL=anthropic/claude-sonnet-5.5`, `OPENROUTER_MID_MODEL=anthropic/claude-haiku-5.5`. Free models are **never** used for tailoring, because the resume is personal data (spec, Phase 1 decision).
- Testing policy (Sherif): automated tests only for budget behavior **and the truth check** (Sherif approved the truth-check test). Everything else is checked by running it.
- Generated files go under `data/out/` (git-ignored).

## Review Focus

1. **The tailored resume overflows one page.** Drop the lowest-priority bullet (the last project first, then the last bullet of the longest role) and recompile, up to 8 times. If it still overflows, save with `error: "does not fit one page"` and no PDF. Check: Task 4, step 2.
2. **The model invents a number, employer, or skill, or rewrites a date.** The truth check replaces that bullet with the base bullet and records the issue, so the final resume contains only base facts. Check: Task 3, step 2.
3. **LaTeX special characters in content** (`%`, `&`, `$`, `#`, `_`, `C++`, quotes). They are escaped and the PDF compiles. Check: Task 4, step 2.
4. **Spend crosses 70% or 90% mid-cycle.** The next job's model and tier change accordingly, and spend never passes the cap. Test: Task 2 (budget tests).
5. **Tectonic is missing or the compile fails.** The tailoring row is saved with the error and no PDF, the cycle continues, and the dashboard shows the error. Check: Task 4, step 2.

---

## File Structure

```
src/tailor/types.ts         TailoredResume, Tier, TailoringResult
src/tailor/tiers.ts         assignTiers(), pickTreatment()
src/tailor/generate.ts      generateResume(), generateExtras() (gap report, prep, cover letter)
src/tailor/truth.ts         truthCheck()
tests/truth/truthCheck.test.ts
src/tailor/latex.ts         renderTex(), compilePdf(), fitOnePage()
src/tailor/diff.ts          diffAgainstBase()
src/tailor/tailorJobs.ts    tailorPending()
src/db/schema.ts            + tailorings table
src/pipeline/cycle.ts       + tailoring step
src/app/api/pdf/[jobId]/route.ts   serves the PDF
src/app/page.tsx, components/      + Tailored stage, detail tabs
src/app/settings/page.tsx   + tier thresholds and top-tier daily limit
tests/budget/tailor.test.ts
scripts/tailor-one.ts       check script
```

---

### Task 1: Setup, schema, types

**Files:** Modify `src/db/schema.ts`, `src/config.ts`, `.env.example`, `.gitignore`. Create `src/tailor/types.ts`.

**Interfaces:**
- Produces:
```ts
type Tier = "top" | "middle" | "bottom";
type SourceRef = string; // "r{roleIdx}b{bulletIdx}" | "p{projectIdx}"
type TailoredResume = {
  headline: string;                                      // must be base headline or a reframing approved by truthCheck
  roles: { roleIdx: number; bullets: { text: string; source: SourceRef }[] }[];  // title/org/dates copied from base by code
  projects: { source: SourceRef; text: string }[];
  skills: { category: string; items: string[] }[];
  includeQuote: boolean;
};
type TruthIssue = { where: string; problem: string; action: "reverted" | "dropped" };
type TailoringResult = { tier: Tier; model: string; resume: TailoredResume; issues: TruthIssue[]; coverLetter: string | null; gapReport: { requirement: string; importance: "core" | "nice"; suggestion: string }[]; prep: { question: string; why: string }[]; usd: number };
```
- Table `tailorings`: jobId pk/fk, tier, model, resume jsonb, issues jsonb, diff jsonb, coverLetter text null, gapReport jsonb, prep jsonb, pdfPath text null, error text null, usd numeric, createdAt.
- `config` adds `tiers: { top: 80, middle: 70, topPerDay: 5 }`.
- `.env.example` adds `OPENROUTER_TOP_MODEL=anthropic/claude-sonnet-5.5`, `OPENROUTER_MID_MODEL=anthropic/claude-haiku-5.5`. `.gitignore` adds `data/out/`.

- [ ] **Step 1:** `brew install tectonic`, then compile the base resume: `tectonic -X compile resume.tex --outdir .superpowers/tmp`. Expected: a 1-page PDF; the first run downloads packages.
- [ ] **Step 2:** Implement the schema/config/types; `npm run db:generate && npm run db:migrate`. Check: `psql jobfinder -c '\d tailorings'` lists the columns.
- [ ] **Step 3:** Commit `feat: tailoring schema and setup`.

---

### Task 2: Tiers and budget-aware treatment (budget tests)

**Files:** Create `src/tailor/tiers.ts`, `tests/budget/tailor.test.ts`.

**Interfaces:**
```ts
type Treatment = { tier: Tier; resumeModel: string | null; extrasModel: string; rewrite: "full" | "reorder" | "keywords" };
assignTiers(jobs: { id: number; composite: number }[], cfg: Config, topUsedToday: number): Map<number, Tier>
pickTreatment(tier: Tier, monthSpendRatio: number): Treatment
```
- `assignTiers`: sorted by composite desc. Composite ≥ top, until `topPerDay - topUsedToday` are used, → top; other ≥ top and ≥ middle → middle; the rest → bottom.
- `pickTreatment`:
  - ratio < 0.7: top → `{resumeModel: TOP, extrasModel: MID, rewrite: "full"}`; middle → `{MID, MID, "reorder"}`; bottom → `{MID, MID, "keywords"}`.
  - 0.7 ≤ ratio < 0.9: top gets the middle treatment (keeping `tier: "top"`).
  - ratio ≥ 0.9: every tier gets the bottom treatment.

- [ ] **Step 1: Failing tests:**
  - `pickTreatment("top", 0.5).resumeModel === TOP`; `pickTreatment("top", 0.75).resumeModel === MID` and `.rewrite === "reorder"`; `pickTreatment("middle", 0.95).rewrite === "keywords"`.
  - `assignTiers` with composites [95, 90, 85, 82, 81, 80, 75, 65], `topUsedToday=2` → exactly 3 top (95, 90, 85), and 82/81/80/75 middle, 65 bottom.
  - `tailorPending stops when budget would be exceeded`: with $9.99 of tailoring spend recorded this month and a fake generator, 0 jobs are tailored, no `tailorings` rows are written, and `stoppedForBudget` is true. (This needs Task 5's `tailorPending`; write it now and expect it to fail until Task 5.)
- [ ] **Step 2:** `npx vitest run tests/budget` → the new tests FAIL. Implement `tiers.ts` → the tier/treatment tests PASS (the `tailorPending` test stays red until Task 5).
- [ ] **Step 3:** Commit `feat: tailoring tiers and budget-aware treatment`.

---

### Task 3: Generation and truth check

**Files:** Create `src/tailor/generate.ts`, `src/tailor/truth.ts`, `scripts/tailor-one.ts`. Test `tests/truth/truthCheck.test.ts`.

**Interfaces:**
```ts
generateResume(job: JobRow, profile: BaseProfile, t: Treatment): Promise<TailoredResume>
generateExtras(job: JobRow, profile: BaseProfile, t: Treatment, wantsCoverLetter: boolean): Promise<Pick<TailoringResult, "gapReport" | "prep" | "coverLetter">>
truthCheck(r: TailoredResume, profile: BaseProfile, model: string, claimCheck?: (r: TailoredResume, p: BaseProfile) => Promise<SourceRef[]>): Promise<{ resume: TailoredResume; issues: TruthIssue[] }>  // claimCheck defaults to the cheap-model check; injectable for tests
```
- `generateResume` calls `chatJSON` (category `tailoring`). The prompt gives the base profile with stable source ids (`r0b0`, …, `p0`), the job, and the rewrite mode:
  - `full`: rephrase to the job's vocabulary, choose and order bullets, set the headline, order the skills.
  - `reorder`: reorder only, plus light keyword rephrasing.
  - `keywords`: the base bullets unchanged; only the headline and skill order may change.

  The prompt states the hard rules from Global Constraints. `estimateUsd`: 0.05 for the top model, 0.003 for the mid model. When `resumeModel` is null, the base resume is used unchanged.
- `generateExtras`: one `chatJSON` with `extrasModel` (estimate 0.003) returning the gap report (max 6 items, each with a 1–2 day side-project suggestion when `importance` is core) and the prep (max 6 questions, from what this resume emphasizes). Cover letter: only when `wantsCoverLetter`, under 220 words, using only facts from the profile.
- `truthCheck`, in code:
  - every `source` must exist in the base;
  - every number in a bullet must appear in its source text;
  - no employer/org name other than the source's own may appear;
  - every skill item must exist in the base skills (case-insensitive) or be one of the source bullets' explicit technologies;
  - the headline must not claim a title the candidate never held (only words from base titles/headline plus job-domain words like "AI", "Full-Stack", "Product", "Founding").

  Failures are reverted to the base text, or dropped (skills). Then one cheap `chatJSON` (mid model, estimate 0.002) asks "list any claim in these bullets not supported by their source text", and each flagged bullet is reverted.

- [ ] **Step 1: Failing truth-check tests** (`tests/truth/truthCheck.test.ts`, base profile parsed from the real `resume.tex`, the cheap-model claim check stubbed to return no flags):
  - `reverts a bullet with an invented number`: bullet `{source:"r0b5", text:"Reduced AWS costs by 60%..."}` → text equals the base `r0b5` bullet, and the issue `action: "reverted"`.
  - `reverts a bullet naming another employer`: `"Built voice agents at Google..."` (source `r0b1`) → reverted.
  - `drops an unknown source`: source `r9b9` → the bullet is removed, issue `dropped`.
  - `drops a skill not in the base`: skills `[{category:"AI", items:["LLMs","Kubernetes"]}]` → `Kubernetes` dropped, `LLMs` kept.
  - `keeps a faithful rephrase`: `"Shipped a real-time Twilio AI voice agent serving concurrent users with no voice-quality loss"` (source `r0b1`) → unchanged, no issues.
  - `reverts a bullet the claim check flags`: stub returns `["r0b0"]` → `r0b0` reverted.

  Run `npx vitest run tests/truth` → FAIL.
- [ ] **Step 1b:** Implement. `npx vitest run tests/truth` → PASS.
- [ ] **Step 2: Check** with `npx tsx scripts/tailor-one.ts <jobId> [--tier top|middle|bottom] [--inject-fake]` on 3 real scored jobs (one AI role, one full-stack role, one in Egypt). It prints the tailored bullets next to their sources, the issues, the gap report, the prep, and the cover letter or "none". Expected:
  - the bullets read as tailored to each job;
  - no new numbers or orgs;
  - `--inject-fake` appends a bullet "Led a team of 40 engineers at Google" (source `r0b0`) and the issue list shows it `reverted`;
  - jobs without "cover letter" in the description print "none".
- [ ] **Step 3:** Commit `feat: resume generation with truth check`.

---

### Task 4: LaTeX rendering and one-page fit

**Files:** Create `src/tailor/latex.ts`, `src/tailor/diff.ts`.

**Interfaces:**
```ts
latexEscape(s: string): string                         // \ & % $ # _ { } ~ ^ and straight quotes → LaTeX-safe
renderTex(r: TailoredResume, p: BaseProfile, baseTex: string): string   // baseTex preamble (up to \begin{document}) + generated body, same section order as resume.tex: header, Experience (\role{title}{org}{dates} + itemize), quote after role 0 if includeQuote, Projects, Skills, Education, Awards
compilePdf(tex: string, outDir: string): Promise<{ pdfPath: string; pages: number }>   // tectonic -X compile; pages = count of /Type /Page (not /Pages) in the PDF bytes
fitOnePage(r: TailoredResume, p: BaseProfile, baseTex: string, outDir: string): Promise<{ resume: TailoredResume; pdfPath: string }>  // trims up to 8 times, then throws Error("does not fit one page")
diffAgainstBase(r: TailoredResume, p: BaseProfile): { section: string; base: string | null; tailored: string | null; kind: "changed" | "moved" | "dropped" | "same" }[]
```
- The header, education, and awards come straight from the base profile. Education and awards are never trimmed.
- The trim order: drop the last project, then the last bullet of whichever role has the most bullets (never below 2 bullets per role), then drop the quote.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check** with `scripts/tailor-one.ts <id> --pdf`:
  - The PDF opens, is 1 page, and visually matches `resume.pdf`'s layout (compare side by side).
  - A forced bullet containing `100% & $5k #1 C++ R&D_team "quoted"` compiles, and the text appears correctly.
  - An oversized resume (inject 12 extra bullets) gets trimmed to 1 page.
  - With `PATH` lacking tectonic, the result is a saved error, not a crash.
- [ ] **Step 3:** Commit `feat: render tailored resume to one-page PDF`.

---

### Task 5: tailorPending in the cycle

**Files:** Create `src/tailor/tailorJobs.ts`. Modify `src/pipeline/cycle.ts` (after scoring), `src/worker/index.ts` log line.

**Interfaces:**
```ts
tailorPending(opts?: { limit?: number; generator?: { resume: typeof generateResume; extras: typeof generateExtras } }): Promise<{ tailored: number; failed: number; stoppedForBudget: boolean; byTier: Record<Tier, number> }>
```
- Flow per eligible job (best composite first): tier → `pickTreatment(tier, monthUsd/cap)` (recomputed before every job) → generateResume → truthCheck → fitOnePage → generateExtras → diff → insert the `tailorings` row with summed `usd` (sum of spend rows created during this job).
- `BudgetExceededError` anywhere → stop, without a row for that job.
- Any other error → insert a row with `error` and continue. After 3 consecutive errors, stop (same rule as scoring).
- `CycleStats` gains `tailored`, and errors are appended as in Phase 1.

- [ ] **Step 1:** Implement. `npx vitest run tests/budget` → all PASS, including Task 2's `tailorPending stops when budget would be exceeded`.
- [ ] **Step 2: Check:** `MAX_BOARDS=0 npm run worker -- --once` against real data. The log shows `tailored N (top a, middle b, bottom c)` with a ≤ 5, `data/out/<id>/resume.pdf` exists for the tailored jobs, and month spend is still < $10.
- [ ] **Step 3:** Commit `feat: tailor jobs in the search cycle`.

---

### Task 6: Dashboard

**Files:** Modify `src/queries/jobs.ts`, `src/app/page.tsx`, `src/app/components/ui.tsx`, `src/app/globals.css`, `src/app/settings/page.tsx`. Create `src/app/api/pdf/[jobId]/route.ts`.

**Interfaces:**
- `getTailoring(jobId): Promise<typeof tailorings.$inferSelect | null>`; `gapCounts(): Promise<Map<string, number>>` (normalized requirement → number of tailored jobs listing it); `stageCounts()` adds `tailored`.
- `GET /api/pdf/[jobId]` streams `data/out/<jobId>/resume.pdf` (404 if missing), `Content-Disposition: inline; filename="Sherif-Ashraf-Mohamed-<company>.pdf"`.

UI (Graphite tokens, matching the approved mockup's detail panel):
- **Stage strip:** a **Tailored** stage after Scored.
- **Detail panel tabs:** **Resume**, **Cover letter**, **Gaps**, **Interview prep**, **Description**.
  - Resume: the PDF in an `<iframe>`, a **Download PDF** button, a **Show changes** toggle listing diff rows (changed bullets highlighted mint, moved marked "moved up", dropped greyed), and truth-check issues listed under "Reverted to your original wording".
  - Cover letter: the text with a Copy button, or "This listing doesn't ask for a cover letter."
  - Gaps: each item with "Asked in N jobs" from `gapCounts`, the importance pill, and the suggestion.
  - Each tab appears only when it has content, except Resume, which shows the error text if tailoring failed.
- **Re-tailor** button deletes the tailoring row and its folder; the next search redoes it.
- **Settings:** top threshold, middle threshold, top-tier jobs per day.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Check** in the browser: open a top-tier job, a middle one, and one with an error. The PDF renders inline, changes are highlighted, the Gaps tab shows counts, Cover letter shows the right empty state, Download gives a nicely named file, and Re-tailor clears it.
- [ ] **Step 3:** Commit `feat: tailoring in the dashboard`.

---

### Task 7: Live run and README

- [ ] **Step 1:** Run `npm run worker -- --once` with real data. Then read 3 tailored PDFs (one per tier) side by side with `resume.pdf` and the job listing. Confirm the tailoring is visibly job-specific for top, lighter for middle, and minimal for bottom, with no invented facts. Record the spend per tier in the README.
- [ ] **Step 1b: Model comparison for the top tier.** Add `--model <id>` to `scripts/tailor-one.ts`. On the highest-ranked takeable job, render the full-rewrite resume with `anthropic/claude-sonnet-5.5`, `google/gemini-3-flash-preview`, and `anthropic/claude-haiku-5.5` to `.superpowers/tmp/compare/<model>.pdf`. Show Sherif the three PDFs side by side, each with its cost and truth-check issue count, and set `OPENROUTER_TOP_MODEL` to the one he picks.
- [ ] **Step 2:** README: Phase 2 section (tiers, models, cover-letter rule, truth check, Tectonic install, Re-tailor).
- [ ] **Step 3:** Commit `docs: phase 2 tailoring`.
