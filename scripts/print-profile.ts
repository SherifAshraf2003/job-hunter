import { parseResumeFile } from "../src/profile/load";

const p = parseResumeFile();
console.log(JSON.stringify(p, null, 2));
const checks: [string, boolean][] = [
  ["name", p.name === "Sherif Ashraf Mohamed"],
  ["headline", p.headline === "Full-Stack AI Engineer"],
  ["orgs", JSON.stringify(p.roles.map((r) => r.org)) === JSON.stringify(["Dialbird", "PlawLabs (Vulnzap, Brief)", "Upwork", "Orange Egypt"])],
  ["dialbird bullets", p.roles[0].bullets.length === 7],
  ["aws bullet", p.roles[0].bullets[5] === "Reduced AWS costs by approximately 30% by optimizing ECS services and EC2 instances across staging and production."],
  ["dates", p.roles[0].dates === "Feb 2026 – Oct 2026"],
  ["project", p.projects[0].name === "LeadMate (Co-Founder)"],
  ["skills AI", JSON.stringify(p.skills["AI"]) === JSON.stringify(["LLMs", "RAG", "Voice Agents", "Pinecone", "MCP"])],
  ["coursework", p.education[0]?.coursework.includes("Information Retrieval") ?? false],
  ["awards", p.awards.length === 3],
];
for (const [n, ok] of checks) console.log(ok ? "OK  " : "FAIL", n);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
