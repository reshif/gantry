/** The Conversations page, polished to the Blueprint prototype: a clamped one-line preview per list row, a bubble header and an aligned avatar, the agent's question as its own panel (open: chips; answered or replaced: one quiet line), and a quiet "line events" toggle. */
import { devSeed } from "@gantry/domain";
import { PERSONAS, expect, fulfillJson, mockApi, open, test } from "./fixtures";

const SEED = devSeed(Date.now()).state;
const PAYMENTS = SEED.projects.find((p) => p.id === "payments");
const NOW = Date.parse("2026-01-15T10:00:00Z");
const LONG = "Pick one flow, or say all three together: a new user can find the settings page, change the display name and finish sign-up without help";
const REQUEST = "A very long preview of the latest message the clerk wrote that goes on and on about plumbing and cards and ids and what Gantry holds so the list row would run to a dozen lines in a narrow column if nothing clamped it to a single line of text.";

const msg = (id: string, role: string, author: string, text: string, at: number, data: Record<string, unknown> = {}) => ({ id, role, author, text, at, data: { mode: role === "assistant" ? "agent" : undefined, agent: "Intake Clerk", cards: [], ...data } });
const MESSAGES = [
  msg("e1", "system", "system", "The Intake conversation is open.", NOW - 900_000, { kind: "update", mode: "rule-based" }),
  msg("m1", "assistant", "ag-intake", "I read the request. Which screen or flow should come first?", NOW - 800_000, { cards: [
    { kind: "question", id: "Q-1", question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true, answered: "all three together", answeredBy: "person", via: "message", answeredAt: new Date(NOW - 600_000).toISOString(), answerQuote: "all three together" },
    { kind: "question", id: "Q-2", question: "Which flow, again?", options: ["Sign-up"], blocking: true, superseded: true, supersededBy: "Q-3" },
  ] }),
  msg("u1", "user", "p-admin", "all three together", NOW - 600_000),
  msg("m2", "assistant", "ag-intake", REQUEST, NOW - 120_000, { cards: [{ kind: "question", id: "Q-3", question: "What should the first release cover?", options: [LONG, "Only sign-up"], blocking: true }] }),
];

const SESSION = {
  woId: "WO-1001", project: "payments", repo: "payments-api",
  wo: { id: "WO-1001", title: "Gantry Onboarding", description: "", cls: "feature", clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: "intake", stationName: "Intake", state: "waiting", bay: null, gate: { id: "G0G1", label: "G0+G1", name: "Brief confirmed" }, requestedBy: "p-admin", closed: false },
  messages: MESSAGES, agent: { mode: "agent", name: "Intake Clerk", id: "ag-intake", model: "m", vendor: "anthropic", version: 1, station: "intake" },
  budget: { spentUsd: 0, limitUsd: 1 }, costUsd: 0, can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "" }, steps: [], next: { actor: "you", text: "Answer the agent's question." }, waiting: null, pending: [],
  dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [],
  brief: { goal: "", scopeIn: [], scopeOut: [], ac: [], risks: [], open: [], decisions: [], estimate: "", route: [], children: [] }, briefConfirmed: false, briefOpen: true, ruleQuestion: null, ruleReady: false, busy: false,
};
const row = (id: string, title: string) => ({ id, project: "payments", title, cls: "feature", station: "intake", stationName: "Intake", state: "waiting", bay: null, gate: "G0G1", agent: "ag-intake", agentName: "Intake Clerk", waitingOn: "you", latest: { text: REQUEST, at: NOW - 120_000, by: "ag-intake", role: "assistant" }, unread: true, closed: false, started: true, requestedBy: "p-admin", createdAt: NOW - 3_600_000 });

async function show(page: import("@playwright/test").Page) {
  await mockApi(page, {
    persona: PERSONAS.admin,
    overrides: {
      "projects/payments": (r) => fulfillJson(r, { ...PAYMENTS, version: 1 }),
      "work-order-sessions": (r) => fulfillJson(r, { items: [row("WO-1001", "Gantry Onboarding"), row("WO-1002", "Add idempotency keys to the refund endpoint")] }),
      "work-orders/WO-1001/session": (r) => fulfillJson(r, SESSION),
      "POST work-orders/WO-1001/session/seen": (r) => fulfillJson(r, { ok: true, msg: "Seen." }),
    },
  });
  await open(page, "/#/p/payments/conversations/WO-1001");
  await page.locator("#wos-thread").waitFor();
}

for (const [w, scheme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
  test(`conversation polish at ${w} (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await show(page);
    if (w === 390) await page.locator("#conv-back").isVisible().catch(() => false);
    if (process.env.CONV_SHOT) await page.screenshot({ path: `${process.env.CONV_SHOT}-${w}x${w === 390 ? 844 : 900}-${scheme}.png` });

    // the thread list: a preview is one clamped line, never a column of text
    if (w > 767) {
      const preview = page.locator(".cv-row-last").first();
      const lh = await preview.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 16);
      const h = await preview.evaluate((e) => e.getBoundingClientRect().height);
      expect(h, "the row preview is one line").toBeLessThanOrEqual(lh * 1.5);
      const rowH = await page.locator(".cv-row").first().evaluate((e) => e.getBoundingClientRect().height);
      expect(rowH, "a list row stays compact").toBeLessThanOrEqual(110);
    }

    // a bubble has its header, and the avatar sits at its top
    const turn = page.locator(".cv-turn.is-agent").first();
    await expect(turn.locator(".cv-who")).toContainText("Intake");
    const av = await turn.locator(".avatar").first().boundingBox();
    const bub = await turn.locator(".cv-msg").first().boundingBox();
    expect(Math.abs(av!.y - (page.viewportSize()!.height ? bub!.y - 18 : 0)), "the avatar is aligned with the top of the turn").toBeLessThan(30);

    // the question is its own panel, not inside the bubble; closed ones are one quiet line
    const panel = page.locator("article.cv-ask").first();
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((e) => !e.closest(".cv-msg"))).toBe(true);
    await expect(page.locator("details.cv-ask.is-closed")).toHaveCount(2);
    await expect(page.getByText(/Answered by your message at/)).toHaveCount(1);
    const chip = page.locator(".cv-ask .osx-opt").first();
    expect(await chip.evaluate((e) => e.textContent)).toBe(LONG);
    expect(await chip.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "an option wraps, never clipped").toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow").toBe(true);

    // the line-events toggle is a quiet control, not a filled button
    if (w > 767) {
      const bg = await page.locator("#conv-events").evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(bg === "rgba(0, 0, 0, 0)" || bg === "transparent", `line events toggle is quiet (${bg})`).toBe(true);
    }
  });
}
