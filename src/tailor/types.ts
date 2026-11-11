export type Tier = "top" | "middle" | "bottom";
/** "r{roleIdx}b{bulletIdx}" for a role bullet, "p{projectIdx}" for a project. */
export type SourceRef = string;

export type TailoredResume = {
  headline: string;
  roles: { roleIdx: number; bullets: { text: string; source: SourceRef }[] }[];
  projects: { source: SourceRef; text: string }[];
  skills: { category: string; items: string[] }[];
  includeQuote: boolean;
};

export type TruthIssue = { where: string; problem: string; action: "reverted" | "dropped" };

export type GapItem = { requirement: string; importance: "core" | "nice"; suggestion: string };
export type Prep = { questions: { question: string; why: string }[]; companyNotes: string[] };

export type TailoringResult = {
  tier: Tier; model: string; resume: TailoredResume; issues: TruthIssue[];
  coverLetter: string | null; gapReport: GapItem[]; prep: Prep; usd: number;
};

export type Treatment = { tier: Tier; resumeModel: string | null; extrasModel: string; rewrite: "full" | "reorder" | "keywords" };
