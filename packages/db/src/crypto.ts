import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { err, ok, type Result } from "./result.js";
import { readSecret } from "./secrets.js";

/** Envelope: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>` (AES-256-GCM, 96-bit random iv). */
const VERSION = "v1";

export type DecryptError = "malformed" | "unsupported_version" | "authentication_failed";

export function parseDataKey(text: string): Result<Buffer, "bad_key"> {
  const t = text.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  return buf.length === 32 ? ok(buf) : { ok: false, error: "bad_key" };
}

/** Loads the 32-byte data key from the `data_key` secret (hex or base64). */
export async function loadDataKey(env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  const parsed = parseDataKey(await readSecret("data_key", env));
  if (!parsed.ok) throw new Error("data_key must be 32 bytes, hex or base64 encoded");
  return parsed.value;
}

/** `aad` binds the ciphertext to its row (e.g. `vendors:anthropic`), so it cannot be moved to another row. */
export function encrypt(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(envelope: string, key: Buffer, aad?: string): Result<string, DecryptError> {
  const parts = envelope.split(".");
  if (parts.length !== 4) return err("malformed");
  const [version, ivS, tagS, ctS] = parts as [string, string, string, string];
  if (version !== VERSION) return err("unsupported_version");
  const iv = Buffer.from(ivS, "base64url");
  const tag = Buffer.from(tagS, "base64url");
  if (iv.length !== 12 || tag.length !== 16) return err("malformed");
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    if (aad !== undefined) d.setAAD(Buffer.from(aad, "utf8"));
    return ok(Buffer.concat([d.update(Buffer.from(ctS, "base64url")), d.final()]).toString("utf8"));
  } catch {
    return err("authentication_failed");
  }
}

/** Masked form for display, e.g. `sk-ant-••••••••3f9a`. Reveals at most the last four characters, and none for short values. */
export function mask(secret: string): string {
  if (secret.length < 12) return "••••••••";
  const prefixMatch = /^[A-Za-z]+-(?:[A-Za-z]+-)?/.exec(secret);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  return `${prefix}••••••••${secret.slice(-4)}`;
}

/** Short stable fingerprint (first 12 hex of sha256) for audit rows that must not hold the secret. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}
