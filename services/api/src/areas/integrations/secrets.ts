/**
 * Integration secrets (spec 7.1, 5.3): every secret field of an instance is sealed with the data key into one envelope, a JSON object keyed by field key,
 * with the AAD `integration:<id>`. Rows, events and responses hold only the masked form of the first secret field.
 */
import { decrypt, encrypt, mask } from "@gantry/db";
import { invalid, refuse } from "../../core/errors.js";

export type SecretSet = Record<string, string>;

export function requireKey(dataKey: Buffer | null): Buffer {
  if (!dataKey) throw refuse("conflict", "The data key is not configured, so secrets cannot be stored. Set up /run/secrets/data_key.");
  return dataKey;
}

export function seal(dataKey: Buffer | null, id: string, secrets: SecretSet): { enc: string | null; mask: string } {
  const entries = Object.entries(secrets).filter(([, v]) => v !== "");
  if (!entries.length) return { enc: null, mask: "" };
  const key = requireKey(dataKey);
  return { enc: encrypt(JSON.stringify(Object.fromEntries(entries)), key, `integration:${id}`), mask: mask(entries[0]![1]) };
}

/** Opens an instance's secrets. A plain string (an earlier or hand-made value) is read as the one secret under `fallbackKey`. */
export function open(dataKey: Buffer | null, id: string, enc: string | null, fallbackKey: string): SecretSet {
  if (!enc) return {};
  const key = requireKey(dataKey);
  const r = [`integration:${id}`, undefined].map((aad) => decrypt(enc, key, aad)).find((x) => x.ok);
  if (!r || !r.ok) throw invalid("The stored secret cannot be opened with this install's data key.");
  const v = r.value.trim();
  if (v.startsWith("{")) {
    try {
      const j = JSON.parse(v) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, x]) => typeof x === "string")) as SecretSet;
    } catch {
      return { [fallbackKey]: v };
    }
  }
  return { [fallbackKey]: v };
}
