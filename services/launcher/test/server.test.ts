import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RunManager } from "../src/manager.js";
import { bearerMatches, buildServer } from "../src/server.js";

const cfgR = loadConfig({});
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const TOKEN = "t".repeat(40);
// Requests in this file are rejected before the manager touches Docker.
const app = buildServer({ cfg: cfgR.value, manager: new RunManager(new Docker({ socketPath: "/nonexistent.sock" }), cfgR.value), token: TOKEN, logger: false });
const auth = { authorization: `Bearer ${TOKEN}` };

describe("bearer auth", () => {
  it("compares tokens exactly", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
  it.each([["GET", "/v1/runs"], ["POST", "/v1/runs"], ["DELETE", "/v1/runs/x"]] as const)("401 without a token on %s %s", async (method, url) => {
    const r = await app.inject({ method, url });
    expect(r.statusCode).toBe(401);
    const r2 = await app.inject({ method, url, headers: { authorization: "Bearer wrong" } });
    expect(r2.statusCode).toBe(401);
  });
});

describe("validation", () => {
  it("422 on a body with extra fields", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: { runId: "a", workspaceRef: "w", variant: "base", runToken: "x".repeat(20), Privileged: true } });
    expect(r.statusCode).toBe(422);
  });
  it("422 on a variant outside the allow-list", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: { runId: "a", workspaceRef: "w", variant: "nope", runToken: "x".repeat(20) } });
    expect(r.statusCode).toBe(422);
  });
  it("422 on a malformed run id for stop", async () => {
    const r = await app.inject({ method: "DELETE", url: "/v1/runs/..%2Fetc", headers: auth });
    expect(r.statusCode).toBe(422);
  });

  it("accepts an empty JSON body on DELETE (reaches the manager, not a 400)", async () => {
    // The manager cannot reach Docker here, so a request that passes parsing and validation fails with 5xx, never 400.
    const r = await app.inject({ method: "DELETE", url: "/v1/runs/x", headers: { ...auth, "content-type": "application/json" } });
    expect(r.statusCode).not.toBe(400);
    expect(r.statusCode).not.toBe(422);
  });
  it("400 on malformed JSON", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: { ...auth, "content-type": "application/json" }, payload: "{nope" });
    expect(r.statusCode).toBe(400);
  });
});
