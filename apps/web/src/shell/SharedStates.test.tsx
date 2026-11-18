import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hashQuery, parseHash } from "../lib/router";
import { NotFoundPage, SharedStatePage, sharedStateFromUrl, SHARED_STATES } from "./SharedStates";
import { SignIn, emailProblem, signInFootnote } from "./SignIn";

describe("hash query and shared states", () => {
  it("keeps the route clean when the hash carries ?state=", () => {
    expect(parseHash("#/p/payments/floor?state=loading")).toEqual({ id: "floor", param: null, project: "payments" });
    expect(hashQuery("#/p/payments/floor?state=empty", "").get("state")).toBe("empty");
    expect(sharedStateFromUrl("#floor?state=conflict", "")).toBe("conflict");
    expect(sharedStateFromUrl("#floor?state=nope", "")).toBeNull();
    expect(sharedStateFromUrl("#floor", "?state=error")).toBe("error");
  });
  it("draws every state the prototype draws", () => {
    const want: Record<string, string> = { loading: "Loading…", empty: "Nothing here yet", error: "This view failed to load", forbidden: "You do not have access to this", conflict: "Conflict." };
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
});
