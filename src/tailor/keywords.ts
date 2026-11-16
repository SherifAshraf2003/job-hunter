/**
 * Tech terms recruiters and ATS searches look for, each with the spellings that mean the same thing.
 * Only true spellings of one skill share a group, never different products (Pinecone is not Weaviate):
 * the claim check accepts any spelling in the group as the real skill. The first spelling is the display name. Used for the match score and to accept the job's spelling of a real skill.
 */
const TERMS: string[][] = [
  ["Python"], ["TypeScript", "TS"], ["JavaScript", "JS"], ["Node.js", "Node", "NodeJS"], ["React", "React.js", "ReactJS"],
  ["Next.js", "NextJS"], ["Go", "Golang"], ["Rust"], ["Java"], ["Kotlin"], ["Swift"], ["C++", "CPP"], ["C#"], ["Ruby"],
  ["Rails", "Ruby on Rails", "RoR"], ["Django"], ["FastAPI"], ["Flask"], ["PHP"], ["Laravel"], ["Vue", "Vue.js"], ["Angular"],
  ["Svelte"], ["Tailwind CSS", "Tailwind"], ["HTML"], ["CSS"], ["SQL"],
  ["PostgreSQL", "Postgres", "psql"], ["MySQL"], ["MongoDB", "Mongo"], ["Redis"], ["DynamoDB"], ["SQLite"], ["Supabase"], ["Firebase"],
  ["Elasticsearch"], ["Kafka"], ["RabbitMQ"], ["GraphQL"], ["REST", "RESTful"], ["gRPC"], ["WebSockets", "WebSocket"],
  ["AWS", "Amazon Web Services"], ["GCP", "Google Cloud"], ["Azure"], ["Docker"], ["Kubernetes", "K8s"], ["Terraform"],
  ["CI/CD"], ["Linux"], ["Serverless"], ["Lambda", "AWS Lambda"], ["Vercel"], ["Cloudflare"],
  ["LLMs", "LLM", "Large Language Models"], ["RAG", "Retrieval-Augmented Generation"], ["AI Agents", "Agents", "Agentic"],
  ["LangChain"], ["LlamaIndex"], ["OpenAI"], ["Anthropic"], ["Claude"], ["Prompt Engineering"], ["Embeddings"],
  ["Vector Databases", "Vector Database", "Vector DB"], ["Pinecone"], ["pgvector"], ["Weaviate"], ["Evals", "Evaluations"], ["Fine-tuning", "Fine tuning"],
  ["PyTorch"], ["TensorFlow"], ["Machine Learning", "ML"], ["NLP"], ["MCP", "Model Context Protocol"],
  ["Voice Agents", "Voice AI"], ["Twilio"], ["Stripe"], ["Microservices"], ["Distributed Systems"], ["Job Queues", "Queues", "Background Jobs"],
  ["Playwright"], ["Jest"], ["Vitest"], ["Cypress"], ["Spark"], ["Airflow"], ["Snowflake"], ["dbt"],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = (alias: string) => new RegExp(`(^|[^A-Za-z0-9+#])${esc(alias)}($|[^A-Za-z0-9+#])`, alias.length <= 3 ? "" : "i");
const has = (text: string, group: string[]) => group.some((a) => re(a).test(text));

/** The display name of a skill, or the skill itself when it isn't a known term. */
export function canonical(skill: string): string {
  const s = skill.trim().toLowerCase();
  return TERMS.find((g) => g.some((a) => a.toLowerCase() === s))?.[0] ?? skill.trim();
}

/** "Postgres" and "PostgreSQL" are the same skill; "Java" and "JavaScript" are not. */
export function sameSkill(a: string, b: string): boolean {
  return canonical(a).toLowerCase() === canonical(b).toLowerCase();
}

/** Which of the job ad's tech terms the resume shows, by any spelling. Short terms (Go, ML) match case-sensitively. */
export function matchTerms(jobText: string, resumeText: string): { matched: string[]; missing: string[] } {
  const wanted = TERMS.filter((g) => has(jobText, g));
  return {
    matched: wanted.filter((g) => has(resumeText, g)).map((g) => g[0]),
    missing: wanted.filter((g) => !has(resumeText, g)).map((g) => g[0]),
  };
}
