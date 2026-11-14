import { describe, expect, it } from "vitest";
import { CONSOLE_PROPOSALS, CONSOLE_RIGHTS, CONSOLE_USE, can, checkMatrixEdit, DEFAULT_CATALOG, defaultMatrix } from "./index.js";
import { mutate, seedState } from "./testkit.js";

const m = defaultMatrix();
const proposeIds = CONSOLE_PROPOSALS.map((c) => c.id);

describe("console rights (spec 12.6, default deny)", () => {
  it("are in the catalogue as a Console group", () => {
    for (const id of CONSOLE_RIGHTS) expect(DEFAULT_CATALOG.actions.find((a) => a.id === id)?.group).toBe("Console");
    expect(proposeIds).toHaveLength(9);
  });
  it("Factory Admin holds every console right by default", () => {
    for (const id of CONSOLE_RIGHTS) expect(m.factory_admin![id]).toBe(true);
  });
  it("every other built-in role may only ask (console.use) or nothing, never propose", () => {
    for (const [role, cells] of Object.entries(m)) {
      if (role === "factory_admin") continue;
      for (const id of proposeIds) expect(cells[id], `${role}:${id}`).toBe(false);
      expect(cells[CONSOLE_USE], role).toBe(!!cells["project.view"]);
    }
  });
  it("Factory Admin keeps console rights even when the matrix is damaged, and the cell cannot be switched off", () => {
    const s = mutate(seedState(), (x) => { x.matrix = defaultMatrix(); for (const id of CONSOLE_RIGHTS) x.matrix.factory_admin![id] = false; });
    expect(can(s, "p-asha", "console.propose.kill", {}).allowed).toBe(true);
    expect(can(s, "p-meera", "console.propose.kill", {}).allowed).toBe(false);
    const r = checkMatrixEdit(m, seedState().people, { role: "factory_admin", action: "console.propose.submit", value: false });
    expect(r.ok).toBe(false);
  });
  it("an Engineer may ask but not propose; granting a right to a role lets them", () => {
    const s = seedState();
    const eng = s.people.find((p) => p.roles.some((g) => g.role === "engineer"))!;
    expect(can(s, eng.id, CONSOLE_USE, {}).allowed).toBe(true);
    expect(can(s, eng.id, "console.propose.submit", {}).allowed).toBe(false);
    const s2 = mutate(s, (x) => { x.matrix = { ...x.matrix, engineer: { ...x.matrix.engineer!, "console.propose.submit": true } }; });
    expect(can(s2, eng.id, "console.propose.submit", {}).allowed).toBe(true);
  });
});
