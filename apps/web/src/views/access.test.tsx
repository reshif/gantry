import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import AccessView from "./access";

const person = { id: "p-asha", name: "Asha Raman", title: "Head", email: "a@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "a", away: null, mfa: true };
const ME = { person, session: { id: "s1", person: "p-asha", method: "sso", device: "x", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "", tz: "IST" }, projects: [{ id: "payments", name: "Payments" }], nav: [], badges: {} };

function setup(matrix: () => Response) {
  const hits = { matrix: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    if (u.pathname === "/api/v1/can") {
      const checks = (JSON.parse(String(init!.body)) as { checks: unknown[] }).checks;
      return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "", rule: { id: "ok" } })) }), { status: 200 });
    }
    if (key === "GET /api/v1/access/matrix") {
      hits.matrix++;
      return matrix();
    }
    const body: Record<string, unknown> = { "GET /api/v1/me": ME, "GET /api/v1/people": [person], "GET /api/v1/projects": [], "GET /api/v1/policies": [], "GET /api/v1/freezes": [], "GET /api/v1/projects/payments/repos": [] };
    if (key in body) return new Response(JSON.stringify(body[key]), { status: 200 });
    return new Response(JSON.stringify({ ok: false, msg: `no mock ${key}` }), { status: 404 });
  }));
  return hits;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><AccessView /></OverlayProvider></QueryClientProvider>);
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Access screen: load failure", () => {
  it("says the access matrix failed to load, with a retry, instead of an empty simulator", async () => {
    const hits = setup(() => new Response(JSON.stringify({ ok: false, msg: "Database is down." }), { status: 500 }));
    mount();
    fireEvent.click(await byId("acc-tab-check"));
    const err = await byId("acc-error");
    expect(err.textContent).toContain("Couldn't load the access matrix");
    expect(err.textContent).toContain("Database is down.");
    expect(document.getElementById("acc-sim-form")).toBeNull();
    const before = hits.matrix;
    fireEvent.click(await byId("acc-error-retry"));
    await waitFor(() => expect(hits.matrix).toBeGreaterThan(before));
  });
});
