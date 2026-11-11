import pLimit from "p-limit";

export const USER_AGENT = "job-finder/0.1 (personal job search)";

export class BoardNotFoundError extends Error {
  constructor(public url: string) { super(`Board not found: ${url}`); this.name = "BoardNotFoundError"; }
}
export class HttpError extends Error {
  constructor(public url: string, public status: number) { super(`HTTP ${status} for ${url}`); this.name = "HttpError"; }
}

// Workable rate-limits aggressively, so it gets one request at a time.
const HOST_CONCURRENCY: Record<string, number> = { "apply.workable.com": 1 };
const limits = new Map<string, ReturnType<typeof pLimit>>();
function limitFor(url: string) {
  const host = new URL(url).host;
  if (!limits.has(host)) limits.set(host, pLimit(HOST_CONCURRENCY[host] ?? 4));
  return limits.get(host)!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET (or POST) with polite per-host concurrency, UA, a 20s timeout, and backoff on 429 (up to 3 retries). */
export async function getText(url: string, init?: RequestInit): Promise<string> {
  return limitFor(url)(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/xml, */*", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 5000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) throw new BoardNotFoundError(url);
      if (!res.ok) throw new HttpError(url, res.status);
      return res.text();
    }
  });
}

export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return JSON.parse(await getText(url, init)) as T;
}
