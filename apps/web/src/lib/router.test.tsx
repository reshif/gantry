import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { formatHash, hashQuery, parseHash, useHash, navigate, navigateProject } from "./router";
import { updatePrefs } from "./prefs";
import { resolveRoute, canSeeRoute, pickProject, ROUTES } from "./routes";
import type { Me } from "../api/types";

const person = (roles: Array<{ role: string; scope: string }>) =>
  ({ id: "p1", name: "T", title: "", email: "t@x", teams: [], roles, status: "active", oncall: false, github: "", away: null }) as unknown as Me["person"];
const meWith = (roles: Array<{ role: string; scope: string }>, projects = ["payments"]): Me =>
  ({ person: person(roles), session: { id: "s1" }, csrf: "c", projects: projects.map((id) => ({ id, name: id })), factory: { killed: null }, config: { demoAccounts: false } }) as unknown as Me;

describe("hash parsing", () => {
  it("parses ids and params like legacy hashes", () => {
    expect(parseHash("#home")).toEqual({ id: "home", param: null, project: null, q: {} });
    expect(parseHash("#record/WO-1042")).toEqual({ id: "record", param: "WO-1042", project: null, q: {} });
    expect(parseHash("#/floor")).toEqual({ id: "floor", param: null, project: null, q: {} });
    expect(parseHash("")).toEqual({ id: "", param: null, project: null, q: {} });
    expect(parseHash("#record/a%2Fb")).toEqual({ id: "record", param: "a/b", project: null, q: {} });
    expect(parseHash("#/evals?tab=suites")).toEqual({ id: "evals", param: "suites", project: null, q: { tab: "suites" } });
    expect(parseHash("#/trust?tab=rules&x=1")).toEqual({ id: "trust", param: "rules", project: null, q: { tab: "rules", x: "1" } });
    expect(parseHash("#evals/factory")).toEqual({ id: "evals", param: "factory", project: null, q: {} });
    expect(parseHash("#/integrations?tab=catalogue")).toEqual({ id: "integrations", param: "catalogue", project: null, q: { tab: "catalogue" } });
    expect(parseHash("#/mcp/mcp-docs?tab=tools")).toEqual({ id: "mcp", param: "mcp-docs", project: null, q: { tab: "tools" } });
    expect(parseHash("#/security?tab=sessions")).toEqual({ id: "security", param: "sessions", project: null, q: { tab: "sessions" } });
    expect(ROUTES.find((r) => r.id === "audit")?.title).toBe("Audit ledger");
  });
  it("ignores a query on the hash: #/p/x/floor?view=board is the floor route", () => {
    expect(parseHash("#/p/payments/floor?view=board")).toEqual({ id: "floor", param: null, project: "payments", q: { view: "board" } });
    expect(parseHash("#/floor?density=detail")).toEqual({ id: "floor", param: null, project: null, q: { density: "detail" } });
    expect(hashQuery("#/floor?density=detail")).toBe("?density=detail");
    expect(hashQuery("#/floor")).toBe("");
  });
  it("reads the hash query (#models?tab=prices) without it leaking into the id or param", () => {
    expect(parseHash("#/models?tab=prices")).toEqual({ id: "models", param: null, project: null, q: { tab: "prices" } });
    expect(parseHash("#/agents/ag-build?tab=skills&x=1")).toEqual({ id: "agents", param: "ag-build", project: null, q: { tab: "skills", x: "1" } });
  });

  it("parses and formats project routes", () => {
    expect(parseHash("#/p/payments/floor")).toEqual({ id: "floor", param: null, project: "payments", q: {} });
    expect(parseHash("#/p/pay%20x/record/WO-1")).toEqual({ id: "record", param: "WO-1", project: "pay x", q: {} });
    expect(formatHash("record", "WO-1", "payments")).toBe("#/p/payments/record/WO-1");
  });
  it("navigate puts the remembered project into project routes only", () => {
    updatePrefs({ project: "risk" });
    navigate("floor");
    expect(window.location.hash).toBe("#/p/risk/floor");
    navigate("agents");
    expect(window.location.hash).toBe("#agents");
    navigateProject("payments", "work-orders");
    expect(window.location.hash).toBe("#/p/payments/work-orders");
  });
  it("formats hashes without a slash prefix", () => {
    expect(formatHash("floor")).toBe("#floor");
    expect(formatHash("record", "WO-1042")).toBe("#record/WO-1042");
  });
});

describe("useHash", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  it("follows hashchange", async () => {
    const Probe = () => {
      const h = useHash();
      return <p>{`${h.id}|${h.param ?? ""}`}</p>;
    };
    render(<Probe />);
    expect(screen.getByText("|")).toBeTruthy();
    await act(async () => {
      navigate("record", "WO-1042");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByText("record|WO-1042")).toBeTruthy();
  });
});

describe("route table", () => {
  it("has the 30 routes in legacy order, with the person and account pages beside People, and Agents at work before them in Overview", () => {
    expect(ROUTES.map((r) => r.id)).toEqual([
      "home", "inbox", "projects", "workspace", "console", "floor", "work-orders", "conversations", "onboarding", "project-config", "record", "traveler", "changes", "dossier", "agents", "skills", "models",
      "evals", "trust", "learning", "integrations", "notifications", "mcp", "api", "people", "person", "account", "workload", "access", "security", "audit", "system", "design-system",
    ]);
  });
  it("applies role rules from me", () => {
    const eng = meWith([{ role: "engineer", scope: "payments" }]);
    const admin = meWith([{ role: "factory_admin", scope: "factory" }]);
    const lead = meWith([{ role: "line_lead", scope: "payments" }]);
    expect(canSeeRoute("agents", eng)).toBe(false);
    expect(canSeeRoute("agents", lead)).toBe(true);
    expect(canSeeRoute("access", lead)).toBe(false);
    expect(canSeeRoute("access", admin)).toBe(true);
    expect(canSeeRoute("trust", meWith([{ role: "approver", scope: "payments" }]))).toBe(true);
    expect(canSeeRoute("home", eng)).toBe(true);
    // Factory-wide pages follow the server: factory-level roles at factory scope only, never a project admin (display only; the server decides).
    const pa = meWith([{ role: "project_admin", scope: "payments" }]);
    for (const id of ["access", "security", "system", "models"]) {
      expect(canSeeRoute(id, pa), id).toBe(false);
      expect(canSeeRoute(id, meWith([{ role: "project_admin", scope: "factory" }])), id).toBe(false);
      for (const role of ["factory_admin", "auditor", "factory_manager", "security_reviewer"]) expect(canSeeRoute(id, meWith([{ role, scope: "factory" }])), `${id} ${role}`).toBe(true);
    }
  });
  it("hides project routes when no project is visible", () => {
    expect(canSeeRoute("floor", meWith([{ role: "factory_admin", scope: "factory" }], []))).toBe(false);
  });
  it("audit follows the resolved permission, else roles", () => {
    const sam = meWith([{ role: "auditor", scope: "factory" }]);
    expect(canSeeRoute("audit", sam, { canAudit: false })).toBe(false);
    expect(canSeeRoute("audit", sam, { canAudit: true })).toBe(true);
    expect(canSeeRoute("audit", sam)).toBe(true);
    expect(canSeeRoute("audit", meWith([{ role: "project_admin", scope: "payments" }]), { canAudit: false })).toBe(true);
  });
  it("falls back to home for unknown or hidden routes", () => {
    const eng = meWith([{ role: "engineer", scope: "payments" }]);
    expect(resolveRoute("nope", eng)).toEqual({ id: "home", denied: null });
    const r = resolveRoute("security", eng);
    expect(r.id).toBe("home");
    expect(r.denied?.id).toBe("security");
    expect(resolveRoute("floor", eng).id).toBe("floor");
  });
  it("keeps a visible stored project, else the first", () => {
    const me = meWith([{ role: "engineer", scope: "payments" }], ["payments", "risk"]);
    expect(pickProject(me, "risk")).toBe("risk");
    expect(pickProject(me, "gone")).toBe("payments");
    expect(pickProject(me, null)).toBe("payments");
  });
});
