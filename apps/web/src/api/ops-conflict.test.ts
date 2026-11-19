import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { bindQueryClient } from "./keys";
import { setCsrfToken } from "./client";
import { CHANGED_MSG, ops } from "./ops";

let qc: QueryClient;
let spy: MockInstance<QueryClient["invalidateQueries"]>;
const slicesOf = () => new Set(spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]));
function reply(status: number, body: object) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}
beforeEach(() => { setCsrfToken("c"); qc = new QueryClient(); spy = vi.spyOn(qc, "invalidateQueries"); bindQueryClient(qc); });
afterEach(() => { bindQueryClient(null); vi.unstubAllGlobals(); });

describe("a save refused as changed refreshes what it touched (S-27)", () => {
  it("a 409 refetches the affected slices and tells the person it was reloaded", async () => {
    reply(409, { ok: false, msg: "This changed since you loaded it. Reload and try again." });
    const r = await ops.setProject("payments", "desc", "x", { ifMatch: 3 });
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(`This changed since you loaded it. ${CHANGED_MSG}`);
    expect(slicesOf().has("projects")).toBe(true);
  });
  it("a 412 does too", async () => {
    reply(412, { ok: false, msg: "Precondition failed." });
    await ops.setProject("payments", "desc", "x", { ifMatch: 3 });
    expect(slicesOf().has("projects")).toBe(true);
  });
  it("a 409 that is not a stale version (the server says something else) keeps its own words, and still reloads", async () => {
    reply(409, { ok: false, msg: "Renaming a project is not supported." });
    const r = await ops.setProject("payments", "name", "x", { ifMatch: 3 });
    expect(r.msg).toBe("Renaming a project is not supported.");
    expect(slicesOf().has("projects")).toBe(true);
  });
  it("a 409 that names a business rule is not a stale version: nothing is reloaded for it", async () => {
    reply(409, { ok: false, msg: "No.", rule: { id: "G5" } });
    const r = await ops.setProject("payments", "desc", "x", { ifMatch: 3 });
    expect(r.msg).not.toContain(CHANGED_MSG);
    expect(spy).not.toHaveBeenCalled();
  });
  it("other refusals reload nothing", async () => {
    reply(403, { ok: false, msg: "No." });
    await ops.setProject("payments", "desc", "x", { ifMatch: 3 });
    expect(spy).not.toHaveBeenCalled();
  });
});
