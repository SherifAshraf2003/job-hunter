"use client";
import { useState } from "react";

export function RunNow() {
  const [state, setState] = useState<"idle" | "busy" | "queued" | "error">("idle");
  return (
    <button
      className="btn"
      disabled={state === "busy" || state === "queued"}
      onClick={async () => {
        setState("busy");
        try {
          const r = await fetch("/api/run", { method: "POST" });
          setState(r.ok ? "queued" : "error");
        } catch {
          setState("error");
        }
      }}
    >
      {state === "queued" ? "Search queued" : state === "error" ? "Couldn't queue, try again" : "Run now"}
    </button>
  );
}
