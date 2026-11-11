import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;
const g = globalThis as unknown as { __db?: DB; __sql?: ReturnType<typeof postgres> };

function make(): DB {
  const client = postgres(process.env.DATABASE_URL!, { max: 10, onnotice: () => {} });
  g.__sql = client;
  return drizzle(client, { schema });
}

export const db: DB = g.__db ?? (g.__db = make());

export async function resetDb(): Promise<void> {
  await db.execute(sql`truncate companies, jobs, job_sources, job_scores, spend, settings, profile, runs restart identity cascade`);
}

export async function closeDb(): Promise<void> {
  await g.__sql?.end();
  g.__db = undefined;
}
