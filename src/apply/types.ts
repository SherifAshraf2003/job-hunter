export type Site = "greenhouse" | "lever" | "ashby" | "workable" | "linkedin" | "other";

export type AppStatus =
  | "queued" | "filling" | "ready_to_submit" | "needs_you" | "submitting" | "applied"
  | "skipped" | "failed" | "manual" | "interviewing" | "rejected" | "offer";

export type FieldKind = "text" | "textarea" | "email" | "tel" | "url" | "number" | "select" | "radio" | "checkbox" | "file" | "date";

/** One form field as the extension reads it from the page. */
export type FormField = { id: string; label: string; kind: FieldKind; required: boolean; options?: string[] };

export type FillSource = "profile" | "rule" | "bank" | "drafted" | "job";

/** What to put in one field. `file` fields are uploaded by the extension from /api/ext/file. */
export type Fill = { id: string; label: string; value: string | string[] | boolean | null; file?: "resume" | "cover"; source: FillSource };

/** "applied_pending" exists only in plans: the job becomes "applied" when the extension reports the confirmation page. */
export type FillPlan = { fills: Fill[]; action: "submit" | "stop"; status: "applied_pending" | "ready_to_submit" | "needs_you"; reason: string | null };

export type ReportOutcome = "applied" | "stopped" | "needs_you" | "closed" | "failed" | "captcha" | "blocked" | "login_wall";
export type Report = { outcome: ReportOutcome; reason?: string; url?: string };
