import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { denyUnlessExtension } from "../../../auth";
import { db } from "@/db/client";
import { tailorings } from "@/db/schema";
import { loadProfile } from "@/profile/load";
import { coverLetterPdf } from "@/apply/coverPdf";

export const dynamic = "force-dynamic";

/** The tailored resume PDF or the cover letter as a PDF, for the extension to upload. */
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string; kind: string }> }) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const { jobId, kind } = await params;
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad job id", { status: 400 });
  const [t] = await db.select().from(tailorings).where(eq(tailorings.jobId, id));
  const pdf = (bytes: Uint8Array, name: string) => new Response(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"` },
  });
  if (kind === "resume" && t?.pdfPath) return pdf(await readFile(t.pdfPath), "Sherif_Ashraf_Mohamed_Resume.pdf");
  if (kind === "cover" && t?.coverLetter) return pdf(await coverLetterPdf(t.coverLetter, await loadProfile()), "Sherif_Ashraf_Mohamed_Cover_Letter.pdf");
  return new Response("Not found", { status: 404 });
}
