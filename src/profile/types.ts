export type BaseProfile = {
  name: string;
  headline: string;
  links: string[];
  roles: { title: string; org: string; dates: string; bullets: string[] }[];
  quote?: string;
  projects: { name: string; text: string }[];
  skills: Record<string, string[]>;
  education: { degree: string; school: string; dates: string; coursework: string[] }[];
  awards: { name: string; text: string }[];
  facts: { citizenship: "Egypt"; location: "Egypt"; yearsExperience: number };
};
