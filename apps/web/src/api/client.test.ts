import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, buildUrl, command, get, setCsrfToken } from "./client";
import { ops, loginUrl } from "./ops";

type Call = { url: string; init: RequestInit };
let calls: Call[];
function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
}
const header = (c: Call | undefined, name: string) => (c?.init.headers as Record<string, string> | undefined)?.[name];

beforeEach(() => setCsrfToken("tok"));
afterEach(() => vi.unstubAllGlobals());

describe("command", () => {
  it("sends cookies, the CSRF header and a JSON body; returns ok with extras", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "Done.", id: "WO-9" } }));
    const r = await command("/api/v1/x", { method: "POST", body: { a: 1 } });
    expect(r).toEqual({ ok: true, msg: "Done.", id: "WO-9", status: 200 });
    const c = calls[0];
    expect(c?.init.credentials).toBe("include");
    expect(header(c, "X-CSRF-Token")).toBe("tok");
    expect(c?.init.body).toBe('{"a":1}');
  });

  it("adds an Idempotency-Key on creates only, and honours a supplied key", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await command("/api/v1/x", { method: "POST", idempotent: true });
    await command("/api/v1/x", { method: "POST" });
    await command("/api/v1/x", { method: "POST", idempotent: "k-1" });
    expect(header(calls[0], "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(header(calls[1], "Idempotency-Key")).toBeUndefined();
    expect(header(calls[2], "Idempotency-Key")).toBe("k-1");
  });

  it("sends If-Match", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await command("/api/v1/x", { method: "PATCH", ifMatch: 7 });
    expect(header(calls[0], "If-Match")).toBe("7");
  });

  it.each([
    [403, "No.", { kind: "matrix", id: "r" }, "Factory Admin"],
    [409, "Stale.", { kind: "stop", id: "s" }, undefined],
    [422, "Bad input.", undefined, undefined],
  ])("returns a %i refusal as a value with rule and needs", async (status, msg, rule, needs) => {
    mockFetch(() => ({ status, body: { ok: false, msg, rule, needs } }));
    const r = await command("/api/v1/x", { method: "POST" });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status, msg });
    if (!r.ok) {
      expect(r.rule).toEqual(rule);
      expect(r.needs).toBe(needs);
    }
  });

  it("does not throw on network failure or a non-JSON 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await command("/api/v1/x", { method: "POST" })).toMatchObject({ ok: false, status: 0 });
    mockFetch(() => ({ status: 502, body: undefined }));
    expect(await command("/api/v1/x", { method: "POST" })).toMatchObject({ ok: false, status: 502 });
  });

  it("fetches the CSRF token from /me when none is held", async () => {
    setCsrfToken(null);
    mockFetch((url) => (url.endsWith("/me") ? { body: { csrf: "fresh" } } : { body: { ok: true, msg: "" } }));
    await command("/api/v1/x", { method: "POST" });
    expect(calls[0]?.url).toBe("/api/v1/me");
    expect(header(calls[1], "X-CSRF-Token")).toBe("fresh");
  });
});

describe("get", () => {
  it("builds query strings, skipping empty values", () => {
    expect(buildUrl("/api/v1/audit", { category: "kill", q: "", actor: undefined, limit: 5 })).toBe("/api/v1/audit?category=kill&limit=5");
  });
  it("throws ApiError with the status on non-2xx", async () => {
    mockFetch(() => ({ status: 404, body: { ok: false, msg: "No such work order." } }));
    await expect(get("/api/v1/work-orders/x")).rejects.toMatchObject({ name: "ApiError", status: 404, message: "No such work order." });
    await expect(get("/api/v1/work-orders/x")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("ops mapping", () => {
  it("maps a creation to its endpoint with an idempotency key", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "Submitted." } }));
    await ops.submitWO({ project: "payments", repo: "r", title: "t" }, "web");
    expect(calls[0]?.url).toBe("/api/v1/projects/payments/work-orders");
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], "Idempotency-Key")).toBeTruthy();
  });
  it("routes approvers.* to the approvers endpoint and other paths to config", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await ops.setProject("p1", "approvers.G2", { roles: ["approver"] });
    await ops.setProject("p1", "budget.monthly", 5000);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["PUT /api/v1/projects/p1/approvers/G2", "PATCH /api/v1/projects/p1/config"]);
  });
  it("uses PUT to add and DELETE to remove a member role", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await ops.setMemberRole("u-ana", "p1", "reviewer", true);
    await ops.setMemberRole("u-ana", "p1", "reviewer", false);
    expect(calls.map((c) => c.init.method)).toEqual(["PUT", "DELETE"]);
  });
  it("sends dry_run for the move check and If-Match for versioned moves", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await ops.moveCheck("WO-1", "S3");
    await ops.moveTo("WO-1", "S3", "r", "web", { ifMatch: 4 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ target: "S3", dry_run: true });
    expect(header(calls[1], "If-Match")).toBe("4");
  });
  it("A8: a reject names the instance it was shown; a refusal for a stale or missing pin keeps the current instance and says nothing was decided", async () => {
    mockFetch((url) => (url.endsWith("%3A3/reject") ? { body: { ok: true, msg: "Rejected." } } : { status: 428, body: { ok: false, msg: "Say which opening you are deciding.", needs: "gate instance", current: { instance: "WO-7:G2:5", n: 5, gate: "G2", wo: "WO-7" } } }));
    const sent = await ops.rejectGate("WO-7", "G2", "WO-7:G2:3", "Not enough tests");
    expect(calls[0]?.url).toBe("/api/v1/gate-instances/WO-7%3AG2%3A3/reject");
    expect(sent.ok).toBe(true);
    const bare = await ops.approveGate("WO-7", "G2", undefined);
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.status).toBe(428);
      expect(bare.kind).toBe("conflict");
      expect(bare.current).toMatchObject({ instance: "WO-7:G2:5" });
      expect(bare.msg).toMatch(/It is now at instance 5\. Nothing was decided\./);
    }
  });
  it("addresses gate instances and stops by the documented id conventions", async () => {
    mockFetch(() => ({ body: { ok: true, msg: "" } }));
    await ops.approveGate("WO-1042", "G3", "WO-1042:G3:4");
    await ops.resumeProject("payments");
    expect(calls[0]?.url).toBe("/api/v1/gate-instances/WO-1042%3AG3%3A4/approve");
    expect(calls[1]?.url).toBe("/api/v1/stops/project%3Apayments");
  });
  it("builds sign-in URLs", () => {
    expect(loginUrl("sso")).toBe("/auth/login?method=sso");
    expect(loginUrl("github")).toBe("/auth/login?method=github");
    expect(loginUrl("sso", "asha@acme.dev")).toBe("/auth/login?login_hint=asha%40acme.dev");
    expect(loginUrl("sso", undefined, "#/floor")).toBe("/auth/login?method=sso&return_to=%2F%23%2Ffloor");
  });
});

describe("background marker for the idle clock", () => {
  it("reads after a minute without input carry X-Gantry-Background; input clears it; writes never carry it", async () => {
    vi.useFakeTimers();
    try {
      mockFetch(() => ({ body: {} }));
      await get("/api/v1/x");
      expect(header(calls[0], "X-Gantry-Background")).toBeUndefined();
      vi.advanceTimersByTime(61_000);
      await get("/api/v1/x");
      expect(header(calls[1], "X-Gantry-Background")).toBe("1");
      await command("/api/v1/x", { method: "POST", body: {} });
      expect(header(calls[calls.length - 1], "X-Gantry-Background")).toBeUndefined();
      window.dispatchEvent(new Event("pointerdown"));
      await get("/api/v1/x");
      expect(header(calls[calls.length - 1], "X-Gantry-Background")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
