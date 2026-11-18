import { describe, expect, it, vi } from "vitest";
import { CanBatcher, previewDecision } from "./can";
import type { CanCheck, CanResult } from "./types";

const allow: CanResult = { allowed: true, reason: "ok", needs: "" };
const deny: CanResult = { allowed: false, reason: "no", needs: "Factory Admin" };

function setup(answer: (c: CanCheck) => CanResult = () => allow) {
  const send = vi.fn(async (checks: CanCheck[]) => checks.map(answer));
  const b = new CanBatcher(send);
  b.setSession("s1");
  return { b, send };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("CanBatcher", () => {
  it("collects checks made in the same tick into one request", async () => {
    const { b, send } = setup((c) => (c.action === "kill.factory" ? deny : allow));
    expect(b.peek({ action: "wo.submit", project: "p1" })).toBeNull();
    expect(b.peek({ action: "kill.factory" })).toBeNull();
    expect(b.peek({ action: "wo.submit", project: "p1" })).toBeNull(); // duplicate: still one entry
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual([{ action: "wo.submit", project: "p1" }, { action: "kill.factory" }]);
    expect(b.peek({ action: "kill.factory" })).toEqual(deny);
    expect(b.peek({ action: "wo.submit", project: "p1" })).toEqual(allow);
  });

  it("answers from cache without another request", async () => {
    const { b, send } = setup();
    b.peek({ action: "a" });
    await tick();
    b.peek({ action: "a" });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by project, repo and time", async () => {
    const { b, send } = setup();
    b.peek({ action: "a", project: "p1" });
    b.peek({ action: "a", project: "p2" });
    b.peek({ action: "a", project: "p1", repo: "r" });
    await tick();
    expect(send.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("notifies subscribers when answers arrive", async () => {
    const { b } = setup();
    const fn = vi.fn();
    b.subscribe(fn);
    b.peek({ action: "a" });
    await tick();
    expect(fn).toHaveBeenCalled();
  });

  it("clear() drops cached decisions so they are asked again", async () => {
    const { b, send } = setup();
    b.peek({ action: "a" });
    await tick();
    b.clear();
    expect(b.get({ action: "a" })).toBeNull();
    b.peek({ action: "a" });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer that was in flight when the cache was cleared", async () => {
    let release: (v: CanResult[]) => void = () => {};
    const send = vi.fn(() => new Promise<CanResult[]>((r) => (release = r)));
    const b = new CanBatcher(send);
    b.setSession("s1");
    b.peek({ action: "a" });
    await tick();
    b.clear(); // e.g. the matrix changed while the request was out
    release([allow]);
    await tick();
    expect(b.get({ action: "a" })).toBeNull();
  });

  it("a different session never sees another session's decisions", async () => {
    const { b } = setup();
    b.peek({ action: "a" });
    await tick();
    b.setSession("s2");
    expect(b.get({ action: "a" })).toBeNull();
  });

  it("shows locked, not allowed, when the server cannot answer", async () => {
    const b = new CanBatcher(async () => null);
    b.setSession("s1");
    b.peek({ action: "a" });
    await tick();
    expect(b.get({ action: "a" })?.allowed).toBe(false);
  });
});

describe("view as preview", () => {
  const ok = { allowed: true, reason: "", needs: "" };
  it("a viewer keeps reads except policy and audit, and loses every write", () => {
    expect(previewDecision("wo.submit", ok, "viewer").allowed).toBe(false);
    expect(previewDecision("agents.view", ok, "viewer").allowed).toBe(true);
    expect(previewDecision("audit.view", ok, "viewer").allowed).toBe(false);
  });
  it("an approver loses the admin writes only, and a preview never grants", () => {
    expect(previewDecision("kill.factory", ok, "approver").allowed).toBe(false);
    expect(previewDecision("gate.approve", ok, "approver").allowed).toBe(true);
    expect(previewDecision("kill.factory", { allowed: false, reason: "no", needs: "" }, "").allowed).toBe(false);
    expect(previewDecision("wo.submit", ok, "").allowed).toBe(true);
  });
});
