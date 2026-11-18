import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Owner decision 2026-11-19: the Factory Admin is universal and can override everywhere, never silently. */
d("Factory Admin: sole-admin factory restore", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("F: with only one active Factory Admin the factory is restored alone, with a reason, as an override; with two the approval stays two-person", async () => {
    const k = await w.call("p-asha", "POST", "/api/v1/stops", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY", inFlight: "hold" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const url = `/api/v1/stops/${encodeURIComponent("factory:")}/restore`;
    // two or more admins: the first restore is pending
    const first = await w.call("p-asha", "POST", url, { reason: "The incident is over" });
    expect(first.body.pending).toBe(true);
    // one admin left
    await w.q(`update role_assignments set revoked_at = now() where role_id = 'factory_admin' and person_id <> 'p-asha' and revoked_at is null`);
    const canNow = await w.call("p-asha", "POST", "/api/v1/can", { checks: [{ action: "restore.factory" }] });
    expect(canNow.body.results[0]).toMatchObject({ allowed: true, override: true });
    expect((await w.call("p-asha", "POST", url, { reason: "no" })).status).toBe(422);
    const r = await w.call("p-asha", "POST", url, { reason: "I am the only admin; the incident is over." });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ pending: false, override: true });
    expect((await w.q(`select 1 from stops where scope_type = 'factory' and lifted_at is null`)).length).toBe(0);
    const ev = (await w.events("restore")).at(-1);
    expect(ev?.after).toMatchObject({ override: true, text: "I am the only admin; the incident is over." });
  });
});
