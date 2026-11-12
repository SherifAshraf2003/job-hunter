import { NextResponse } from "next/server";
import { denyUnlessExtension } from "../auth";
import { buildFillPlan } from "@/apply/plan";
import type { FormField } from "@/apply/types";

export const dynamic = "force-dynamic";

const KINDS = new Set(["text", "textarea", "email", "tel", "url", "number", "select", "radio", "checkbox", "file", "date"]);

/** Fields read from the page in, fill plan out. */
export async function POST(req: Request) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as { jobId?: unknown; fields?: unknown } | null;
  const jobId = Number(body?.jobId);
  if (!Number.isInteger(jobId) || !Array.isArray(body?.fields)) return NextResponse.json({ error: "Expected {jobId, fields[]}" }, { status: 400 });
  const fields: FormField[] = (body.fields as Record<string, unknown>[])
    .filter((f) => f && typeof f.id === "string" && typeof f.label === "string" && KINDS.has(String(f.kind)))
    .map((f) => ({
      id: String(f.id), label: String(f.label).slice(0, 500), kind: f.kind as FormField["kind"], required: !!f.required,
      options: Array.isArray(f.options) ? (f.options as unknown[]).map(String).slice(0, 200) : undefined,
    }));
  try {
    return NextResponse.json(await buildFillPlan(jobId, fields));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
