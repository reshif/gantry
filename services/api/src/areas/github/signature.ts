import { createHmac, timingSafeEqual } from "node:crypto";

/** X-Hub-Signature-256 is `sha256=` + hex HMAC of the raw body under the webhook secret. Constant-time compare. */
export function verifyGithubSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const want = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(m[1]!, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export const signGithubBody = (raw: Buffer | string, secret: string): string => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
