import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { hashQuery, parseHash } from "../lib/router";
import { NotFoundPage, SharedStatePage, sharedStateFromUrl, SHARED_STATES } from "./SharedStates";
import { protoEyebrow } from "./SharedStates";
import { SignIn, emailProblem, signInFootnote } from "./SignIn";

const render = (ui: ReactElement) => rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe("ds round 3", () => {
  it("the forbidden state names the role and names a sample permission", () => {
    render(<SharedStatePage kind="forbidden" eyebrow="x" title="y" />);
    expect(screen.getByText(/Your role \(.+\) cannot open this area\./)).toBeTruthy();
    expect(screen.getByText(/people\.manage/)).toBeTruthy();
  });
  it("dialogs paint above their scrim so the pointer reaches them", () => {
    const css = readFileSync("src/styles/base.css", "utf8");
    expect(css).toMatch(/\.dlg-wrap > \.dlg \{[^}]*z-index: 1/);
  });
  it("the sample table stays a table at phone width", () => {
    const css = readFileSync("src/styles/cr/compat.css", "utf8");
    expect(css).toMatch(/\.ds-theme \.tw\.cards table\{display:table/);
  });
});

describe("hash query and shared states", () => {
  it("keeps the route clean when the hash carries ?state=", () => {
    expect(parseHash("#/p/payments/floor?state=loading")).toEqual({ id: "floor", param: null, project: "payments", query: "state=loading", state: "loading" });
    expect(hashQuery("#/p/payments/floor?state=empty", "").get("state")).toBe("empty");
    expect(sharedStateFromUrl("#floor?state=conflict", "")).toBe("conflict");
    expect(sharedStateFromUrl("#floor?state=nope", "")).toBeNull();
    expect(sharedStateFromUrl("#floor", "?state=error")).toBe("error");
  });
  it("draws every state the prototype draws", () => {
    const want: Record<string, string> = { loading: "Loading…", empty: "Nothing here yet", error: "This view failed to load", forbidden: "You do not have access to this", conflict: "Conflict.", notfound: "There is no “Floor” page" };
    for (const k of SHARED_STATES) {
      const { unmount } = render(<SharedStatePage kind={k} eyebrow="Project" title="Floor" />);
      expect(screen.getByText(want[k]!)).toBeTruthy();
      unmount();
    }
  });
  it("error offers Retry and Reload; empty links to the console; 404 goes Home", () => {
    const { unmount } = render(<SharedStatePage kind="error" eyebrow="x" title="y" />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    unmount();
    render(<NotFoundPage name="nope" />);
    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go Home" }).getAttribute("href")).toBe("#home");
  });
});

describe("sign-in", () => {
  it("follows the prototype copy and layout", () => {
    const { container } = render(<SignIn config={{ demoAccounts: false, idpName: "Okta", allowedDomain: "acme.dev", mfaRequiredForAdmins: true }} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("Use your company account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Okta" })).toBeTruthy();
    expect(screen.getByText("Work email")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Email me a sign-in link/ })).toBeTruthy();
    expect(screen.getByText("Access is limited to the acme.dev domain. MFA is required for admins.")).toBeTruthy();
    expect(container.querySelector("form#signin")).toBeTruthy();
    expect(container.querySelector(".belt-card .lanes .lane .tok.run .pr.p1")).toBeTruthy();
    expect(container.querySelector(".belt-card .tok.is-gate")).toBeTruthy();
  });
  it("falls back to SSO and states no domain the server did not name", () => {
    render(<SignIn config={{ demoAccounts: false }} />);
    expect(screen.getByRole("button", { name: "Continue with SSO" })).toBeTruthy();
    expect(signInFootnote({ demoAccounts: false })).not.toMatch(/limited to/);
  });
  it("validates the work email with the prototype messages", () => {
    expect(emailProblem("", "acme.dev")).toBe("Email is required.");
    expect(emailProblem("a@gmail.com", "acme.dev")).toBe("Use an acme.dev address.");
    expect(emailProblem("a@acme.dev", "acme.dev")).toBe("");
    render(<SignIn config={{ demoAccounts: false, emailLinkLogin: true, allowedDomain: "acme.dev" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(screen.getByRole("alert").textContent).toBe("Email is required.");
  });
  it("has no GitHub button, and the email button is enabled", () => {
    render(<SignIn config={{ demoAccounts: false, githubLogin: true }} />);
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Email me a sign-in link" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("shows the wrong-domain message", () => {
    render(<SignIn config={{ demoAccounts: false, allowedDomain: "acme.dev" }} />);
    fireEvent.change(document.getElementById("auth-email") as HTMLInputElement, { target: { value: "a@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(screen.getByRole("alert").textContent).toBe("Use an acme.dev address.");
  });
  it("maps shared-state eyebrows to the prototype groups", () => {
    expect(protoEyebrow("floor", "Project")).toBe("Operate");
    expect(protoEyebrow("projects", "Project")).toBe("Portfolio");
    expect(protoEyebrow("agents", "Agents")).toBe("Workforce");
  });
});
