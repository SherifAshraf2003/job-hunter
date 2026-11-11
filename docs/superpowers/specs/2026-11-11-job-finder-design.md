# Job Finder — Design

Date: 2026-11-11
Owner: Sherif Ashraf Mohamed
Status: Draft for approval (builder check and self-review done)

## 1. Intent

A personal job-hunting agent for one person: Sherif, a full-stack AI engineer / founding engineer based in Egypt. Sherif feeds it his resume once. It then finds software jobs across as many sources as possible, ranks them best to worst, tailors his resume (and cover letter and form answers) for each one, and applies through his own Chrome browser.

**Why:** the three most time-consuming parts of his job search are finding jobs, filling in application forms, and tailoring the resume. He wants the highest chance of landing a good job, which means going wide across every source while staying safe (no banned accounts, no lies on the resume).

**Success:** more interviews at good companies, for much less of Sherif's time. The first milestone is that the app is clearly useful within its first week or two of use: real, well-ranked jobs appear, tailored resumes look good, and applications go out.

## 2. Goals, non-goals, anti-goals

### Goals
- Find software jobs matching Sherif's profile from many sources: AI engineer, founding engineer, full-stack, product engineer, software engineer.
- Rank them with **job quality weighted more than fit**, but with fit still counting.
- Tailor resume, cover letter, and form answers per job, at a quality tier that depends on rank.
- Apply in Sherif's real Chrome via an extension: auto-submit on most sites, fill-only on LinkedIn.
- Show everything in a local dashboard: every job, filters, status, the tailored resume per job, and what's waiting on Sherif.
- Stay within an LLM budget of **$10/month**.

### Non-goals (v1)
- Hosting or cloud deployment. It runs locally on Sherif's Mac.
- Multi-user support or accounts.
- Reading Gmail for replies and interview invites (later phase; v1 tracks status by hand).
- Mobile UI.

### Anti-goals (a failure even if it technically works)
- **Inventing experience.** The tool never fabricates jobs, titles, employers, dates, metrics, or skills that aren't in the base resume. It may reframe, reorder, rename to the job's vocabulary, and emphasize adjacent truths (e.g. "Postgres" shown as "relational databases"). Sherif asked for small fabrications and was declined; the gap report and side-project suggestions (section 6.3) are the agreed alternative.
- **Getting Sherif's accounts banned or flagged.** Safety rules (caps, pacing, kill switch) beat volume.
- **Auto-submitting on LinkedIn.**
- **Silently blowing the budget.**
- **Spraying applications at jobs he can't take** (e.g. US on-site with no sponsorship) as if they were good matches.

## 3. Profile facts the system relies on

Source of truth is `resume.tex` in the project root (compiles to the one-page `resume.pdf`). Key facts:
- Founding Engineer, Dialbird (Feb–Oct 2026): real-time AI voice agent over Twilio, AWS (ECS, EC2, VPC, load balancers), Redis job queues, integrations (HubSpot, GoHighLevel, Slack), cut AWS costs about 30%.
- Founding Engineer and COO, PlawLabs (Apr 2025–Jan 2026): Vulnzap (frontend, VS Code extension, MCP tool), Brief (AI summarizer).
- Freelance on Upwork (Aug 2025–present), Orange Egypt NOC intern (2024).
- Projects: LeadMate (co-founder, AI lead-gen SaaS), Manasetak, AI Study Assistant (RAG).
- Stack: TypeScript, Next.js, React, Node.js, Python, LangChain, Postgres, Redis, Supabase, AWS.
- B.E. Computer Engineering, EUI, graduating Jun 2026.
- Located in Egypt; Egyptian citizen.

The resume is parsed once into a structured **base profile** (JSON in Postgres). Every tailored output is generated only from this profile. Sherif can edit the profile in the dashboard.

## 4. Decisions made with Sherif

| Topic | Decision |
|---|---|
| Location | Doesn't matter for search. Feasibility (visa/remote) affects ranking (see 6.2). **Jobs in Egypt are explicitly in scope** (no visa needed; Sherif asked for them). |
| Ranking weights | Job quality more than fit; fit still matters. |
| Stack | TypeScript / Node, Next.js dashboard, **Postgres**, runs locally on his Mac. |
| LLM | **OpenRouter** API key for generation. **Jev (TypeSafe)** for scoring listings. |
| Applying | Through a **Chrome extension** in his real browser, using his logged-in sessions. |
| Auto-submit | **Yes on all sites except LinkedIn.** LinkedIn is fill-only; Sherif clicks Submit. Per-site toggle in the dashboard. |
| Volume | "As many as possible, go wide but safe." |
| Salary answer | 10% under the posted salary. If a range is posted, 10% under the midpoint (my call; Sherif can switch to "under the bottom"). |
| No salary posted | Only matters when the **form asks for expected salary**. If it asks and the listing posts no salary: don't submit; draft everything and put it in "Needs you". If the form doesn't ask, submit normally. |
| Sponsorship | Jobs in Egypt: "No sponsorship needed." US jobs: "Yes, I need sponsorship." Same for on-site/hybrid jobs in other countries (UK, EU, Canada, Gulf) — my call, based on Egyptian citizenship. Remote roles worked as a contractor from Egypt: "No sponsorship needed." |
| Budget | **$10/month** on LLM calls, hard cap. |
| Trust period | The **first 10 applications** that would auto-submit wait in a "Ready to submit" state for Sherif's one-click approval. After 10 approvals, auto-submit turns on (re-enable the trust period from Settings at any time). |
| Resume source | **`resume.tex`** (LaTeX, project root) is the layout source of truth; `resume.pdf` is its compiled output. |
| Dashboard look | **Graphite theme, Geist font** (from the approved mockup; see 8). |

## 5. Architecture

Two pieces, both on Sherif's Mac:

1. **Local app** — Next.js (App Router, TypeScript) + Postgres. Holds the dashboard, the database, the API the extension talks to, and a scheduler/worker that runs search → rank → tailor.
2. **Chrome extension** (Manifest V3) — talks to the local app over `http://localhost`. Two jobs:
   - **Collect** listings from login-walled or bot-protected sites (see 6.1 for the list) using his browser session, and post them to the local app.
   - **Apply**: work through the apply queue, open each job, fill the form, upload files, and submit (or stop before submit on LinkedIn).

The extension authenticates to the local app with a shared secret generated on first run (shown in the dashboard, pasted into the extension once). API keys (OpenRouter, TypeSafe) live in a local `.env`, never in the extension.

The worker process is part of the local app (e.g. a Node worker with a Postgres-backed job queue such as pg-boss or graphile-worker — builder's choice). It must keep working through a laptop sleep/wake without corrupting state.

Not installed on the machine yet: Postgres and a LaTeX engine (Node v25 is present). Setup must cover both.

## 6. Pipeline

### 6.1 Search
- Runs every few hours (default every 4 hours; configurable).
- **Public APIs and feeds, fetched directly by the worker** (no login, verified responding on 2026-11-11):
  - Greenhouse `boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true`
  - Lever `api.lever.co/v0/postings/{company}?mode=json`
  - Ashby `api.ashbyhq.com/posting-api/job-board/{company}?includeCompensation=true` (often includes salary)
  - Workable `apply.workable.com/api/v1/widget/accounts/{company}` (common among Egyptian and MENA companies)
  - Hacker News "Who is hiring?" monthly thread via the Algolia HN API. Posts are free text, so a cheap model extracts company, role, location/remote/visa, and link.
  - RemoteOK (JSON API), We Work Remotely (RSS), and similar boards with feeds.
- **Company discovery** (the per-company APIs need a board name; there is no master list). The app keeps a growing `companies` table:
  - It harvests board names from every apply URL it sees on any source (LinkedIn, HN, RemoteOK, Wuzzuf, etc.) that points to Greenhouse/Lever/Ashby/Workable.
  - It seeds from the YC company directory, public GitHub lists of startup career pages, and a hand-seeded list of Egyptian tech companies.
  - Every known company's board is polled each run.
- **Login-walled or bot-protected sources, collected by the extension** (Phase 3+): LinkedIn, Indeed, Glassdoor, Wellfound, YC Work at a Startup, and the Egyptian boards **Wuzzuf** and **Bayt** (both return 403 to plain HTTP fetches). The extension runs saved searches in a background tab at human pace, extracts listings, and posts them to the local app. Same caps/pacing rules as applying.
- **Normalize:** every listing is mapped to one common schema (title, company, location, remote policy, salary + currency, description, apply URL, source links) before dedupe.
- Search queries: role titles from section 2, no location filter.
- **Dedupe** across sources: same company + normalized title (+ similar description) = one job. Keep all source links. When applying, prefer the company's own ATS (Greenhouse/Lever/Ashby/Workable/company site) over LinkedIn/Indeed.
- **Still open?** Right before applying, re-check the listing; closed jobs are marked Skipped (closed).
- **Pre-filter in code** before any paid call: obvious non-matches (non-software roles, intern roles, 10+ years required, staff/principal titles) are dropped cheaply.

### 6.2 Rank
- Every job that passes the pre-filter is scored on the dimensions below. Primary engine: **Jev** (TypeSafe System One), one question per dimension, all asked in parallel over the same job + base-profile state:
  - **Role scope** — how much AI / founding / full-stack product work it involves.
  - **Company** — strength and quality of the company (stage, funding, reputation signals in the listing).
  - **Pay** — posted pay relative to **the job's own local market** (my call: a strong Cairo salary scores well against Cairo, not against US remote pay; otherwise Egyptian jobs would never clear the cutoff). Neutral-low if not posted. The dashboard also shows salary converted to USD for comparison.
  - **Level match** — seniority fits Sherif (about 2 years experience, two founding roles).
  - **Fit** — how well his real experience matches the requirements.
  - **Can take it** (Noul/Choice) — in Egypt (no visa needed), remote-from-Egypt OK, sponsors visa, unclear, or not possible.
- **Composite score in code:** weighted sum, quality dimensions weighted more than fit. Default weights: scope 0.26, company 0.20, pay 0.16, level 0.10, fit 0.28. Weights editable in the dashboard; changing them re-ranks without re-scoring.
- **Feasibility:** "not possible" jobs are pushed to the bottom and not applied to by default. They stay visible. "Unclear" gets a small penalty.
- **Engine decided:** Jev for every pre-filtered job. Sherif supplied the price: $0.042 per million input tokens, about $0.00015 per job, so the $5 scoring share covers about 30,000 jobs a month. No OpenRouter scoring fallback is needed. Scores are stored per dimension.

### 6.3 Tailor
Applies to jobs above the **score cutoff** (default 60; set in the dashboard). Tier by rank:

| Tier | Who | What it gets | Model |
|---|---|---|---|
| Top | Top-ranked jobs, limited per day by budget | Full resume rewrite, custom answers to open questions ("why us?"), cover letter only when needed (see below) | Premium model (Claude-class) via OpenRouter |
| Middle | Above cutoff, not top | Bullet reordering + rephrasing to the job's keywords, cover letter only when needed | Cheap model |
| Bottom | Near the cutoff | Base resume + keyword pass in the skills/summary lines | Cheapest model, or none |

Rules for all tiers:
- **Cover letters are not written by default** (Sherif: not every job needs one). One is written only when the listing asks for one, or (Phase 3) when the application form has a cover letter field. Otherwise the field is left empty.
- Output is a **structured resume** (JSON matching the base profile schema). Code renders it into a `.tex` file built from `resume.tex` (same preamble, `\role` macro, and sections), with LaTeX special characters escaped, then compiles it to PDF. The result must stay **one page**: if it overflows, trim the lowest-priority bullets and recompile. A LaTeX engine has to be installed locally; none is installed now (builder's choice, e.g. Tectonic or MacTeX via Homebrew). The base profile is parsed from `resume.tex`, which is more reliable than the PDF.
- A **truth check** runs on every tailored resume: each bullet must trace back to a base-profile item. Code checks that no new employers, titles, dates, or numbers appear. A cheap model checks for new skill or achievement claims. Failures are regenerated or fall back to the base bullet.
- Store a diff against the base resume (shown highlighted in the dashboard).
- Also produce per job: **gap report** (requirements not shown on the resume, how often they appear across jobs, and a suggested 1–2 day side project to close them) and **interview prep** (likely questions from what the resume emphasized, company notes from the listing).

### 6.4 Answer bank
- Stored answers to common form questions: contact info, links, work authorization, sponsorship, salary rule, years of experience, start date, relocation, EEO questions (decline to answer by default), etc.
- Seeded on first run from the resume plus a short setup form.
- New questions: the LLM drafts an answer from the profile, applies it, and saves it to the bank flagged "new." Sherif can review and edit it in the dashboard.
- Salary and sponsorship are **rules**, not fixed text (see section 4). Salary is answered in the listing's own currency and period (e.g. monthly EGP for Cairo, annual USD for the US).
- **Work authorization** is answered separately from sponsorship: authorized to work in Egypt only. "Are you authorized to work in the US/UK/...?" → No.

### 6.5 Apply
- The extension pulls the next job from the apply queue, opens it in a Chrome tab, fills every field, uploads the tailored resume PDF (and cover letter), and then:
  - **Auto-submit sites** (everything except LinkedIn): submits, detects the confirmation page, and reports "applied."
  - **LinkedIn:** fills everything, stops before submit, and marks the job "Needs you: LinkedIn submit."
  - **Form asks for expected salary and the listing posts none:** fills everything else, does not submit, and marks the job "Needs you: no salary." If the form doesn't ask for salary, the job is submitted normally.
  - **Trust period:** while it's on (the first 10 auto-submit applications), the extension fills everything and the job waits in "Ready to submit". Sherif reviews it in the dashboard and approves with one click, and the extension then submits.
- **Safety guardrails:**
  - Daily caps (my call). LinkedIn 15 and Indeed 20 per platform. ATS platforms (Greenhouse, Lever, Ashby, Workable) are capped **per company board** (default 3 per company per day) plus a global daily total (default 60), because each company board is separate and per-platform caps would strangle volume. All caps are editable.
  - **Per-company limit (my call):** at most 2 applications to the same company within 30 days, choosing its best-scoring roles, so recruiters don't see a spray of applications from one person.
  - Random human-like delays between fields and between applications; no parallel tabs per site.
  - Captcha on a single application form (common on Greenhouse/Lever/Ashby): that one job goes to "Needs you" with everything filled. Sherif solves the captcha and clicks Submit. The site is **not** paused (my call).
  - Kill switch per platform: an "unusual activity" page, account warning, login wall, or repeated captchas (3+ in an hour on the same platform) pause that platform and alert Sherif in the dashboard.
  - Global pause button.
- Forms the extension can't confidently fill (unknown required fields, multi-page flows that break) go to "Needs you" with what's filled so far. They are never submitted half-filled.
- **v1 site coverage for applying:** Greenhouse, Lever, Ashby, Workable, LinkedIn (fill-only). Workday, Indeed, and arbitrary company sites come later (see section 10).

### 6.6 Track
- Statuses: Found → Scored → Tailored (queued) → Ready to submit (trust period only) / Needs you → Applied → Interviewing → Rejected/Offer, plus Skipped (with reason).
- Sherif moves jobs to Interviewing/Rejected/Offer by hand in v1.

## 7. Budget control ($10/month)
- Every LLM/Jev call is metered (tokens and cost from OpenRouter's response; Jev from its pricing) and stored.
- **Hard cap:** the worker never starts a paid call that would push the month over $10.
- **Graceful degradation as spend rises:** above about 70% of the budget, top tier drops to the middle-tier model; above about 90%, tailoring drops to the bottom tier; at 100%, scoring falls back to code-only heuristics and tailoring stops. Finding and listing jobs never stops.
- Dashboard shows today's spend and month-to-date against the cap.
- **Split (my call):** at least 50% of the monthly budget is reserved for tailoring; scoring can't eat into it. Scoring (including the cheap model that extracts jobs from HN posts) is also capped per day at about 1/30 of the scoring share. See 6.2 for the engine.
- Builder picks concrete models after checking current OpenRouter prices. The allocation should give scoring for every job that passes the pre-filter, plus a few dozen top-tier tailorings and a few hundred cheap ones per month.

## 8. Dashboard

Matches the approved mockup (`.superpowers/brainstorm/79783-1794396116/content/dashboard-themes.html`, Graphite skin):

- **Theme:** Graphite — bg `#14161B`, surface `#1B1E25`, sunk `#242833`, ink `#E8EAF0`, muted `#8C93A3`, line `#2B303B`; signal amber `#F5B544` for "Needs you"; score dimension colors violet ramp `#A79BFF / #8676F2 / #6556CC / #463C93` for quality and mint `#4CC9A6` for fit. Font: **Geist** throughout; the resume preview uses the PDF's own font (Helvetica-style sans), not Geist.
- **Header:** run status (last search, sources), applied today vs. cap, LinkedIn count vs. cap, LLM spend today/month.
- **Pipeline strip:** counts per stage (Found, Tailored, Needs you, Applied, Interviewing); clicking one filters the list.
- **Ranked list:** rank, title, company + location, composite score with a stacked bar showing each dimension's weighted contribution, salary, visa feasibility, status. Filter chips: can take it, salary posted, score threshold, AI roles, founding, remote, source.
- **Job detail panel:** title, facts (score, salary, visa, sources), "why it ranks here" per-dimension bars, alert banner when it needs Sherif, actions (Open in Chrome, Download PDF, View listing, Skip job), and tabs: Resume (rendered, changes highlighted), Cover letter, Form answers (with source: rule / bank / newly drafted), Gaps, Interview prep.
- **Other screens:** Answer bank (view/edit), Sites & caps (per-site auto-submit toggle, caps, pause), Settings (weights, cutoff, search interval, budget, base profile editor).

## 9. What's left to the builder
- Exact libraries: ORM, queue, PDF rendering, scraping/parsing approach per source.
- Extension internals and DOM strategies per ATS.
- Concrete OpenRouter models per tier, within budget.
- Jev question wording, criteria, and whether to use Score vs. Choice per dimension (read the TypeSafe docs first).
- Database schema.
- Seed list of companies for ATS polling.

## 10. Phasing

Sherif wants to confirm the app is useful before investing more. Build in this order, with each phase usable on its own:

1. **Phase 1 — Find and rank:** setup (Postgres), base profile parsed from `resume.tex` (scoring needs it for fit), public sources + company discovery + pre-filter + scoring, budget metering and hard cap (scoring already costs money), dashboard list and detail panel (no tailoring yet). Useful immediately as a ranked job feed.
2. **Phase 2 — Tailor:** LaTeX engine setup, tiered tailoring, truth check, PDF output, diff view, cover letters, gap report, prep, budget degradation tiers.
3. **Phase 3 — Apply:** Chrome extension, LinkedIn search collection via the extension, answer bank, Greenhouse/Lever/Ashby/Workable auto-submit, LinkedIn fill-only, safety guardrails, Needs-you flow.
4. **Phase 4 — Widen:** extension-collected Indeed/Glassdoor/Wuzzuf/Bayt/Wellfound search, Indeed and Workday apply, arbitrary company sites, Gmail reply tracking.
