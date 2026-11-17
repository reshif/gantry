import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import { ROUTES } from "../lib/routes";
import SystemView from "./system";

const NOW = Date.now();
const HEALTH = {
  at: new Date(NOW).toISOString(),
  services: [
    { id: "api", name: "API", status: "ok", detail: "Answering this request.", latencyMs: null },
    { id: "edge", name: "Edge gateway", status: "ok", detail: "Answering.", latencyMs: 4 },
    { id: "launcher", name: "Run launcher", status: "down", detail: "No answer.", latencyMs: null },
    { id: "github", name: "GitHub broker", status: "degraded", detail: "GitHub App is not configured", latencyMs: 5 },
  ],
  backup: { status: "stale", at: new Date(NOW - 30 * 3_600_000).toISOString(), ageHours: 30, set: "s1", detail: "The newest backup is 30 hours old." },
  drill: { status: "unknown", at: null, ageHours: null, set: null, seconds: null, failedChecks: 0, detail: "No restore drill has been recorded yet." },
  outbox: { counts: { pending: 2, sending: 0, delivered: 40, dead: 1 }, oldestPendingSeconds: 90, dead: [{ id: "ob-1", destination: "slack", attempts: 8, maxAttempts: 8, lastError: "HTTP 500 from slack", createdAt: new Date(NOW - 7200_000).toISOString(), failedAt: new Date(NOW - 3600_000).toISOString() }] },
  jobs: { counts: { queued: 1, running: 2, done: 9, dead: 0 }, runningLongMinutes: 120, stuck: [{ id: "j1", queue: "flow", kind: "flow.advance", attempts: 1, maxAttempts: 5, owner: "w1", startedAt: new Date(NOW - 600_000).toISOString(), leaseUntil: new Date(NOW - 300_000).toISOString(), reason: "lease_expired", lastError: null }] },
};

function setup(o: { health?: object; status?: number; denied?: string[] } = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname });
    if (u.pathname === "/api/v1/can") {
      const checks = (JSON.parse(String(init?.body)) as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (o.denied?.includes(c.action) ? { allowed: false, reason: "No role holds it.", needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
    }
    if (u.pathname === "/api/v1/system/health") return new Response(JSON.stringify(o.status && o.status >= 400 ? { ok: false, msg: "Needs integrations.view." } : (o.health ?? HEALTH)), { status: o.status ?? 200 });
    if (u.pathname === "/api/v1/system/outbox/ob-1/retry" && method === "POST") return new Response(JSON.stringify({ ok: true, msg: "Requeued the delivery to slack." }));
    return new Response(JSON.stringify({ ok: false, msg: `no mock ${method} ${u.pathname}` }), { status: 404 });
  }));
  return calls;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><SystemView /></OverlayProvider></QueryClientProvider>);
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("System health view", () => {
  it("is a Govern route behind the integrations read right", () => {
    expect(ROUTES.find((r) => r.id === "system")).toMatchObject({ group: "Govern", perm: "integrations.view" });
  });

  it("shows services, the stale-backup warning, an unknown drill, dead letters and stuck jobs", async () => {
    setup();
    mount();
    await byId("sys-stale");
    expect(document.getElementById("sys-stale")?.textContent).toContain("over 26 hours old");
    expect(document.querySelector("[data-service='launcher']")?.textContent).toContain("Down");
    expect(document.querySelector("[data-service='github']")?.textContent).toContain("Degraded");
    expect(document.querySelector("[data-service='api']")?.textContent).toContain("Up");
    expect(document.getElementById("sys-backup")?.textContent).toContain("Stale");
    expect(document.getElementById("sys-drill")?.textContent).toContain("Not run yet");
    expect(document.querySelector("tr[data-key='ob-1']")?.textContent).toContain("HTTP 500 from slack");
    expect(document.querySelector("tr[data-key='j1']")?.textContent).toContain("Lease expired");
    expect(document.body.textContent).toContain("Services2/4healthy");
  });

  it("shows no stale warning for a current backup and says nothing is stuck or dead", async () => {
    setup({ health: { ...HEALTH, backup: { ...HEALTH.backup, status: "ok", ageHours: 3 }, outbox: { ...HEALTH.outbox, counts: { ...HEALTH.outbox.counts, dead: 0 }, dead: [] }, jobs: { ...HEALTH.jobs, stuck: [] } } });
    mount();
    await byId("sys-dead-empty");
    await byId("sys-stuck-empty");
    expect(document.getElementById("sys-stale")).toBeNull();
  });

  it("retries one dead letter with a POST", async () => {
    const calls = setup();
    mount();
    fireEvent.click(await byId("sys-retry-ob-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/system/outbox/ob-1/retry")).toBe(true));
  });

  it("locks Retry for someone who may not edit integrations", async () => {
    const calls = setup({ denied: ["integration.edit"] });
    mount();
    const b = await byId("sys-retry-ob-1");
    await waitFor(() => expect(b.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(b);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/outbox/"))).toBe(false);
  });

  it("says Not visible to you when the read is refused", async () => {
    setup({ status: 403 });
    mount();
    await waitFor(() => expect(document.getElementById("sys-hidden")?.textContent).toContain("Not visible to you"));
  });
});
