import { readFile } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SecretError extends Error {
  constructor(
    readonly secret: string,
    readonly reason: "invalid_name" | "missing" | "unreadable" | "empty",
  ) {
    super(`secret "${secret}": ${reason}`);
    this.name = "SecretError";
  }
}

export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GANTRY_SECRETS_DIR && env.GANTRY_SECRETS_DIR.length > 0 ? env.GANTRY_SECRETS_DIR : "/run/secrets";
}

/**
 * Reads /run/secrets/<name> (or $GANTRY_SECRETS_DIR/<name>). Throws SecretError: a missing secret is a
 * deployment bug, not an expected runtime outcome. Strips one trailing newline only.
 */
export async function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!NAME.test(name)) throw new SecretError(name, "invalid_name");
  let raw: string;
  try {
    raw = await readFile(join(secretsDir(env), name), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new SecretError(name, code === "ENOENT" ? "missing" : "unreadable");
  }
  const value = raw.replace(/\r?\n$/, "");
  if (value.length === 0) throw new SecretError(name, "empty");
  return value;
}

/** Like readSecret, but an absent or empty secret is `null` (an optional feature that is simply off). */
export async function readSecretOptional(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    return await readSecret(name, env);
  } catch (e) {
    if (e instanceof SecretError && (e.reason === "missing" || e.reason === "empty")) return null;
    throw e;
  }
}
