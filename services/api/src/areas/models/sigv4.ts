/** AWS Signature Version 4 for a request with a known body, with node:crypto only (no SDK). Used to list Bedrock models. */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
  method: string;
  /** Full URL including the query string. */
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  /** Extra headers to sign (lower case names); `host` and `x-amz-date` are added. */
  headers?: Record<string, string>;
  body?: string;
  /** The signing time (tests fix it). */
  date?: Date;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string): Buffer => createHmac("sha256", key).update(s, "utf8").digest();
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function canonicalQuery(u: URL): string {
  return [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
}

/** The headers to send (including Authorization, x-amz-date and, with a session token, x-amz-security-token). */
export function signV4(i: SigV4Input): Record<string, string> {
  const u = new URL(i.url);
  const d = (i.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = d.slice(0, 8);
  const body = i.body ?? "";
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: u.host, "x-amz-date": d };
  if (i.sessionToken) headers["x-amz-security-token"] = i.sessionToken;
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  // Non-S3 services encode the (already encoded) path a second time.
  const path = u.pathname.split("/").map(enc).join("/") || "/";
  const canonical = [i.method.toUpperCase(), path, canonicalQuery(u), canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", d, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
