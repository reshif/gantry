import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "@gantry/db";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: Buffer, s: string): string => createHmac("sha256", key).update(s).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Constant-time string equality (compares digests, so length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Seals a small JSON value for a cookie (AES-256-GCM, see @gantry/db crypto). */
export const seal = (value: unknown, key: Buffer, aad: string): string => encrypt(JSON.stringify(value), key, aad);

export function unseal<T>(token: string | undefined, key: Buffer, aad: string): T | null {
  if (!token) return null;
  const r = decrypt(token, key, aad);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return null;
  }
}
