import { PERSONAS, expect, fulfillJson, mockApi, open, test } from "./fixtures";

// Failure-path interception: the app must stay up and say what happened. Tests marked test.fail() document a defect that the
// production bar lists (frontend-production-bar.md); when the fix lands the test starts passing, test.fail() then fails the
// run, and the marker is removed in the same PR.

test("signed out: the sign-in screen is shown (401 from /me)", async ({ page }) => {
  await mockApi(page, { persona: null });
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#auth-sso")).toBeVisible();
});

test("/me 500 on first load: an alert with a retry, not a blank page", async ({ page }) => {
  await mockApi(page, { overrides: { me: (r) => fulfillJson(r, { ok: false, msg: "boom" }, 500) } });
  await open(page, "/");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
});

// R1 (P0): a failed refetch of /me must not unmount a signed-in app. The unit regression test belongs to the w0-robust track; this
// browser version is fixme until its trigger reproduces the unmount reliably (a focus refetch under the fake clock does not yet).
test.fixme("/me refetch failure keeps the signed-in app mounted", async ({ page }) => {
  let fail = false;
  let failedCalls = 0;
  await mockApi(page, {
    overrides: {
      me: (r) => {
        if (fail) failedCalls++;
        return fail ? fulfillJson(r, { ok: false }, 500) : fulfillJson(r, PERSONAS.admin.me);
      },
    },
  });
  await open(page, "/#home");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  fail = true;
  await page.clock.fastForward(120_000); // past staleTime, so the focus refetch really runs
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // the refetch (and its one retry) have failed; the app must still be there
  await expect.poll(() => failedCalls, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(500);
  await expect(page.getByRole("alert").filter({ hasText: /could not be reached/i })).toHaveCount(0);
  await expect(page.getByRole("navigation").first()).toBeVisible();
});

// A failed read is a real state inside the main region: the title says what could not be loaded (or that it is not visible),
// never a quiet empty list. The contrast test below is what proves the assertion can fail: the same view answered with an empty
// list shows its empty state and none of these titles.
const FAILED = /Couldn.t load agents|Not visible to you/;

for (const status of [403, 404, 429, 500]) {
  test(`a read answered ${status} is not shown as an empty list`, async ({ page }) => {
    await mockApi(page, { overrides: { agents: (r) => fulfillJson(r, { ok: false, msg: `status ${status}` }, status) } });
    await open(page, "/#agents");
    await expect(page.locator("#main").getByText(FAILED)).toBeVisible({ timeout: 10_000 });
  });
}

test("contrast: the same read answered 200 with an empty list is an empty state, not a failure", async ({ page }) => {
  await mockApi(page, { overrides: { agents: (r) => fulfillJson(r, []) } });
  await open(page, "/#agents");
  await expect(page.locator("#main")).not.toBeEmpty();
  await expect(page.locator("#main").getByText(FAILED)).toHaveCount(0);
});

// A write refused by the server (409 conflict, 422 validation) is a value the wizard shows inline in a role=alert, and the app
// stays up. Fills the real New project dialog on fixtures, then refuses the POST.
async function createProjectRefused(page: import("@playwright/test").Page, status: number, msg: string) {
  let posted = 0;
  await mockApi(page, { overrides: { "POST projects": (r) => { posted++; return fulfillJson(r, { ok: false, msg, code: status === 409 ? "conflict" : "invalid" }, status); } } });
  await open(page, "/#projects");
  await page.locator("#prj-new").click();
  await page.getByRole("textbox", { name: /^Name/ }).fill("Checkout Platform");
  await page.getByRole("textbox", { name: /^Key/ }).fill("CHK");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect.poll(() => posted).toBe(1);
  return page.getByRole("alert").filter({ hasText: msg });
}

for (const [status, msg] of [[409, "Version changed since you opened it"], [422, "Budget must be at least 100"]] as const) {
  test(`a write refused with ${status} shows the reason inline and the app stays up`, async ({ page }) => {
    const alert = await createProjectRefused(page, status, msg);
    await expect(alert).toBeVisible();
    await expect(page.getByRole("button", { name: "Create project" })).toBeEnabled();
    await expect(page.locator("#root > *")).not.toHaveCount(0); // the dialog is modal, so the shell is inert but mounted
  });
}

test("offline: going offline mid-session keeps the shell", async ({ page, context }) => {
  await mockApi(page);
  await open(page, "/#home");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForTimeout(500);
  await expect(page.locator("#root > *")).not.toHaveCount(0);
});

// Stale chunk after a deploy: a lazy view's script 404s. lazyRetry reloads once, then the route error boundary offers Retry.
test("a missing lazy chunk shows a recoverable error, not a blank route", async ({ page }) => {
  await mockApi(page);
  await open(page, "/#home");
  await page.route("**/assets/agents-*.js", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.evaluate(() => {
    window.location.hash = "#agents";
  });
  await expect(page.getByRole("alert").filter({ hasText: /reload|try again|something went wrong|could not load/i })).toBeVisible({ timeout: 8000 });
});
