import { describe, expect, it } from "vitest";
import { composite } from "../../src/scoring/composite";
import { config } from "../../src/config";

const dims = (v: number, level: number) => ({ scope: v, company: v, pay: v, level, fit: v, canTake: "remote_from_egypt" as const });

describe("composite seniority", () => {
  it("a job asking for far more experience than he has falls below the cutoff, however good the rest", () => {
    expect(composite(dims(90, 20), config.weights).score).toBeLessThan(config.cutoff);
  });
  it("a stretch role (3–5 years) keeps its score", () => {
    expect(composite(dims(90, 50), config.weights).score).toBeGreaterThanOrEqual(85);
  });
});
