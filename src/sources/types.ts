export type Ats = "greenhouse" | "lever" | "ashby" | "workable";
export type BoardRef = { ats: Ats; slug: string };

export type Salary = { min: number | null; max: number | null; currency: string; period: "year" | "month" | "hour" };

export type NormalizedJob = {
  source: string;
  externalId: string;
  url: string;
  applyUrl: string;
  title: string;
  companyName: string;
  location: string;
  country: string | null;
  remotePolicy: "remote" | "hybrid" | "onsite" | "unknown";
  salary: Salary | null;
  descriptionText: string;
  postedAt: Date | null;
  /** Set for jobs fetched from a company board, so closed-job detection can scope to that board. */
  boardSlug?: string;
};

export type SourceResult = { jobs: NormalizedJob[]; harvested: BoardRef[] };
