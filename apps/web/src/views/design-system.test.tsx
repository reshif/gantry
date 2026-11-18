import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignIn } from "../shell/SignIn";
import { DataTable } from "../ui/DataTable";
import { mockApi, mount, resetApp } from "./floor/testkit";
import DesignSystem from "./design-system";

beforeEach(resetApp);
afterEach(cleanup);

describe("Sign-in card", () => {
  it("is one centred main.signin card with the brand label, MFA note, theme button and skip link", () => {
    const { container } = render(<SignIn config={null} />);
    expect(container.querySelector("main.signin#main > .panel")).toBeTruthy();
    expect(container.querySelector(".auth-wrap, .auth-brand")).toBeNull();
    expect(screen.getByText("SOFTWARE FACTORY · SIGN-IN SHEET")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Gantry");
    expect(screen.getByText(/MFA is required for admins\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Theme" })).toBeTruthy();
    expect(container.querySelector('a.skip[href="#main"]')).toBeTruthy();
  });
  it("is a form with Work email, Password, a Sign in submit and an SSO button, like the prototype", () => {
    const { container } = render(<SignIn config={null} />);
    expect(container.querySelector("main.signin > form.panel")).toBeTruthy();
    expect(screen.getByLabelText("Work email")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).type).toBe("submit");
    expect(screen.getByRole("button", { name: "Continue with Okta SSO" })).toBeTruthy();
  });
  it("prefills the demo account email when development sign-in is on, and shows the MFA step in the same card", () => {
    const { unmount } = render(<SignIn config={{ demoAccounts: true }} />);
    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("asha@acme.dev");
    unmount();
    const { container } = render(<SignIn config={null} needs="mfa_setup" />);
    expect(container.querySelector("main.signin > form.panel svg.brand-mark")).toBeTruthy();
    expect(screen.getByText("Set up two-step sign-in")).toBeTruthy();
  });
  it("shows a sign-in failure as a bad callout", () => {
    render(<SignIn config={null} error="denied" />);
    expect(within(screen.getByRole("alert")).getByText("denied")).toBeTruthy();
  });
});

describe("Design system tokens", () => {
  it("forces paper tokens on the light scope whatever the app theme", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles/views/design-system.css", "utf8");
    expect(css).toMatch(/\[data-scope="light"\][^}]*--bg:#f2f0e9/);
  });
});

describe("DataTable pager", () => {
  it("pages with Prev / Next and an a-b of n range", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ id: String(n) }));
    render(<DataTable id="t" rows={rows} rowKey={(r) => r.id} pageSize={3} pager="pages" columns={[{ key: "id", label: "Id", render: (r) => r.id }]} />);
    expect(screen.getByText("1–3 of 5")).toBeTruthy();
    expect(screen.getByText("Page 1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("4–5 of 5")).toBeTruthy();
  });
});

describe("Design system sheet", () => {
  it("has the prototype's panels, validate, palette and states", async () => {
    mockApi();
    const { container } = mount(<DesignSystem />);
    for (const t of ["Floor vocabulary", "States", "Overlays", "Form fields", "Data display"]) expect(await screen.findAllByRole("region", { name: t })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Palette" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Icon button" })).toHaveLength(2);
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
    expect(container.querySelector('a.pri[href="#/agents/ag-intake"]')).toBeTruthy();
    expect(container.querySelector('tr.rowtr a.pri[href="#/agents/ag-intake"]')).toBeTruthy();
    expect(container.querySelectorAll(".sorthint").length).toBeGreaterThan(0);
    expect(container.querySelector(".dtable-sortsel")).toBeNull();
    expect(container.querySelector(".field-req")).toBeNull();
    expect(container.querySelector("label.check .switch")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Validate" })[0]!);
    expect(screen.getByText("Title is required.")).toBeTruthy();
    expect(screen.getByText("All lines")).toBeTruthy();
  });
});

describe("Design system gallery", () => {
  it("the tab strip is a static sample: clicking a tab does not select it; the sparkline is a plain line; loading shows three bars", () => {
    mockApi();
    const { container } = mount(<DesignSystem />);
    const tab = screen.getAllByRole("tab", { name: /Configuration/ })[0]!;
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelectorAll(".spark-area")).toHaveLength(0);
    expect(container.querySelector('[aria-label="Loading"]')?.querySelectorAll(".skel")).toHaveLength(3);
  });
});

describe("Design system scopes and account menu", () => {
  it("each scope re-points the legacy ink alias so ghost buttons stay legible; the account menu entry is My account", async () => {
    mockApi();
    const { container } = mount(<DesignSystem />);
    for (const sc of Array.from(container.querySelectorAll("[data-scope]"))) expect((sc as HTMLElement).style.getPropertyValue("--ink-2")).toBe("var(--ink2)");
    const { readFileSync } = await import("node:fs");
    const top = readFileSync("src/shell/TopBar.tsx", "utf8");
    expect(top).toContain('label: "My account"');
    expect(top).toContain('navigate("person", v.id)');
  });
});
