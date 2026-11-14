/** MCP credentials (spec 12.4, 5.3): sealed with the data key, AAD `mcp:<id>`. Rows, events and responses hold only the masked form. */
import { decrypt, encrypt, mask } from "@gantry/db";
import { invalid, refuse } from "../../core/errors.js";

const need = (dataKey: Buffer | null): Buffer => {
  if (!dataKey) throw refuse("conflict", "The data key is not configured, so secrets cannot be stored. Set up /run/secrets/data_key.");
  return dataKey;
};

export function sealSecret(dataKey: Buffer | null, id: string, secret: string): { enc: string; mask: string } {
  return { enc: encrypt(secret, need(dataKey), `mcp:${id}`), mask: mask(secret) };
}

export function openSecret(dataKey: Buffer | null, id: string, enc: string | null): string | null {
  if (!enc) return null;
  const r = decrypt(enc, need(dataKey), `mcp:${id}`);
  if (!r.ok) throw invalid("The stored credential cannot be opened with this install's data key.");
  return r.value;
}
