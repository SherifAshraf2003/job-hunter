import pLimit from "p-limit";

export const USER_AGENT = "job-finder/0.1 (personal job search)";

export class BoardNotFoundError extends Error {
  constructor(public url: string) { super(`Board not found: ${url}`); this.name = "BoardNotFoundError"; }
}
export class HttpError extends Error {
  constructor(public url: string, public status: number) { super(`HTTP ${status} for ${url}`); this.name = "HttpError"; }
}

const limits = new Map<string, ReturnType<typeof pLimit>>();
function limitFor(url: string) {
  const host = new URL(url).host;
  if (!limits.has(host)) limits.set(host, pLimit(4));
  return limits.get(host)!;
}

/** GET (or POST) with polite per-host concurrency (4), UA, and a 20s timeout. */
export async function getText(url: string, init?: RequestInit): Promise<string> {
  return limitFor(url)(async () => {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/xml, */*", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) throw new BoardNotFoundError(url);
    if (!res.ok) throw new HttpError(url, res.status);
    return res.text();
  });
}

export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return JSON.parse(await getText(url, init)) as T;
}
