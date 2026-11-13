import { test, expect } from "vitest";
import { pickApplyTarget } from "@/apply/sites";

test("a Greenhouse job behind a company careers page applies through the Greenhouse form", () => {
  const url = "https://stripe.com/jobs/search?gh_jid=8076626";
  const t = pickApplyTarget({ applyUrl: url }, [{ source: "greenhouse", url, boardSlug: "stripe", externalId: "8076626" }]);
  expect(t).toEqual({ url: "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8076626", site: "greenhouse", boardKey: "greenhouse:stripe" });
});

test("a plain Greenhouse URL is kept as is", () => {
  const url = "https://job-boards.greenhouse.io/scaleai/jobs/4673310005";
  const t = pickApplyTarget({ applyUrl: url }, [{ source: "greenhouse", url, boardSlug: "scaleai", externalId: "4673310005" }]);
  expect(t).toEqual({ url, site: "greenhouse", boardKey: "greenhouse:scaleai" });
});
