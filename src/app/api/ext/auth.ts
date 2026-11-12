import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { loadSettings, saveSetting } from "@/config";

/** The shared secret the extension sends in `x-jobfinder-token`. Created on first read. */
export async function getExtensionToken(): Promise<string> {
  const { extensionToken } = await loadSettings();
  if (extensionToken) return extensionToken;
  const t = randomBytes(32).toString("hex");
  await saveSetting("extensionToken", t);
  return t;
}

export async function regenerateExtensionToken(): Promise<string> {
  const t = randomBytes(32).toString("hex");
  await saveSetting("extensionToken", t);
  return t;
}

/** Null when the request carries the right token, otherwise the 401 response to return. */
export async function denyUnlessExtension(req: Request): Promise<NextResponse | null> {
  const got = Buffer.from(req.headers.get("x-jobfinder-token") ?? "");
  const want = Buffer.from(await getExtensionToken());
  if (got.length !== want.length || !timingSafeEqual(got, want)) return NextResponse.json({ error: "Bad or missing extension token" }, { status: 401 });
  return null;
}
