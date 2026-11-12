# Job Finder

A personal job-hunting agent. Phase 1 finds software jobs from public job APIs and feeds, scores each one with Jev, and shows them ranked in a local dashboard.

Design: `docs/superpowers/specs/2026-11-11-job-finder-design.md`

## Setup (macOS)

1. Postgres 17:
   ```bash
   brew install postgresql@17 && brew services start postgresql@17
   createdb jobfinder && createdb jobfinder_test
   ```
2. Dependencies and config:
   ```bash
   npm install
   cp .env.example .env   # then fill in the keys below
   npm run db:migrate
   ```
3. Keys in `.env`:
   - `OPENROUTER_API_KEY`: used to read Hacker News "Who is hiring" posts (model: `OPENROUTER_CHEAP_MODEL`).
   - `TYPESAFE_API_KEY`: Jev scoring. Without it, jobs are found but not scored.
   - `JEV_USD_PER_MTOK_INPUT=0.042`, `JEV_USD_PER_MTOK_OUTPUT=0`: Jev prices used for the spend meter.

## Run

Two terminals:

```bash
npm run dev      # dashboard at http://localhost:3000
npm run worker   # searches now, then every 4 hours (Settings → "Search every")
```

- `npm run worker -- --once` runs one search and exits.
- `MAX_BOARDS=50 npm run worker -- --once` polls only 50 company boards (handy for a quick test).
- **Run now** in the dashboard queues a search; the worker picks it up within 30 seconds.

## How it works

1. **Companies:** seeded from YC's hiring list and `data/egypt-companies.json` by probing Greenhouse, Lever, Ashby, and Workable (150 new names per search, until all are probed), plus every board link seen in other sources.
2. **Sources:** every active company board, RemoteOK, We Work Remotely, and HN "Who is hiring".
3. **Dedupe:** same company + same role = one job; the company's own ATS link wins.
4. **Pre-filter (free):** drops non-software, intern, staff/principal/manager titles, and 8+ years required.
5. **Scoring (Jev):** role scope, company, pay (vs. the job's local market), level, fit, and whether you can take it from Egypt. The composite uses your weights and updates instantly when you change them.

## Tailoring (Phase 2)

After scoring, every open job you can take with a score at or above the cutoff (60) gets a tailored one-page resume, built from `resume.tex` with your exact layout.

| Tier | Which jobs | Treatment | Model (`.env`) |
|---|---|---|---|
| Top | Score 80+, max 5 per day | Full rewrite in the job's language | `OPENROUTER_TOP_MODEL` (Claude Haiku 5.5) |
| Middle | Score 70+ | Reorder + light keyword rewording | `OPENROUTER_MID_MODEL` (Claude Haiku 5.5) |
| Bottom | Score 60+ | Original bullets; headline and skill order only | `OPENROUTER_MID_MODEL` |

- **Never invents experience.** Every bullet must point to one of your real bullets. New numbers, names, or tools not on your resume revert to your original wording, and a second model checks for overstated claims. The dashboard lists anything reverted ("Show changes").
- **Cover letters only when the listing asks for one.**
- The **gap report** (what the job wants that your resume doesn't show, with a 1–2 day side project to close it) and **interview prep** are generated on demand: open the Gaps or Interview prep tab on a tailored job and press the button (one small model call). Tailoring itself only pays for a cover letter, and only when the listing asks for one.
- Files: `data/out/<jobId>/resume.pdf`. **Re-tailor** in the dashboard redoes a job on the next search.
- Requires Tectonic: `brew install tectonic` (the first build downloads LaTeX packages).
- Free models are never used for tailoring (your resume is personal data).
- `npm run worker -- --once --skip-search` scores and tailors existing jobs without searching.

## Budget

Hard cap of $10/month (Settings). Above 70% of the cap the top tier drops to the middle model; above 90% everything gets the bottom treatment. Scoring and HN extraction can use at most half of it, and at most 1/30 of that half per day. At about $0.00015 per Jev-scored job, that is roughly 30,000 jobs a month. When a cap is hit, scoring stops and resumes in the next search with budget left.

## Tests

Only the budget caps have automated tests: `npm test`. Other parts have check scripts in `scripts/` (`check-text.ts`, `fetch-board.ts <ats> <slug>`, `check-feeds.ts`, `check-upsert.ts`, `score-one.ts <jobId...>`, `print-profile.ts`).
