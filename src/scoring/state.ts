import type { BaseProfile } from "../profile/types";
import type { JobRow } from "./types";

/** The state Jev judges: the job listing and the candidate's real experience. No contact details. */
export function buildScoringState(job: JobRow, p: BaseProfile) {
  const salary = job.salaryMin || job.salaryMax
    ? `${job.salaryCurrency ?? ""} ${job.salaryMin ?? "?"}–${job.salaryMax ?? "?"} per ${job.salaryPeriod ?? "year"}`
    : "not posted";
  return {
    job: {
      title: job.title,
      company: job.companyName,
      location: job.location || "not stated",
      country: job.country ?? "unknown",
      remote_policy: job.remotePolicy,
      salary,
      description: job.descriptionText.slice(0, 6000),
    },
    candidate: {
      headline: p.headline,
      citizenship: "Egyptian citizen, lives in Egypt, no other work authorization",
      years_of_professional_experience: p.facts.yearsExperience,
      roles: p.roles.map((r) => ({ title: r.title, org: r.org, dates: r.dates, bullets: r.bullets })),
      projects: p.projects.map((x) => `${x.name}: ${x.text}`),
      skills: p.skills,
    },
  };
}
