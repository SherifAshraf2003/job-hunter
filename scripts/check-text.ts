import { htmlToText, parseSalary, toUsdYearMid, inferRemote, inferCountry } from "../src/sources/text";
import { config } from "../src/config";

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cases: [string, unknown, unknown][] = [
  ["htmlToText", htmlToText("&lt;p&gt;Hello &amp;amp; bye&lt;/p&gt;"), "Hello & bye"],
  ["salary range", parseSalary("$150,000 - $180,000 per year"), { min: 150000, max: 180000, currency: "USD", period: "year" }],
  ["salary k", parseSalary("$150k–$180k"), { min: 150000, max: 180000, currency: "USD", period: "year" }],
  ["salary EGP", parseSalary("EGP 60,000 - 80,000 monthly"), { min: 60000, max: 80000, currency: "EGP", period: "month" }],
  ["salary GBP", parseSalary("£70k"), { min: 70000, max: 70000, currency: "GBP", period: "year" }],
  ["salary none", parseSalary("competitive salary"), null],
  ["usd mid", toUsdYearMid({ min: 60000, max: 80000, currency: "EGP", period: "month" }, config.fxToUsd), 17220],
  ["remote", inferRemote("Remote - Worldwide", ""), "remote"],
  ["country", inferCountry("Cairo, Egypt"), "EG"],
];
let fail = 0;
for (const [n, got, want] of cases) {
  const ok = eq(got, want); if (!ok) fail++;
  console.log(ok ? "OK  " : "FAIL", n, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
process.exit(fail ? 1 : 0);
