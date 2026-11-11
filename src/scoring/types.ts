import type { jobs } from "../db/schema";
import type { BaseProfile } from "../profile/types";

export type Feasibility = "in_egypt" | "remote_from_egypt" | "sponsors" | "unclear" | "not_possible";
export const FEASIBILITY: Feasibility[] = ["in_egypt", "remote_from_egypt", "sponsors", "unclear", "not_possible"];

export type DimensionScores = {
  scope: number; company: number; pay: number; level: number; fit: number;
  canTake: Feasibility; canTakeConfidence: number; raw: unknown;
};

export type JobRow = typeof jobs.$inferSelect;

export interface Scorer {
  engine: "jev";
  estimateUsd(): number;
  score(job: JobRow, profile: BaseProfile): Promise<DimensionScores>;
}
