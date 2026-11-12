import { test, expect, describe } from "vitest";
import { answerByRule, classify } from "@/apply/rules";
import { parseResumeFile } from "@/profile/load";
import type { FormField } from "@/apply/types";
import type { JobRow } from "@/scoring/types";
import type { Feasibility } from "@/scoring/types";

const profile = parseResumeFile();
const job = (o: Partial<JobRow>): JobRow => ({
  id: 1, key: "k", title: "Engineer", companyName: "Acme", location: "", country: null, remotePolicy: "unknown",
  salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryUsdYearMid: null,
  descriptionText: "", applyUrl: "https://x", firstSeenAt: new Date(), lastSeenAt: new Date(), closedAt: null,
  status: "scored", statusReason: null, scoreAttempts: 0, ...o,
});
const field = (label: string, o: Partial<FormField> = {}): FormField => ({ id: "f", label, kind: "text", required: true, ...o });
const ctx = (j: Partial<JobRow>, canTake: Feasibility = "remote_from_egypt", salaryRule: "under_mid" | "under_min" = "under_mid") =>
  ({ profile, job: job(j), canTake, salaryRule });
const val = (r: ReturnType<typeof answerByRule>) => (r && typeof r === "object" ? r.value : r);

const egp = { salaryMin: 60000, salaryMax: 80000, salaryCurrency: "EGP", salaryPeriod: "month" as const };

describe("salary", () => {
  test("salary under midpoint in listing currency", () => {
    expect(val(answerByRule(field("What are your salary expectations?"), ctx(egp)))).toBe("63,000 EGP per month");
  });
  test("salary under_min rule", () => {
    const usd = { salaryMin: 150000, salaryMax: 180000, salaryCurrency: "USD", salaryPeriod: "year" as const };
    expect(val(answerByRule(field("Expected annual compensation"), ctx(usd, "sponsors", "under_min")))).toBe("135,000 USD per year");
  });
  test("salary number input is digits", () => {
    expect(val(answerByRule(field("Desired salary", { kind: "number" }), ctx(egp)))).toBe("63000");
  });
  test("salary picks range option", () => {
    const usd = { salaryMin: 150000, salaryMax: 180000, salaryCurrency: "USD", salaryPeriod: "year" as const };
    const f = field("Salary expectations", { kind: "select", options: ["$100k-$120k", "$120k-$140k", "$140k+"] });
    expect(val(answerByRule(f, ctx(usd)))).toBe("$140k+");
  });
  test("no salary posted returns no_salary", () => {
    expect(answerByRule(field("What is your expected salary?"), ctx({}))).toBe("no_salary");
  });
});

describe("sponsorship", () => {
  const q = field("Will you now or in the future require visa sponsorship?", { kind: "select", options: ["Yes", "No"] });
  test("sponsorship by job", () => {
    expect(val(answerByRule(q, ctx({ country: "EG", remotePolicy: "onsite" }, "in_egypt")))).toBe("No");
    expect(val(answerByRule(q, ctx({ country: "US", remotePolicy: "remote" }, "remote_from_egypt")))).toBe("No");
    expect(val(answerByRule(q, ctx({ country: "US", remotePolicy: "onsite" }, "sponsors")))).toBe("Yes");
    expect(val(answerByRule(q, ctx({ country: "GB", remotePolicy: "hybrid" }, "unclear")))).toBe("Yes");
  });
});

test("work authorization", () => {
  const yn = { kind: "radio" as const, options: ["Yes", "No"] };
  expect(val(answerByRule(field("Are you legally authorized to work in the United States?", yn), ctx({ country: "US" })))).toBe("No");
  expect(val(answerByRule(field("Are you authorized to work in Egypt?", yn), ctx({ country: "US" })))).toBe("Yes");
  expect(val(answerByRule(field("Are you legally authorized to work in the country where this job is located?", yn), ctx({ country: "EG" }, "in_egypt")))).toBe("Yes");
});

test("eeo declines", () => {
  const f = field("Gender", { kind: "select", options: ["Male", "Female", "Decline to self-identify"], required: false });
  expect(val(answerByRule(f, ctx({})))).toBe("Decline to self-identify");
});

test("resume file field", () => {
  const r = answerByRule(field("Resume/CV", { kind: "file" }), ctx({}));
  expect(r).toMatchObject({ file: "resume", source: "profile" });
  expect(answerByRule(field("Cover Letter", { kind: "file", required: false }), ctx({}))).toMatchObject({ file: "cover" });
});

test("profile facts", () => {
  expect(val(answerByRule(field("First Name"), ctx({})))).toBe("Sherif");
  expect(val(answerByRule(field("Last Name"), ctx({})))).toBe("Ashraf Mohamed");
  expect(val(answerByRule(field("Email", { kind: "email" }), ctx({})))).toBe("sherifelamir2003@gmail.com");
  expect(val(answerByRule(field("LinkedIn Profile"), ctx({})))).toBe("https://linkedin.com/in/sherifElamir");
  expect(val(answerByRule(field("GitHub URL"), ctx({})))).toBe("https://github.com/SherifAshraf2003");
  expect(classify(field("Why do you want to work at Acme?", { kind: "textarea" }))).toBe("why_us");
  expect(classify(field("Phone"))).toBe("phone");
});

test("combined authorization + sponsorship wording is answered as work authorization", () => {
  const yn = { kind: "radio" as const, options: ["Yes", "No"] };
  const q = "Are you legally authorized to work in the United States without the need for visa sponsorship?";
  expect(val(answerByRule(field(q, yn), ctx({ country: "US", remotePolicy: "remote" }, "remote_from_egypt")))).toBe("No");
  expect(val(answerByRule(field(q), ctx({ country: "US", remotePolicy: "onsite" }, "sponsors")))).toBe("No");
});

test("skill-specific years and current salary are not answered by rule", () => {
  const usd = { salaryMin: 100000, salaryMax: 120000, salaryCurrency: "USD", salaryPeriod: "year" as const };
  expect(answerByRule(field("How many years of experience do you have with Kubernetes?"), ctx({}))).toBeNull();
  expect(answerByRule(field("Years of experience with React"), ctx({}))).toBeNull();
  expect(answerByRule(field("What is your current salary?"), ctx(usd))).toBeNull();
  expect(answerByRule(field("Current compensation"), ctx(usd))).toBeNull();
  expect(val(answerByRule(field("Years of professional experience", { kind: "number" }), ctx({})))).toBe(String(profile.facts.yearsExperience));
});
