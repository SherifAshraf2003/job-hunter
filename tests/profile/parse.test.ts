import { test, expect } from "vitest";
import { parseResumeFile } from "@/profile/load";

test("a skill with commas inside parentheses stays one skill", () => {
  const p = parseResumeFile();
  expect(p.skills["Cloud and Infrastructure"]).toEqual(["AWS (ECS, EC2, VPC, Load Balancers)", "CI/CD"]);
});
