import { DEFAULT_CATALOG, devSeed, route } from "@gantry/domain";
import { PERSONAS, expect, fulfillJson, mockApi, open, test } from "./fixtures";

const SEED = devSeed(Date.now()).state;
const PAYMENTS = SEED.projects.find((p) => p.id === "payments");
const REPOS = SEED.repos.filter((r) => r.project === "payments");
const WOS = SEED.workOrders.filter((w) => w.project === "payments");
const WO = SEED.workOrders.find((w) => w.project === "payments" && w.state !== "killed");

const allow = { allowed: true, reason: "", needs: "" };
const rt = route(DEFAULT_CATALOG, PAYMENTS!, WO!.cls);
const TRAVELER = {
  ...WO, version: 7, stop: null, route: rt,
  gateProgress: Object.fromEntries(Object.keys(WO!.gates).map((g) => [g, { have: 0, need: 1, unmet: [], conds: [], onlyRequester: false, passes: false }])),
  allowed: {
    approve: null,
    moves: Object.fromEntries([...rt.map((s) => [s, { allowed: true, reason: "", kind: "back" }]), ...DEFAULT_CATALOG.bays.map((b) => [b.id, { allowed: true, reason: "", kind: "park" }])]),
    can: Object.fromEntries(["answer", "classify", "decline", "park", "sendback", "reassign", "move", "confirm", "summary"].map((k) => [k, allow])),
  },
};

// T-53: the work order drawer's content fits its panel: nothing is cut at the right edge.
for (const w of [390, 1366]) {
  test(`the work order drawer does not clip at ${w}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    await mockApi(page, {
      persona: PERSONAS.admin,
      overrides: {
        "projects/payments": (r) => fulfillJson(r, { ...PAYMENTS, version: 1 }),
        "projects/payments/repos": (r) => fulfillJson(r, REPOS),
        "projects/payments/work-orders": (r) => fulfillJson(r, { items: WOS, next: null, total: WOS.length }),
        "work-order-sessions": (r) => fulfillJson(r, { items: [] }),
        [`work-orders/${WO!.id}`]: (r) => fulfillJson(r, TRAVELER),
      },
    });
    await open(page, `/#/p/payments/traveler/${WO!.id}`);
    await page.locator("#trv-page-drawer").click();
    const body = page.locator(".trv-drawer .drawer-scroll").first();
    await body.waitFor();
    const m = await body.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(m.scroll, `drawer content ${m.scroll}px in a ${m.client}px panel`).toBeLessThanOrEqual(m.client);
    const right = await page.locator(".trv-drawer .drawer-scroll .btn").evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(w);
  });
}
