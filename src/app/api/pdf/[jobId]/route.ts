import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad job id", { status: 400 });
  let pdf: Buffer;
  try {
    pdf = await readFile(path.join(process.cwd(), "data", "out", String(id), "resume.pdf"));
  } catch {
    return new Response("No tailored resume for this job yet", { status: 404 });
  }
  const [job] = await db.select({ company: jobs.companyName }).from(jobs).where(eq(jobs.id, id));
  const company = (job?.company ?? "job").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="Sherif-Ashraf-Mohamed-${company}.pdf"`,
    },
  });
}
