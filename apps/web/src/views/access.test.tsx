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
    const err = await byId("acc-matrix-error");
    expect(err.textContent).toContain("Couldn't load the access matrix");
    expect(err.textContent).toContain("Database is down.");
    expect(document.getElementById("acc-sim-form")).toBeNull();
    const before = hits.matrix;
    fireEvent.click(await byId("acc-matrix-error-retry"));
    await waitFor(() => expect(hits.matrix).toBeGreaterThan(before));
  });
});

describe("Access: Control room prototype layout (gov1)", () => {
  it("has the Matrix, Policies and Check access tabs without counts", async () => {
    setup(() => new Response(JSON.stringify({ matrix: {}, roles: [], actions: [], version: 1 }), { status: 200 }));
    mount();
    await byId("acc-tab-check");
    expect(Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.textContent)).toEqual(["Matrix", "Policies", "Check access"]);
  });
});

describe("Access: round 2 fixes (gov1)", () => {
  const MX = { matrix: { factory_admin: { "project.view": true }, viewer: { "project.view": true } }, roles: [{ id: "factory_admin", name: "Factory Admin", level: "factory" }, { id: "viewer", name: "Viewer", level: "project" }], actions: [{ id: "project.view", name: "View project", group: "Work", scope: "project" }, { id: "release", name: "Release", group: "Gates", scope: "project" }], version: 1 };
  it("the matrix card has no header buttons; roles are managed from a text link in its hint", async () => {
    setup(() => new Response(JSON.stringify(MX), { status: 200 }));
    window.history.replaceState(null, "", "/");
    mount();
    await byId("acc-matrix-card");
    expect(document.querySelector("#acc-matrix-card .card-h button")).toBeNull();
    expect(document.getElementById("acc-open-roles")).not.toBeNull();
    expect(document.getElementById("acc-add-role")).toBeNull();
  });

  it("Check access opens on the first person and first permission, with no hint paragraph", async () => {
    setup(() => new Response(JSON.stringify(MX), { status: 200 }));
    window.history.replaceState(null, "", "/?tab=check");
    mount();
    const person = (await byId("acc-sim-person")) as HTMLSelectElement;
    expect(person.value).toBe("p-asha");
    expect((document.getElementById("acc-sim-action") as HTMLSelectElement).value).toBe("project.view");
    expect(document.querySelector("#acc-check-card .hint")).toBeNull();
    window.history.replaceState(null, "", "/");
  });
});

