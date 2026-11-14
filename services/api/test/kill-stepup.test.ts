import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { Double, fakeBotToken, fakeSigningSecret, slackDouble } from "./notify-doubles.js";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { proxiedHttp } from "../src/areas/notifications/http.js";

const d = TEST_URL ? describe : describe.skip;
const STALE = { authAgeSec: 4000 };

d("kill step-up is a security setting; restore always needs it; the notify preview is honest", () => {
  let t: TestApp;
  let slack: Double;
  const token = fakeBotToken();
  beforeAll(async () => {
    slack = await slackDouble(token);
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: proxiedHttp({ proxy: null }), slackBase: `${slack.url}/api`, smtp: { host: null, port: 25 } });
  });
  afterAll(async () => {
    resetRuntime();
    await slack.stop();
    await t.close();
  });
  const w = world(() => t);
  const kill = (o: { authAgeSec?: number } = {}) => w.call("p-asha", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Security incident", confirmText: "Payments Platform", inFlight: "hold" }, {}, o);
  const restore = (o: { authAgeSec?: number } = {}) => w.call("p-asha", "POST", "/api/v1/stops/project%3Apayments/restore", { reason: "The incident is over" }, {}, o);
  const setKillStepUp = (on: boolean, o: { authAgeSec?: number } = {}) => w.call("p-asha", "PATCH", "/api/v1/security", { path: "killNeedsStepUp", value: on }, {}, o);

  it("defaults on: a stale sign-in is refused with the window and age, and the refusal is audited", async () => {
    expect(((await w.call("p-asha", "GET", "/api/v1/security")).body as any).killNeedsStepUp).toBe(true);
    const r = await kill(STALE);
    expect(r.status).toBe(403);
    expect(r.body.needs).toBe("step_up");
    expect(r.body.rule).toMatchObject({ kind: "step-up", windowSec: 900, action: "kill.project" });
    expect(r.body.rule.signedInSecAgo).toBeGreaterThanOrEqual(3990);
    expect((await w.events("kill.project.denied")).length).toBe(1);
  });

  it("changing the setting needs a fresh sign-in and is audited with before and after", async () => {
    const old = await setKillStepUp(false, STALE);
    expect(old.body.needs).toBe("step_up");
    const ok = await setKillStepUp(false);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const ev = (await w.events("security.saved")).at(-1)!;
    expect(ev.before).toEqual({ killNeedsStepUp: true });
    expect(ev.after).toMatchObject({ killNeedsStepUp: false });
  });

  it("off: kill works without a fresh sign-in, restore still needs one", async () => {
    const k = await kill(STALE);
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const r = await restore(STALE);
    expect(r.status).toBe(403);
    expect(r.body.needs).toBe("step_up");
    const fresh = await restore();
    expect(fresh.body.needs).not.toBe("step_up");
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  });

  it("back on: kill is refused again on a stale sign-in", async () => {
    expect((await setKillStepUp(true)).status).toBe(200);
    const r = await kill(STALE);
    expect(r.body.needs).toBe("step_up");
  });

  it("the notify preview lists only what the notifier can deliver", async () => {
    await w.q(`delete from notification_routes`);
    const mk = await w.call("p-daniel", "POST", "/api/v1/projects/payments/routes", { event: "kill", dest: [{ channel: "slack", target: "#incidents" }, { channel: "paging", target: "factory-oncall" }, { channel: "email", target: "project admins" }], template: "kill" });
    expect(mk.status, JSON.stringify(mk.body)).toBe(200);
    const none = (await w.call("p-daniel", "GET", "/api/v1/projects/payments/routes/preview?event=kill")).body as any;
    expect(none.items.map((x: any) => [x.channel, x.deliverable])).toEqual([["slack", false], ["paging", false], ["email", false]]);
    expect(none.items[0].reason).toMatch(/no slack connection/);
    const inst = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "slack", name: "Acme Slack", config: { workspace: "acme", defaultChannel: "#factory-gates" }, secrets: { botToken: token, signingSecret: fakeSigningSecret() }, projects: "all", enable: true });
    expect(inst.status, JSON.stringify(inst.body)).toBe(200);
    const some = (await w.call("p-daniel", "GET", "/api/v1/projects/payments/routes/preview?event=kill")).body as any;
    expect(some.items.find((x: any) => x.channel === "slack")).toMatchObject({ deliverable: true });
    expect(some.items.find((x: any) => x.channel === "paging")).toMatchObject({ deliverable: false });
  });
});
