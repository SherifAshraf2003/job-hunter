import { test, expect } from "vitest";
import { matchTerms, sameSkill } from "@/tailor/keywords";

test("matchTerms treats spelling variants as the same skill", () => {
  const m = matchTerms("We use Postgres, Node and Kubernetes with LLMs.", "Built APIs on PostgreSQL and Node.js using LLM agents.");
  expect(m.matched).toEqual(expect.arrayContaining(["PostgreSQL", "Node.js", "LLMs"]));
  expect(m.missing).toEqual(["Kubernetes"]);
});

test("matchTerms doesn't match a short term inside a word", () => {
  const m = matchTerms("Experience with Go is required.", "Worked at Google on algorithms.");
  expect(m.missing).toContain("Go");
});

test("sameSkill matches aliases, not unrelated skills", () => {
  expect(sameSkill("Postgres", "PostgreSQL")).toBe(true);
  expect(sameSkill("node", "Node.js")).toBe(true);
  expect(sameSkill("Java", "JavaScript")).toBe(false);
});

test("different products are never the same skill, even in the same category", () => {
  expect(sameSkill("Pinecone", "Weaviate")).toBe(false);
  expect(sameSkill("Claude", "Anthropic")).toBe(false);
});
