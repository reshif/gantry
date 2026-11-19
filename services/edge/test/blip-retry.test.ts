import { describe, expect, it } from "vitest";
import { BLIP_BACKOFF_MS, causeOf, fetchRiding } from "../src/blip-retry.js";

const ok = (): Response => new Response("ok", { status: 200 });
const boom = (): Error => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });

describe("fetchRiding", () => {
  it("absorbs a drop of about 6 s by default", () => {
    expect(BLIP_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(6000);
  });
  it("fails twice then succeeds: one success, the failures are logged with their cause code", async () => {
    let n = 0;
    const seen: Array<{ code?: string; cause?: string }> = [];
    const res = await fetchRiding(async () => (++n <= 2 ? Promise.reject(boom()) : ok()), new AbortController().signal, (i) => seen.push(i), [1, 1, 1]);
    expect(res.status).toBe(200);
    expect(n).toBe(3);
    expect(seen.map((s) => s.code)).toEqual(["ETIMEDOUT", "ETIMEDOUT"]);
    expect(seen[0]!.cause).toContain("ETIMEDOUT");
  });
  it("gives up after the last backoff", async () => {
    let n = 0;
    await expect(fetchRiding(() => { n++; return Promise.reject(boom()); }, new AbortController().signal, () => undefined, [1, 1])).rejects.toThrow("fetch failed");
    expect(n).toBe(3);
  });
  it("never retries after an abort", async () => {
    const ac = new AbortController();
    let n = 0;
    await expect(fetchRiding(() => { n++; ac.abort(); return Promise.reject(boom()); }, ac.signal, () => undefined, [1, 1])).rejects.toThrow();
    expect(n).toBe(1);
  });
  it("stops waiting when aborted mid-backoff", async () => {
    const ac = new AbortController();
    let n = 0;
    setTimeout(() => ac.abort(), 20);
    const t = Date.now();
    await expect(fetchRiding(() => { n++; return Promise.reject(boom()); }, ac.signal, () => undefined, [10_000])).rejects.toThrow();
    expect(n).toBe(1);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it("never retries once a response exists, even an error status (statechart edge-blips: NoRetryAfterResponse)", async () => {
    let n = 0;
    const res = await fetchRiding(async () => { n++; return new Response("busy", { status: 503 }); }, new AbortController().signal, () => undefined, [1, 1, 1]);
    expect(res.status).toBe(503);
    expect(n).toBe(1);
  });
  it("makes at most 4 attempts with the default backoff and 2 with the fallback backoff (BoundedAttempts)", async () => {
    let n = 0;
    await expect(fetchRiding(() => { n++; return Promise.reject(boom()); }, new AbortController().signal, () => undefined, BLIP_BACKOFF_MS.map(() => 1))).rejects.toThrow();
    expect(n).toBe(4);
    n = 0;
    await expect(fetchRiding(() => { n++; return Promise.reject(boom()); }, new AbortController().signal, () => undefined, [1])).rejects.toThrow();
    expect(n).toBe(2);
  });
  it("causeOf carries only the message and the cause", () => {
    expect(causeOf(boom())).toEqual({ err: "fetch failed", code: "ETIMEDOUT", cause: "connect ETIMEDOUT" });
  });
});
