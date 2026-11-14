import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, fingerprint, loadDataKey, mask, parseDataKey } from "../src/crypto.js";
import { readSecret, SecretError } from "../src/secrets.js";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh iv each time", () => {
    const a = encrypt("sk-ant-secret-value", key);
    const b = encrypt("sk-ant-secret-value", key);
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-value");
    expect(decrypt(a, key)).toEqual({ ok: true, value: "sk-ant-secret-value" });
    expect(decrypt(encrypt("", key), key)).toEqual({ ok: true, value: "" });
    expect(decrypt(encrypt("héllo ✓", key), key)).toEqual({ ok: true, value: "héllo ✓" });
  });

  it("fails closed on a wrong key, tampering, wrong aad and malformed input", () => {
    const e = encrypt("v", key, "vendors:anthropic");
    expect(decrypt(e, key, "vendors:anthropic").ok).toBe(true);
    expect(decrypt(e, key, "vendors:openai")).toEqual({ ok: false, error: "authentication_failed" });
    expect(decrypt(e, key)).toEqual({ ok: false, error: "authentication_failed" });
    expect(decrypt(e, randomBytes(32), "vendors:anthropic")).toEqual({ ok: false, error: "authentication_failed" });
    const parts = e.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(decrypt(parts.join("."), key, "vendors:anthropic")).toEqual({ ok: false, error: "authentication_failed" });
    expect(decrypt("garbage", key)).toEqual({ ok: false, error: "malformed" });
    expect(decrypt(["v9", ...e.split(".").slice(1)].join("."), key)).toEqual({ ok: false, error: "unsupported_version" });
  });

  it("masks without revealing more than the last four characters", () => {
    expect(mask("sk-ant-api03-abcdefghij3f9a")).toBe("sk-ant-••••••••3f9a");
    expect(mask("short")).toBe("••••••••");
    expect(mask("abcdefghijklmnop")).toBe("••••••••mnop");
    expect(fingerprint("x")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("parses hex or base64 data keys of exactly 32 bytes", () => {
    expect(parseDataKey(key.toString("hex") + "\n")).toMatchObject({ ok: true });
    expect(parseDataKey(key.toString("base64"))).toMatchObject({ ok: true });
    expect(parseDataKey("abcd")).toEqual({ ok: false, error: "bad_key" });
  });
});

describe("secrets", () => {
  it("reads /run/secrets-style files from GANTRY_SECRETS_DIR and strips one trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gantry-sec-"));
    try {
      const env = { GANTRY_SECRETS_DIR: dir };
      await writeFile(join(dir, "db_password"), "pw with space \n");
      await writeFile(join(dir, "empty"), "\n");
      await writeFile(join(dir, "data_key"), randomBytes(32).toString("hex"));
      expect(await readSecret("db_password", env)).toBe("pw with space ");
      await expect(readSecret("missing", env)).rejects.toMatchObject({ reason: "missing" });
      await expect(readSecret("empty", env)).rejects.toMatchObject({ reason: "empty" });
      await expect(readSecret("../etc/passwd", env)).rejects.toBeInstanceOf(SecretError);
      await expect(readSecret("a/b", env)).rejects.toMatchObject({ reason: "invalid_name" });
      expect((await loadDataKey(env)).length).toBe(32);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
