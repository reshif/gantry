import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";

async function secrets(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gantry-worker-cfg-"));
  for (const [k, v] of Object.entries({ launcher_token: "l", github_token: "g", ...files })) await writeFile(join(dir, k), `${v}\n`);
  return dir;
}

describe("worker config: SMTP", () => {
  it("logs in to the relay when SMTP_USER is set and the smtp_password secret exists", async () => {
    const dir = await secrets({ smtp_password: "relay-pass" });
    const cfg = await loadWorkerConfig({ GANTRY_SECRETS_DIR: dir, SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "gantry@example.com", SMTP_FROM: "Gantry <gantry@example.com>" });
    expect(cfg.smtp).toEqual({ host: "smtp.example.com", port: 587, from: "Gantry <gantry@example.com>", secure: false, auth: { user: "gantry@example.com", pass: "relay-pass" } });
  });

  it("sends without a login when no SMTP_USER is set (a local relay)", async () => {
    const dir = await secrets({ smtp_password: "unused" });
    const cfg = await loadWorkerConfig({ GANTRY_SECRETS_DIR: dir, SMTP_HOST: "mailpit" });
    expect(cfg.smtp.auth).toBeUndefined();
  });

  it("sends without a login when SMTP_USER is set but there is no password file", async () => {
    const dir = await secrets({});
    const cfg = await loadWorkerConfig({ GANTRY_SECRETS_DIR: dir, SMTP_HOST: "smtp.example.com", SMTP_USER: "u" });
    expect(cfg.smtp.auth).toBeUndefined();
  });
});
