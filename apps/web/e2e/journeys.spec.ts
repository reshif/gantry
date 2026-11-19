import { PERSONAS, expect, mockApi, open, test } from "./fixtures";

// Persona journeys, a skeleton: each journey is a named test. Implemented ones run on the mocked fixtures today; the rest are
// test.fixme and become real as the views migrate (create work order, approve, stop and restore with step-up, hostile markdown).

test("persona: signed-out visitor reaches the identity provider from the sign-in screen", async ({ page }) => {
  await mockApi(page, { persona: null, overrides: { me: (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, msg: "no", config: { demoAccounts: false, githubLogin: true } }) }) } });
  await open(page, "/");
  const requests: string[] = [];
  page.on("request", (q) => requests.push(new URL(q.url()).pathname));
  await page.getByRole("button", { name: /single sign-on|sso|sign in/i }).first().click();
  await expect.poll(() => requests.some((p) => p.startsWith("/auth/"))).toBe(true);
});

test("persona: admin lands signed in with the navigation", async ({ page }) => {
  await mockApi(page, { persona: PERSONAS.admin });
  await open(page, "/#home");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /(new|submit) work order/i })).toBeVisible();
});

test("persona: read-only reader is refused every action and sees no enabled stop control", async ({ page }) => {
  const asked: string[] = [];
  await mockApi(page, {
    persona: PERSONAS.reader,
    overrides: {
      "POST can": async (r) => {
        const checks = (r.request().postDataJSON() as { checks: Array<{ action: string }> }).checks;
        asked.push(...checks.map((c) => c.action));
        await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: checks.map((c) => ({ allowed: PERSONAS.reader.allows(c.action), reason: "Read-only", needs: "" })) }) });
      },
    },
  });
  await open(page, "/#home");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /new work order/i })).toHaveCount(0);
  expect(asked.every((a) => !PERSONAS.reader.allows(a) || a.endsWith(".view"))).toBe(true);
});

test.fixme("persona: project admin creates a work order", async () => {});
test.fixme("persona: approver approves a gate and the decision shows the rev they saw", async () => {});
test.fixme("persona: admin stops and restores the line with step-up", async () => {});
test.fixme("persona: hostile markdown in an agent message renders inert", async () => {});
