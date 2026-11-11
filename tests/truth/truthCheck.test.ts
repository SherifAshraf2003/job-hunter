import { test, expect } from "vitest";
import { truthCheck, baseResume, sourceText } from "@/tailor/truth";
import { parseResumeFile } from "@/profile/load";
import type { TailoredResume } from "@/tailor/types";

const p = parseResumeFile();
const noFlags = async () => [] as string[];

function withBullet(text: string, source: string): TailoredResume {
  const r = baseResume(p);
  r.roles[0].bullets = [{ text, source }, ...r.roles[0].bullets.filter((b) => b.source !== source)];
  return r;
}
const bulletFor = (r: TailoredResume, source: string) => r.roles.flatMap((x) => x.bullets).find((b) => b.source === source);

test("reverts a bullet with an invented number", async () => {
  const { resume, issues } = await truthCheck(withBullet("Reduced AWS costs by 60% by optimizing ECS and EC2.", "r0b5"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b5")!.text).toBe(sourceText(p, "r0b5"));
  expect(issues.find((i) => i.where === "r0b5")?.action).toBe("reverted");
});

test("reverts a bullet naming another employer", async () => {
  const { resume, issues } = await truthCheck(withBullet("Built voice agents at Google serving concurrent users.", "r0b1"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b1")!.text).toBe(sourceText(p, "r0b1"));
  expect(issues.some((i) => i.where === "r0b1" && i.action === "reverted")).toBe(true);
});

test("reverts a bullet adding a tool from the job", async () => {
  const { resume } = await truthCheck(withBullet("Developed a scalable, real-time AI voice agent on Kubernetes over Twilio.", "r0b1"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b1")!.text).toBe(sourceText(p, "r0b1"));
});

test("drops an unknown source", async () => {
  const r = baseResume(p);
  r.roles[0].bullets.push({ text: "Did something", source: "r9b9" });
  const { resume, issues } = await truthCheck(r, p, "m", noFlags);
  expect(bulletFor(resume, "r9b9")).toBeUndefined();
  expect(issues.find((i) => i.where === "r9b9")?.action).toBe("dropped");
});

test("drops a skill not in the base", async () => {
  const r = baseResume(p);
  r.skills = [{ category: "AI", items: ["LLMs", "Kubernetes"] }];
  const { resume, issues } = await truthCheck(r, p, "m", noFlags);
  expect(resume.skills[0].items).toEqual(["LLMs"]);
  expect(issues.some((i) => i.action === "dropped" && /Kubernetes/.test(i.problem))).toBe(true);
});

test("keeps a faithful rephrase", async () => {
  const text = "Shipped a real-time Twilio AI voice agent serving concurrent users with no voice-quality loss";
  const { resume, issues } = await truthCheck(withBullet(text, "r0b1"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b1")!.text).toBe(text);
  expect(issues).toHaveLength(0);
});

test("reverts a bullet the claim check flags", async () => {
  const text = "Owned the full web app and most of the backend, shipping features to thousands of daily users";
  const { resume, issues } = await truthCheck(withBullet(text, "r0b0"), p, "m", async () => ["r0b0"]);
  expect(bulletFor(resume, "r0b0")!.text).toBe(sourceText(p, "r0b0"));
  expect(issues.some((i) => i.where === "r0b0" && i.action === "reverted")).toBe(true);
});

test("reverts a short invented tool name hidden inside other words (Go)", async () => {
  const { resume } = await truthCheck(withBullet("Built backend services in Go for asynchronous processing using Redis.", "r0b3"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b3")!.text).toBe(sourceText(p, "r0b3"));
});

test("drops a skill that only appears inside another word", async () => {
  const r = baseResume(p);
  r.skills = [{ category: "Languages", items: ["TypeScript", "Go"] }];
  const { resume } = await truthCheck(r, p, "m", noFlags);
  expect(resume.skills[0].items).toEqual(["TypeScript"]);
});

test("if the claim check fails, every rewrite reverts to the original wording", async () => {
  const text = "Shipped a real-time Twilio AI voice agent serving concurrent users with no voice-quality loss";
  const { resume } = await truthCheck(withBullet(text, "r0b1"), p, "m", async () => { throw new Error("model down"); });
  expect(bulletFor(resume, "r0b1")!.text).toBe(sourceText(p, "r0b1"));
});

test("accepts hyphenated compounds of known terms (Redis-backed, LLM-powered)", async () => {
  const text = "Built Redis-backed job queues and background workers for asynchronous processing";
  const { resume, issues } = await truthCheck(withBullet(text, "r0b3"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b3")!.text).toBe(text);
  expect(issues).toHaveLength(0);
});

test("still rejects hyphenated compounds of unknown terms (Kafka-backed)", async () => {
  const { resume } = await truthCheck(withBullet("Built Kafka-backed job queues for asynchronous processing", "r0b3"), p, "m", noFlags);
  expect(bulletFor(resume, "r0b3")!.text).toBe(sourceText(p, "r0b3"));
});

test("accepts a headline with known stack terms in parentheses", async () => {
  const r = baseResume(p);
  r.headline = "Founding Engineer, AI Products (TypeScript/Node.js)";
  const { resume } = await truthCheck(r, p, "m", noFlags);
  expect(resume.headline).toBe("Founding Engineer, AI Products (TypeScript/Node.js)");
});

test("a duplicated source is dropped and logged", async () => {
  const r = baseResume(p);
  r.roles[0].bullets.push({ source: "r0b0", text: "Led a team of 40 engineers at Google" });
  const { resume, issues } = await truthCheck(r, p, "m", noFlags);
  expect(resume.roles[0].bullets.filter((b) => b.source === "r0b0")).toHaveLength(1);
  expect(issues.some((i) => i.where === "r0b0" && i.action === "dropped")).toBe(true);
});

// ---- Final review: ways invented content could reach the PDF ----
import { parseVerdicts } from "@/tailor/truth";

const JOB = "We use Kubernetes, gRPC, Kafka and Terraform. Experience with Go is a plus.";
const check = (r: TailoredResume) => truthCheck(r, p, "m", noFlags, JOB);

test("C1: a bullet moved to another employer is dropped", async () => {
  const r = baseResume(p);
  r.roles[0].bullets.push({ source: "r3b0", text: sourceText(p, "r3b0")! });
  const { resume, issues } = await check(r);
  expect(resume.roles[0].bullets.some((b) => b.source === "r3b0")).toBe(false);
  expect(issues.some((i) => i.where === "r3b0" && i.action === "dropped")).toBe(true);
});

test("C1: a project under a role, or a role bullet under projects, is dropped", async () => {
  const r = baseResume(p);
  r.roles[0].bullets.push({ source: "p0", text: sourceText(p, "p0")! });
  r.projects.push({ source: "r0b5", text: sourceText(p, "r0b5")! });
  const { resume } = await check(r);
  expect(resume.roles[0].bullets.some((b) => b.source === "p0")).toBe(false);
  expect(resume.projects.some((b) => b.source === "r0b5")).toBe(false);
});

test("M1: non-canonical source aliases are dropped", async () => {
  const r = baseResume(p);
  r.roles[0].bullets.push({ source: "r0b03", text: "Built Redis job queues." });
  const { resume } = await check(r);
  expect(resume.roles[0].bullets.some((b) => b.source === "r0b03")).toBe(false);
});

test("C2: a skill category that isn't on the resume is dropped", async () => {
  const r = baseResume(p);
  r.skills = [{ category: "Kubernetes, Terraform, Go, 8 years", items: ["Redis"] }, { category: "AI", items: ["LLMs"] }];
  const { resume } = await check(r);
  expect(resume.skills.map((c) => c.category)).toEqual(["AI"]);
});

test.each(["Security Engineer", "Data Engineer", "Infrastructure Engineer", "AI Engineer with 100 users"])(
  "I1: headline %s is reverted", async (h) => {
    const r = baseResume(p); r.headline = h;
    const { resume } = await check(r);
    expect(resume.headline).toBe(p.headline);
  });

test("I1: honest headlines still pass", async () => {
  for (const h of ["Founding Engineer, AI Products", "Full-Stack AI Engineer", "AI Engineer"]) {
    const r = baseResume(p); r.headline = h;
    expect((await check(r)).resume.headline).toBe(h);
  }
});

test.each([
  ["lowercase tool copied from the job", "Built kubernetes-orchestrated job queues for asynchronous processing."],
  ["tool as the first word", "Kubernetes-based job queues and background jobs for asynchronous processing."],
  ["tool with an inner capital", "Built backend services over gRPC with Redis and job queues."],
  ["number written as a word", "Built backend services with a team of ten engineers using Redis."],
  ["fullwidth digits", "Built backend services handling １０M jobs using Redis."],
  ["look-alike Greek letter", "Built backend services on Κfka using Redis and job queues."],
  ["tool in backticks", "Built backend services using `Kafka`, Redis, and job queues."],
  ["another employer's name", "Built backend services at Orange for asynchronous processing using Redis."],
])("I2: %s is reverted", async (_name, text) => {
  const { resume } = await check(withBullet(text, "r0b3"));
  expect(bulletFor(resume, "r0b3")!.text).toBe(sourceText(p, "r0b3"));
});

test("I3: claim-check verdicts: missing ids, bad shape, and odd spacing count as unsupported", () => {
  expect(parseVerdicts({ verdicts: { r0b1: "ok", r0b2: "unsupported" } }, ["r0b1", "r0b2", "r0b3"])).toEqual(["r0b2", "r0b3"]);
  expect(parseVerdicts({ flagged: ["r0b1"] }, ["r0b1", "r0b2"])).toEqual(["r0b1", "r0b2"]);
  expect(parseVerdicts({ verdicts: { " R0B1 ": "OK" } }, ["r0b1"])).toEqual([]);
});
