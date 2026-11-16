"use client";
import { useFormStatus } from "react-dom";

/** The Apply button: tailoring can take a minute, so it says what's happening while it runs. */
export function ApplyButton({ tailored }: { tailored: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary big" type="submit" disabled={pending}>
      {pending ? (tailored ? "Adding to the queue…" : "Tailoring your resume, about a minute…") : "Apply to this job"}
    </button>
  );
}
