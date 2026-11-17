import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ApiResult } from "../api/client";
import { clearDrafts, isDraftDirty, useClearDraftsOnUserSwitch, useDraft, type UseDraft } from "./useDraft";
import { DraftDot } from "../ui/DraftDot";
import { DraftConflictBanner } from "../ui/DraftConflict";

type S = { name: string; model: string; tools: string[] };
const server0: S = { name: "Reviewer", model: "m1", tools: ["a"] };

type Res = ApiResult;
const okRes: Res = { ok: true, msg: "", status: 200 };
const setup = (server: S, rev: number, save = vi.fn(async (..._a: unknown[]): Promise<Res> => okRes), refresh = vi.fn()) => {
  const hook = renderHook((p: { server: S; rev: number }) => useDraft<S>({ scope: "t", id: "a1", server: p.server, rev: p.rev, save, refresh }), { initialProps: { server, rev } });
  return { ...hook, save, refresh };
};
const latest = (h: { result: { current: UseDraft<S> } }) => h.result.current;

beforeEach(() => clearDrafts());

describe("useDraft", () => {
  it("sends only the keys this person changed, with the revision they loaded", async () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("name", "Reviewer 2"));
    expect(latest(h).dirty).toBe(true);
    expect(latest(h).changedKeys).toEqual(["name"]);
    await act(async () => void (await latest(h).save()));
    expect(h.save).toHaveBeenCalledWith({ name: "Reviewer 2" }, 4);
  });

  it("does not revert a colleague's edit to a key this person never touched (the silent-revert bug)", async () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("name", "Mine"));
    // a colleague changes model on the server (rev 5) while the draft is open
    h.rerender({ server: { ...server0, model: "m2" }, rev: 5 });
    expect(latest(h).conflict).toBeNull();
    expect(latest(h).values.model).toBe("m2");
    expect(latest(h).values.name).toBe("Mine");
    await act(async () => void (await latest(h).save()));
    expect(h.save).toHaveBeenCalledWith({ name: "Mine" }, 5);
  });

  it("reports a conflict when the same key changed on both sides and refuses to save until resolved", async () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("model", "mine"));
    h.rerender({ server: { ...server0, model: "theirs" }, rev: 5 });
    expect(latest(h).conflict).toEqual({ keys: ["model"] });
    let r: { ok: boolean; status?: number } | null = null;
    await act(async () => void (r = await latest(h).save()));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.save).not.toHaveBeenCalled();
    act(() => latest(h).keepMine());
    expect(latest(h).conflict).toBeNull();
    await act(async () => void (await latest(h).save()));
    expect(h.save).toHaveBeenCalledWith({ model: "mine" }, 5);
  });

  it("discard takes the server copy", () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("model", "mine"));
    h.rerender({ server: { ...server0, model: "theirs" }, rev: 5 });
    act(() => latest(h).discard());
    expect(latest(h).values.model).toBe("theirs");
    expect(latest(h).dirty).toBe(false);
  });

  it("a 412 from the server keeps the draft, flags a conflict and asks for a refresh", async () => {
    const save = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: false, msg: "stale", status: 412 }));
    const h = setup(server0, 4, save);
    act(() => latest(h).set("name", "Mine"));
    await act(async () => void (await latest(h).save()));
    expect(latest(h).conflict).toEqual({ keys: [] });
    expect(latest(h).values.name).toBe("Mine");
    expect(h.refresh).toHaveBeenCalled();
    // the refetch lands: the draft rebases onto it and the banner clears
    h.rerender({ server: { ...server0, model: "m2" }, rev: 5 });
    expect(latest(h).conflict).toBeNull();
    expect(latest(h).values.model).toBe("m2");
  });

  it("a clean draft follows the server, and nested edits count as changes", () => {
    const h = setup(server0, 4);
    h.rerender({ server: { ...server0, name: "Renamed" }, rev: 5 });
    expect(latest(h).values.name).toBe("Renamed");
    act(() => latest(h).edit((v) => void v.tools.push("b")));
    expect(latest(h).changedKeys).toEqual(["tools"]);
  });

  it("keeps the draft across unmount (switching screens) until cleared", () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("name", "Kept"));
    h.unmount();
    const again = setup(server0, 4);
    expect(latest(again).values.name).toBe("Kept");
    act(() => clearDrafts());
    expect(latest(again).values.name).toBe(server0.name);
  });
});

describe("useDraft while a save is in flight and after it", () => {
  it("keeps what was typed mid-save dirty and sends only what was sent as saved", async () => {
    let finish!: (r: Res) => void;
    const save = vi.fn((..._a: unknown[]) => new Promise<Res>((res) => (finish = res)));
    const h = setup(server0, 4, save);
    act(() => latest(h).set("name", "A"));
    let p!: Promise<unknown>;
    await act(async () => {
      p = latest(h).save();
      await Promise.resolve();
    });
    expect(latest(h).saving).toBe(true);
    act(() => { latest(h).set("name", "AB"); latest(h).set("model", "m9"); });
    await act(async () => { finish({ ok: true, msg: "", status: 200 }); await p; });
    expect(latest(h).changedKeys.sort()).toEqual(["model", "name"]);
    expect(latest(h).values.name).toBe("AB");
    // the refetch lands with the saved patch only
    h.rerender({ server: { ...server0, name: "A" }, rev: 5 });
    expect(latest(h).values).toMatchObject({ name: "AB", model: "m9" });
    expect(latest(h).conflict).toBeNull();
    await act(async () => {
      const again = latest(h).save();
      finish({ ok: true, msg: "", status: 200 });
      await again;
    });
    expect(save).toHaveBeenLastCalledWith({ name: "AB", model: "m9" }, 5);
  });

  it("holds the stale server copy off the screen and is syncing until the revision moves", async () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("name", "Mine"));
    await act(async () => void (await latest(h).save()));
    expect(latest(h).syncing).toBe(true);
    // a re-render with the old server copy must not revert the saved value
    h.rerender({ server: server0, rev: 4 });
    expect(latest(h).values.name).toBe("Mine");
    expect(latest(h).dirty).toBe(false);
    let r: { ok: boolean; status?: number } | null = null;
    act(() => latest(h).set("name", "Again"));
    await act(async () => void (r = await latest(h).save()));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.save).toHaveBeenCalledTimes(1);
    h.rerender({ server: { ...server0, name: "Mine" }, rev: 5 });
    expect(latest(h).syncing).toBe(false);
    expect(latest(h).values.name).toBe("Again");
  });

  it("does not absorb a colleague's write that lands between the save and the refetch", async () => {
    const save = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: true, msg: "", status: 200, rev: 5 }) as Res);
    const h = setup(server0, 4, save);
    act(() => latest(h).set("name", "Mine"));
    await act(async () => void (await latest(h).save()));
    // the refetch already holds the colleague's later write (rev 6) to the same key
    h.rerender({ server: { ...server0, name: "Theirs" }, rev: 6 });
    expect(latest(h).syncing).toBe(false);
    expect(latest(h).values.name).toBe("Theirs");
  });

  it("marks a roster row while the draft holds unsent edits", () => {
    const h = setup(server0, 4);
    const dot = render(<DraftDot scope="t" id="a1" />);
    expect(dot.container.querySelector(".draft-dot")).toBeNull();
    act(() => latest(h).set("name", "X"));
    expect(dot.container.querySelector(".draft-dot")).not.toBeNull();
    expect(isDraftDirty("t", "a1")).toBe(true);
  });
});

describe("drafts across people", () => {
  it("clears drafts when a different person signs in, keeps them for the same person", () => {
    const h = setup(server0, 4);
    act(() => latest(h).set("name", "Kept"));
    const w = renderHook((p: { id: string | null }) => useClearDraftsOnUserSwitch(p.id), { initialProps: { id: "u1" as string | null } });
    w.rerender({ id: null });
    w.rerender({ id: "u1" });
    expect(isDraftDirty("t", "a1")).toBe(true);
    w.rerender({ id: "u2" });
    expect(isDraftDirty("t", "a1")).toBe(false);
  });
});

describe("DraftConflictBanner", () => {
  it("is a role=alert naming the fields, with both ways out", () => {
    const keep = vi.fn();
    const drop = vi.fn();
    render(<DraftConflictBanner conflict={{ keys: ["model"] }} onKeepMine={keep} onDiscard={drop} id="c" />);
    expect(screen.getByRole("alert").textContent).toMatch(/model/);
    fireEvent.click(screen.getByText("Keep my version"));
    fireEvent.click(screen.getByText("Load their version"));
    expect(keep).toHaveBeenCalled();
    expect(drop).toHaveBeenCalled();
  });
});
