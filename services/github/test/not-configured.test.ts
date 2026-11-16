import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { DirStore, startEnv } from "./harness.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function secrets(files: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "gh-secrets-")); dirs.push(dir);
  for (const [n, c] of Object.entries(files)) await writeFile(join(dir, n), c);
  return { GANTRY_SECRETS_DIR: dir };
}
const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
const JSON_OK = JSON.stringify({ appId: 12 });

describe("loadConfig without a usable GitHub App", () => {
  const cases: [string, Record<string, string>][] = [
    ["missing files", { github_token: "t" }],
    ["empty files", { github_token: "t", "github_app.json": "", "github_app.pem": "" }],
    ["malformed json", { github_token: "t", "github_app.json": "{nope", "github_app.pem": PEM }],
    ["appId unset", { github_token: "t", "github_app.json": "{}", "github_app.pem": PEM }],
    ["placeholder key", { github_token: "t", "github_app.json": JSON_OK, "github_app.pem": "placeholder" }],
  ];
  for (const [name, files] of cases) {
    it(`returns app:null for ${name}, with a reason that holds no secret`, async () => {
      const cfg = await loadConfig(await secrets(files));
      expect(cfg.app).toBeNull();
      expect(cfg.notConfiguredReason).toBeTruthy();
      expect(cfg.notConfiguredReason).not.toContain("placeholder");
      expect(cfg.githubToken).toBe("t");
    });
  }
  it("still fails when the service token is missing", async () => {
    await expect(loadConfig(await secrets({ "github_app.json": JSON_OK, "github_app.pem": PEM }))).rejects.toThrow(/github_token/);
  });
  it("loads a configured App", async () => {
    const cfg = await loadConfig(await secrets({ github_token: "t", "github_app.json": JSON_OK, "github_app.pem": PEM }));
    expect(cfg.app).toMatchObject({ appId: 12, baseUrl: "https://api.github.com" });
  });
});

describe("unconfigured broker", () => {
  it("serves healthz, requires the token, answers 503 on /v1/*, and never calls GitHub", async () => {
    const env = await startEnv();
    const cfg = { ...env.cfg, app: null, notConfiguredReason: "secret github_app.json is missing" };
    const { server } = await buildServer({ cfg, app: null, api: new ApiClient(cfg), store: new DirStore(join(env.root, "v2")), logger: false });
    try {
      const inj = (method: "GET" | "POST", url: string, headers: Record<string, string> = env.auth) => server.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
      const h = await inj("GET", "/healthz", {});
      expect(h.statusCode).toBe(200);
      expect(h.json()).toEqual({ ok: true, configured: false, reason: "secret github_app.json is missing" });
      for (const [m, u] of [["GET", "/v1/installation/repos"], ["POST", "/v1/reconcile"], ["POST", "/v1/publish"], ["GET", "/v1/deliveries"]] as const) {
        expect((await inj(m, u, {})).statusCode, u).toBe(401);
        const r = await inj(m, u);
        expect(r.statusCode, u).toBe(503);
        expect(r.json()).toEqual({ ok: false, code: "not_configured", msg: "GitHub App is not configured. Add the App ID and key in Integrations or deploy/secrets." });
      }
      expect(env.gh.requests.length).toBe(0);
    } finally { await server.close(); await env.close(); }
  });
  it("healthz reports configured:true when the App is set", async () => {
    const env = await startEnv();
    try { expect((await env.call("GET", "/healthz")).body).toMatchObject({ ok: true, configured: true }); } finally { await env.close(); }
  });
  it("rejects dot segments in repo names", async () => {
    const env = await startEnv();
    try {
      for (const repo of ["./x", "../x", "a/.", "a/..", "./.."]) expect((await env.call("GET", `/v1/protections?repo=${encodeURIComponent(repo)}`)).status, repo).toBe(422);
      expect((await env.call("GET", "/v1/protections?repo=acme/a.b")).status).not.toBe(422);
    } finally { await env.close(); }
  });
});
