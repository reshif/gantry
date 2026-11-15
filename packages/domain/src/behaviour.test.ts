import { describe, expect, it } from "vitest";
import {
  answerConversation, buildWorkOrder, can, canMany, checkAgentAuthority, checkFlowEntryRemoval, checkMatrixEdit, checkPersonRemoval, checkRoleChange, checkRoleDelete, classify,
  completeness, defaultMatrix, devSeed, effectiveStop, gateDecision, gateProgress, hasIndependentApprover, istTime, learningSignals, lockedOutRights, moveCheck, queueOrder, refusalBody,
  httpStatusFor, replay, riskTagsFor, riskTagsOf, forcesHuman, slotsUsed, freeSlot, stateAt, submitGuard, summaryText, trackStates, trust, workloadSummary, err, ok, DEFAULT_CATALOG, PROTECTED_RIGHTS, READ_ACTIONS,
  SEED_ANCHOR, gantryError,
} from "./index.js";
import { NOW, mutate, seedState } from "./testkit.js";

const S = seedState();
const wed11 = istTime("2026-11-18", "11:00");
const fri22 = istTime("2026-11-20", "22:00");
const sun03 = istTime("2026-11-22", "03:00");

describe("can(): cases as the legacy views ask them", () => {
  const cases: Array<[string, string, string, { project?: string; repo?: string; time?: number }, boolean, string]> = [
    ["Kenji releases Payments Wed 11:00", "p-kenji", "release", { project: "payments", repo: "payments-api", time: wed11 }, true, "POL-101"],
    ["Kenji releases Payments Fri 22:00 is outside the window", "p-kenji", "release", { project: "payments", repo: "payments-api", time: fri22 }, false, "POL-101"],
    ["Kenji releases payouts-worker during FRZ-07", "p-kenji", "release", { project: "payments", repo: "payouts-worker", time: NOW + 86400000 }, false, "POL-110"],
    ["Lena releases Identity Sunday 03:00 while on call", "p-lena", "release", { project: "identity", time: sun03 }, true, "POL-103"],
    ["Rui cannot release Identity (no role)", "p-rui", "release", { project: "identity", time: sun03 }, false, "MATRIX"],
    ["Priya kills Risk at 02:00 (on-call extend policy needs on call)", "p-priya", "kill.project", { project: "risk", time: istTime("2026-11-19", "02:00") }, false, "MATRIX"],
    ["Asha kills the factory", "p-asha", "kill.factory", {}, true, "MATRIX"],
    ["Meera cannot kill the factory", "p-meera", "kill.factory", {}, false, "MATRIX"],
    ["Tomas approves a gate in Storefront: no role there", "p-tomas", "gate.approve", { project: "storefront" }, false, "MATRIX"],
    ["Tomas submits in Payments", "p-tomas", "wo.submit", { project: "payments" }, true, "MATRIX"],
    ["Tomas cannot approve gates in Payments (engineer)", "p-tomas", "gate.approve", { project: "payments" }, false, "MATRIX"],
    ["Meera approves gates in Payments (line lead)", "p-meera", "gate.approve", { project: "payments" }, true, "MATRIX"],
    ["Sam the auditor views the audit ledger", "p-sam", "audit.view", {}, true, "MATRIX"],
    ["Sam the auditor cannot submit", "p-sam", "wo.submit", { project: "payments" }, false, "MATRIX"],
    ["Daniel configures Payments (project admin)", "p-daniel", "project.config", { project: "payments" }, true, "MATRIX"],
    ["Daniel cannot configure Risk (no grant there)", "p-daniel", "project.config", { project: "risk" }, false, "MATRIX"],
    ["Nikhil (project admin) edits approvers in Risk", "p-nikhil", "approvers.edit", { project: "risk" }, true, "MATRIX"],
    ["Grace may approve gates in Risk", "p-grace", "gate.approve", { project: "risk" }, true, "MATRIX"],
    ["Asha as factory admin sees any project", "p-asha", "project.view", { project: "identity" }, true, "MATRIX"],
    ["Asha releases Identity under break-glass POL-105 (not on call, so POL-103 does not apply)", "p-asha", "release", { project: "identity", time: wed11 }, true, "POL-105"],
    ["Omar edits policy", "p-omar", "policy.edit", {}, true, "MATRIX"],
    ["Priya halts a line as reviewer", "p-priya", "line.halt", { project: "payments" }, true, "MATRIX"],
    ["Chloe confirms briefs in Storefront (line lead)", "p-chloe", "brief.confirm", { project: "storefront" }, true, "MATRIX"],
    ["Arjun submits in Storefront (engineer)", "p-arjun", "wo.submit", { project: "storefront" }, true, "MATRIX"],
    ["Arjun cannot edit flow in Storefront", "p-arjun", "flow.edit", { project: "storefront" }, false, "MATRIX"],
    ["Nobody is not signed in", "nobody", "project.view", { project: "payments" }, false, "MATRIX"],
  ];
  for (const [name, who, action, ctx, allowed, rule] of cases) {
    it(name, () => {
      const d = can(S, who, action, ctx);
      expect(d.allowed).toBe(allowed);
      if (rule !== "MATRIX" || !allowed) expect(d.rule.id).toBe(rule === "MATRIX" ? "MATRIX" : rule);
      expect(d.reason.length).toBeGreaterThan(0);
      if (d.allowed) expect(d.needs).toBe("");
    });
  }

  it("denials explain what is needed", () => {
    const d = can(S, "p-tomas", "gate.approve", { project: "payments" });
    expect(d.needs).toMatch(/^Needs /);
    expect(d.reason).toContain("Tomás Ferreira");
  });

  it("canMany answers the batch endpoint in order", () => {
    const r = canMany(S, "p-tomas", [{ action: "wo.submit", project: "payments" }, { action: "gate.approve", project: "payments" }], NOW);
    expect(r.map((x) => x.allowed)).toEqual([true, false]);
  });
});

describe("stop state precedence (spec 9.7)", () => {
  const kill = { by: "p-asha", at: NOW, reason: "incident", scope: "factory" };
  it("the most severe stop wins; ties go to the outermost scope", () => {
    const s = mutate(S, (x) => {
      x.stops = { factory: null };
      x.repos.find((r) => r.id === "payments-api")!.halted = { by: "p-meera", at: NOW, reason: "flaky" };
      x.projects.find((p) => p.id === "payments")!.halted = { by: "p-meera", at: NOW, reason: "andon" };
    });
    const halt = effectiveStop(s, { project: "payments", repo: "payments-api" });
    expect(halt).toMatchObject({ level: "project", mode: "halt" });
    const s2 = mutate(s, (x) => { x.projects.find((p) => p.id === "payments")!.killed = kill; });
    expect(effectiveStop(s2, { project: "payments", repo: "payments-api" })).toMatchObject({ level: "project", mode: "kill" });
    const s3 = mutate(s2, (x) => { x.stops = { factory: kill }; });
    expect(effectiveStop(s3, { project: "payments", repo: "payments-api" })).toMatchObject({ level: "factory", mode: "kill" });
  });

  it("a repo halt is reported when the project is clean, and a killed work order is a stop", () => {
    const s = mutate(S, (x) => { x.repos.find((r) => r.id === "payments-api")!.halted = { by: "p-meera", at: NOW, reason: "flaky" }; });
    expect(effectiveStop(s, { project: "payments", repo: "payments-api" })).toMatchObject({ level: "repo", mode: "halt" });
    expect(effectiveStop(s, { project: "payments", repo: "ledger-service" })).toBeNull();
    const wo = { id: "WO-9", state: "killed" as const, killed: { by: "p-meera", at: NOW, reason: "dup", scope: "workorder", prev: { state: "running", station: 5, bay: null, bayFrom: null } } };
    expect(effectiveStop(S, { project: "payments", wo })).toMatchObject({ level: "workorder", mode: "kill" });
  });

  it("a kill refuses work but never the stop controls (I7)", () => {
    const s = mutate(S, (x) => { x.projects.find((p) => p.id === "payments")!.killed = kill; });
    const submit = can(s, "p-meera", "wo.submit", { project: "payments" });
    expect(submit).toMatchObject({ allowed: false, rule: { kind: "stop" }, needs: "Restore first" });
    expect(can(s, "p-meera", "kill.workorder", { project: "payments" }).allowed).toBe(true);
    expect(can(s, "p-priya", "line.halt", { project: "payments" }).allowed).toBe(true);
    expect(can(s, "p-meera", "project.view", { project: "payments" }).allowed).toBe(true);
    expect(can(s, "p-meera", "wo.submit", { project: "storefront" }).allowed).toBe(false); // no role there: matrix reason, not a stop
    expect(can(s, "p-chloe", "wo.submit", { project: "storefront" }).allowed).toBe(true);
  });

  it("a halt blocks gate progression but not answering", () => {
    const s = mutate(S, (x) => { x.projects.find((p) => p.id === "payments")!.halted = { by: "p-meera", at: NOW, reason: "andon" }; });
    expect(can(s, "p-meera", "gate.approve", { project: "payments" })).toMatchObject({ allowed: false, needs: "Resume first" });
    expect(can(s, "p-meera", "wo.answer", { project: "payments" }).allowed).toBe(true);
  });

  it("a factory kill stops every project, including gate decisions", () => {
    const s = mutate(S, (x) => { x.stops = { factory: kill }; });
    const wo = s.workOrders.find((w) => Object.values(w.gates).some((g) => g.status === "waiting" && g !== w.gates.G0G1))!;
    const gate = Object.keys(wo.gates).find((k) => k !== "G0G1" && wo.gates[k]!.status === "waiting")!;
    const d = gateDecision(s, "p-asha", wo, gate, NOW);
    expect(d).toMatchObject({ allowed: false, needs: "Restore first", rule: { id: "KILL" } });
    expect(submitGuard(s, wo.project, wo.repo)).toMatch(/^Submissions are refused\. The factory is killed/);
    expect(moveCheck(s, "p-asha", wo, "intake", NOW).allowed).toBe(false);
  });
});

describe("invariants (spec 5.1 and 14.4)", () => {
  it("the last Factory Admin cannot be removed; own admin role cannot be dropped", () => {
    const two = S.people;
    const admins = two.filter((p) => p.roles.some((g) => g.role === "factory_admin"));
    expect(admins.length).toBe(2);
    const self = checkRoleChange(two, { actorId: "p-asha", targetId: "p-asha", nextRoles: [] });
    expect(self).toMatchObject({ ok: false, error: { kind: "denied", rule: { id: "INV-14.4-SELF" } } });
    expect(checkRoleChange(two, { actorId: "p-omar", targetId: "p-asha", nextRoles: [] }).ok).toBe(true);
    const lone = two.map((p) => (p.id === "p-omar" ? { ...p, status: "deactivated" } : p));
    expect(checkRoleChange(lone, { actorId: "p-daniel", targetId: "p-asha", nextRoles: [] })).toMatchObject({ ok: false, error: { rule: { id: "INV-14.4-LAST" } } });
    expect(checkPersonRemoval(lone, { actorId: "p-daniel", targetId: "p-asha" }).ok).toBe(false);
    expect(checkRoleChange(two, { actorId: "p-asha", targetId: "ghost", nextRoles: [] })).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  it("the matrix cannot be edited so that no one can edit it (I9)", () => {
    const m = S.matrix;
    expect(lockedOutRights(m, S.people)).toEqual([]);
    expect(checkMatrixEdit(m, S.people, { role: "factory_admin", action: "policy.edit", value: false })).toMatchObject({ ok: false, error: { rule: { id: "INV-14.4-ADMIN" } } });
    /* a custom role is the only holder: removing it locks the matrix out */
    const people = S.people.map((p) => (p.roles.some((g) => g.role === "factory_admin") ? { ...p, roles: p.roles.filter((g) => g.role !== "factory_admin").concat([{ role: "ops", scope: "factory" }]) } : p));
    const matrix = { ...m, ops: { ...Object.fromEntries(Object.keys(m.viewer!).map((a) => [a, false])), "policy.edit": true, "role.edit": true, "people.manage": true, "security.manage": true, "restore.factory": true } };
    expect(checkMatrixEdit(matrix, people, { role: "ops", action: "policy.edit", value: false })).toMatchObject({ ok: false, error: { rule: { id: "I9" } } });
    expect(checkMatrixEdit(matrix, people, { role: "ops", action: "restore.factory", value: false })).toMatchObject({ ok: false, error: { rule: { id: "I8" } } });
    expect(checkMatrixEdit(m, S.people, { role: "viewer", action: "project.view", value: false }).ok).toBe(true);
  });

  it("a role in use cannot be deleted; a flow entry in use cannot be removed", () => {
    expect(checkRoleDelete(S.people, "engineer")).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(checkRoleDelete(S.people, "nobody_has_this").ok).toBe(true);
    expect(checkFlowEntryRemoval(3, "Build")).toMatchObject({ ok: false });
    expect(checkFlowEntryRemoval(0, "Build").ok).toBe(true);
  });

  it("agents cannot approve configuration (I6)", () => {
    expect(checkAgentAuthority("agent", "trust.grant")).toMatchObject({ ok: false, error: { rule: { id: "I6" } } });
    expect(checkAgentAuthority("person", "trust.grant").ok).toBe(true);
    expect(checkAgentAuthority("agent", "wo.answer").ok).toBe(true);
  });

  it("a Factory Admin keeps stop commands even if the matrix is damaged (I7)", () => {
    const s = mutate(S, (x) => { x.matrix = defaultMatrix(); x.matrix.factory_admin!["kill.factory"] = false; });
    expect(can(s, "p-asha", "kill.factory", {})).toMatchObject({ allowed: true, rule: { id: "I7" } });
    expect(can(s, "p-meera", "kill.factory", {}).allowed).toBe(false);
  });

  it("the requester is never the sole approver (I4)", () => {
    expect(hasIndependentApprover("a", ["a"])).toBe(false);
    expect(hasIndependentApprover("a", ["a", "b"])).toBe(true);
    const project = S.projects.find((p) => p.id === "payments")!;
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments" && w.gates.G5))!;
    project.approvers.G5!.sod = false;
    project.approvers.G5!.required = 1;
    wo.gates.G5!.approvals = [{ by: wo.requestedBy, at: NOW, via: "web" }];
    const alone = gateProgress(project, wo, "G5", S.people);
    expect(alone).toMatchObject({ have: 1, need: 1, onlyRequester: true });
    expect(alone.passes).toBe(false);
    wo.gates.G5!.approvals.push({ by: "p-meera" === wo.requestedBy ? "p-priya" : "p-meera", at: NOW, via: "web" });
    project.approvers.G5!.required = 2;
    wo.gates.G5!.approvals = [wo.gates.G5!.approvals[0]!, wo.gates.G5!.approvals[1]!];
    expect(gateProgress(project, wo, "G5", S.people)).toMatchObject({ have: 2, need: 2, onlyRequester: false });
  });
});

describe("gates: N of M, separation of duties, conditions", () => {
  const strict = S.projects.find((p) => p.id === "risk")!;
  it("Risk requires two approvals at G2", () => {
    expect(strict.approvers.G2!.required).toBe(2);
    const wo = S.workOrders.find((w) => w.project === "risk" && w.gates.G2)!;
    expect(gateProgress(strict, wo, "G2", S.people).need).toBe(2);
  });

  it("the author cannot approve a gate with separation of duties", () => {
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments" && w.gates.G2 && w.requestedBy === "p-meera")) ?? structuredClone(S.workOrders.find((w) => w.project === "payments")!);
    wo.requestedBy = "p-meera";
    wo.gates.G2 = { status: "waiting", approvals: [], rejections: [], checks: [] };
    wo.state = "waiting";
    const d = gateDecision(S, "p-meera", wo, "G2", NOW);
    expect(d).toMatchObject({ allowed: false, rule: { id: "APR-G2" } });
    expect(d.reason).toMatch(/Separation of duties/);
    expect(gateDecision(S, "p-daniel", wo, "G2", NOW).allowed).toBe(true);
  });

  it("the same person cannot approve twice and automatic gates cannot be approved", () => {
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments")!);
    wo.gates.G2 = { status: "waiting", approvals: [{ by: "p-daniel", at: NOW, via: "web" }], rejections: [], checks: [] };
    wo.requestedBy = "p-tomas";
    expect(gateDecision(S, "p-daniel", wo, "G2", NOW).reason).toMatch(/already approved/);
    wo.gates.G4 = { status: "waiting", approvals: [], rejections: [], checks: [] };
    expect(gateDecision(S, "p-daniel", wo, "G4", NOW)).toMatchObject({ allowed: false, needs: "Automatic gate", rule: { id: "AUTO" } });
  });

  it("engineers confirm only briefs they submitted (G0+G1) and only after the conversation is done", () => {
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments")!);
    wo.gates.G0G1 = { status: "waiting", approvals: [], rejections: [], checks: [] };
    wo.requestedBy = "p-meera";
    wo.conv.done = true;
    expect(gateDecision(S, "p-tomas", wo, "G0G1", NOW)).toMatchObject({ allowed: false, rule: { id: "APR-G0G1" } });
    expect(gateDecision(S, "p-meera", wo, "G0G1", NOW).allowed).toBe(true);
    wo.conv.done = false;
    expect(gateDecision(S, "p-meera", wo, "G0G1", NOW).reason).toMatch(/open questions/);
  });

  it("a hotfix at G5 needs a Release Manager who is on call (condition)", () => {
    const project = S.projects.find((p) => p.id === "payments")!;
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments")!);
    wo.cls = "hotfix";
    const conds = gateProgress(project, wo, "G5", S.people);
    expect(conds.conds.map((c) => c.id)).toContain("c2");
    expect(conds.unmet.map((c) => c.id)).toContain("c2");
  });

  it("risk tags force a human: computed from paths and refuse trust auto-pass", () => {
    expect(riskTagsFor([".github/workflows/ci.yml", "go.mod", "CODEOWNERS", "internal/auth/token.go", ".gantry/factory.yml", "migrations/001.sql", "internal/x/x_test.go", "README.md"]).sort()).toEqual(
      ["agent-tests", "auth-crypto", "ci", "codeowners", "dependencies", "gantry-config", "migration"],
    );
    expect(riskTagsFor(["internal/pay/handler.go", "README.md"])).toEqual([]);
    expect(forcesHuman({ files: [], paths: ["package-lock.json"], risk: "normal" })).toBe(true);
    expect(riskTagsOf({ files: [], paths: [], risk: "high" })).toEqual(["high-risk"]);
    const wo = S.workOrders.find((w) => w.project === "payments" && w.gates.G2)!;
    const level3 = mutate(S, (x) => { for (const c of x.trust.cells) c.level = 3; x.trust.ceilings = []; });
    const free = trust.decide(level3, wo, "G2");
    expect(free.auto).toBe(true);
    expect(trust.decide(level3, wo, "G2", { riskTags: ["ci"] })).toMatchObject({ auto: false, riskTagged: true });
  });
});

describe("trust evidence counting (spec 13.3)", () => {
  it("strict counting ignores unattended passes, un-soaked runs and rework", () => {
    const cell = S.trust.cells.find((c) => S.workOrders.some((w) => w.project === c.project && w.cls === c.cls && w.state === "done"))!;
    const loose = trust.evidence(S, cell);
    const strict = trust.evidence(S, cell, { strict: true, now: NOW });
    expect(strict.cleanRuns).toBeLessThanOrEqual(loose.cleanRuns);
    const fresh = trust.evidence(S, cell, { strict: true, now: 0 });
    expect(fresh.cleanRuns).toBe(0);
  });

  it("demotes to L1 on an attributed revert or incident and by one level on two failures in the last ten", () => {
    const base = mutate(S, (x) => {
      x.trust.cells = [{ id: "ag-build|bug|p", agent: "ag-build", cls: "bug", project: "payments", repo: null, level: 3, since: NOW - 30 * 86400000, cleanRuns: 0, history: [] }];
    });
    const cell = base.trust.cells[0]!;
    expect(trust.demotion(base, cell)).toBeNull();
    const mk = (id: string, extra: Partial<(typeof base.workOrders)[number]>) => ({ ...structuredClone(base.workOrders[0]!), id, project: "payments", cls: "bug", state: "done" as const, doneAt: NOW - 86400000, split: false, sendbacks: [], outcomes: [], ...extra });
    const withIncident = mutate(base, (x) => { x.workOrders = [mk("A", { outcomes: [{ kind: "incident", at: NOW, text: "x" }] })]; });
    expect(trust.demotion(withIncident, withIncident.trust.cells[0]!)).toMatchObject({ to: 1 });
    const withRework = mutate(base, (x) => { x.workOrders = [mk("A", { sendbacks: [{ from: "build", to: "plan", note: "n", at: NOW, by: "p-meera" }] }), mk("B", { sendbacks: [{ from: "build", to: "plan", note: "n", at: NOW, by: "p-meera" }] })]; });
    for (const w of withRework.workOrders) for (const g of Object.values(w.gates)) g.rejections = [];
    expect(trust.demotion(withRework, withRework.trust.cells[0]!)).toMatchObject({ to: 2 });
  });
});

describe("slots, queue and submit guard", () => {
  it("queue order is priority then age", () => {
    const base = S.workOrders[0]!;
    const mk = (id: string, priority: "P0" | "P1" | "P2" | "P3", bayAt: number) => ({ ...base, id, priority, bayAt, createdAt: bayAt - 1000 });
    const order = queueOrder([mk("c", "P2", 100), mk("a", "P1", 300), mk("b", "P1", 200), mk("d", "P3", 1), mk("e", "P2", 50)]).map((w) => w.id);
    expect(order).toEqual(["b", "a", "e", "c", "d"]);
  });

  it("counts coding slots and finds the lowest free one", () => {
    const project = S.projects.find((p) => p.id === "payments")!;
    const used = slotsUsed(S.workOrders, "payments");
    expect(used.every((w) => w.slot && w.state !== "done")).toBe(true);
    const free = freeSlot(S.workOrders, project);
    expect(free === null || (free >= 1 && free <= project.flow.slots)).toBe(true);
    const full = S.workOrders.map((w) => ({ ...w }));
    for (let i = 0; i < project.flow.slots; i++) full.push({ ...S.workOrders[0]!, id: "X" + i, project: "payments", slot: i + 1, state: "running" });
    expect(freeSlot(full.filter((w) => w.id.startsWith("X")), project)).toBeNull();
  });

  it("refuses submissions to repos that are not ready, in stopped scopes and in the wrong project", () => {
    expect(submitGuard(S, "payments", "payments-api")).toBeNull();
    expect(submitGuard(S, "storefront", "mobile-app")).toMatch(/is not ready: onboarding is at 'PR checks'/);
    expect(submitGuard(S, "storefront", "payments-api")).toMatch(/^Pick a repo in Storefront/);
    expect(submitGuard(S, "nope", "payments-api")).toBe("Pick a project.");
    expect(submitGuard(S, "legacy-checkout", "checkout-legacy")).toMatch(/is archived/);
  });
});

describe("intake: classification, conversation and brief", () => {
  const payments = S.projects.find((p) => p.id === "payments")!;
  it("classifies and builds a work order at Intake with its gates", () => {
    const wo = buildWorkOrder(S.catalog, payments, { id: "WO-9001", project: "payments", repo: "payments-api", title: "Fix rounding on JPY captures", requestedBy: "p-tomas", createdAt: NOW });
    expect(wo).toMatchObject({ cls: "bug", state: "waiting", station: 0, priority: "P2", risk: "normal" });
    expect(wo.gates.G0G1!.status).toBe("waiting");
    expect(Object.keys(wo.gates)).toEqual(expect.arrayContaining(["G0G1", "G2", "G5"]));
    expect(wo.conv.questions.map((q) => q.id)).toEqual(expect.arrayContaining(["scope", "ac", "testdata", "repro", "extra"]));
    expect(wo.brief.route[0]).toBe("intake");
    expect(wo.slaDue - wo.createdAt).toBe(48 * 3600000);
  });

  it("walks the conversation to a ready brief without mutating the input", () => {
    let wo = buildWorkOrder(S.catalog, payments, { id: "WO-9002", project: "payments", repo: "payments-api", title: "Add idempotency keys with tests, version v2, rollback via flag", requestedBy: "p-tomas", createdAt: NOW });
    let t = NOW;
    while (!wo.conv.done) {
      const frozen = JSON.stringify(wo.conv);
      const q = wo.conv.questions[wo.conv.qi]!;
      const r = answerConversation(S.catalog, payments, wo, q.chips[0]!, "p-tomas", (t += 60000));
      expect(JSON.stringify(wo.conv)).toBe(frozen);
      wo = { ...wo, conv: r.conv, brief: r.brief };
    }
    expect(wo.brief.open).toEqual([]);
    expect(wo.brief.scopeIn.length).toBe(1);
    expect(wo.conv.messages.at(-1)!.text).toMatch(/brief is ready/);
  });

  it("classifies a regulated project's work as high risk and honours requested class below 0.8 confidence", () => {
    const risk = S.projects.find((p) => p.id === "risk")!;
    const wo = buildWorkOrder(S.catalog, risk, { id: "WO-9003", project: "risk", repo: "risk-models", title: "something vague", requestedCls: "docs", requestedBy: "p-priya", createdAt: NOW });
    expect(wo.risk).toBe("high");
    expect(wo.cls).toBe("docs");
    expect(classify(S.catalog, "Production is down", null).cls).toBe("hotfix");
  });
});

describe("lifecycle record", () => {
  it("summarises and measures completeness like legacy", () => {
    const wo = S.workOrders.find((w) => w.state === "done" && w.pr)!;
    expect(summaryText(S, wo)).toContain(wo.title);
    const c = completeness(wo);
    expect(c.total).toBe(11);
    expect(c.sections.summary).toBe(true);
  });
});

describe("replay, learning and workload summary", () => {
  it("stateAt at the anchor shows every live work order and halts/kills from events", () => {
    const at = stateAt(S as typeof S & { events: NonNullable<typeof S.events> }, NOW, "payments");
    const live = S.workOrders.filter((w) => w.project === "payments" && w.createdAt <= NOW);
    expect(at.workOrders.length).toBe(live.length);
    expect(at.workOrders.filter((w) => w.state === "done").length).toBe(live.filter((w) => w.state === "done").length);
  });

  it("trackStates logs bay and state changes", () => {
    const wos = structuredClone(S.workOrders.slice(0, 2));
    const base = trackStates(null, wos, S.catalog);
    expect(base.events).toEqual([]);
    wos[0]!.bay = "hold";
    wos[0]!.bayReason = "waiting for legal";
    wos[1]!.state = "failed";
    wos[1]!.failReason = "ci/test";
    const next = trackStates(base.track, wos, S.catalog);
    expect(next.events.map((e) => e.type)).toEqual(["wo.bay", "wo.state"]);
    expect(next.events[0]).toMatchObject({ bay: "hold", text: "waiting for legal" });
  });

  it("replay.events filters by window, project and types", () => {
    const evs = S.events!;
    const some = replay.events(evs, { project: "payments", types: ["gate.decision"] });
    expect(some.every((e) => e.type === "gate.decision" && (!e.project || e.project === "payments"))).toBe(true);
    expect(replay.range("7d", NOW).from).toBe(NOW - 7 * 86400000);
  });

  it("learning signals come from rejections, send-backs, outcomes, overrides and misses", () => {
    const sig = learningSignals(S);
    expect(sig.length).toBeGreaterThan(0);
    expect(new Set(sig.map((x) => x.signal)).size).toBeGreaterThanOrEqual(2);
  });

  it("workload summary lists waiting gates with eligible approvers", () => {
    const sum = workloadSummary(S, { ids: ["payments"], days: 7 }, NOW);
    expect(sum.gates.every((g) => g.wo.project === "payments")).toBe(true);
    expect(sum.rows.length).toBeGreaterThan(0);
  });
});

describe("results and errors", () => {
  it("map error kinds to the API contract", () => {
    expect(httpStatusFor("denied")).toBe(403);
    expect(httpStatusFor("conflict")).toBe(409);
    expect(httpStatusFor("stale")).toBe(409);
    expect(httpStatusFor("stopped")).toBe(409);
    expect(httpStatusFor("invalid")).toBe(422);
    expect(httpStatusFor("not_found")).toBe(404);
    expect(refusalBody(gantryError("denied", "No.", { needs: "A role", rule: { kind: "matrix", id: "MATRIX" } }))).toEqual({ ok: false, msg: "No.", needs: "A role", rule: { kind: "matrix", id: "MATRIX" } });
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });
});

describe("dev seed", () => {
  it("has every slice, with legacy field names", () => {
    const { state, catalog } = devSeed(NOW);
    for (const k of ["people", "teams", "projects", "repos", "workOrders", "agents", "skills", "vendors", "routing", "suites", "evalRuns", "trust", "learning", "integrationTypes", "integrationInstances", "deliveries", "mcp", "apiKeys", "triggers", "policies", "freezes", "matrix", "sessions", "security", "audit", "events", "templates", "prefs"] as const) {
      expect(state[k], k).toBeDefined();
    }
    expect(state.people.length).toBe(20);
    expect(state.projects.length).toBe(12);
    expect(state.workOrders.length).toBe(77);
    expect(state.session).toBeNull();
    expect(catalog.stations.length).toBe(10);
    expect(catalog.stations[9]).toMatchObject({ id: "compliance", custom: true });
    expect(DEFAULT_CATALOG.stations.length).toBe(9);
  });

  it("shifts timestamps with now and returns independent copies", () => {
    const a = devSeed(SEED_ANCHOR);
    const b = devSeed(SEED_ANCHOR + 86400000);
    expect(b.state.workOrders[0]!.createdAt - a.state.workOrders[0]!.createdAt).toBe(86400000);
    expect(b.state.people[2]!.away!.to - a.state.people[2]!.away!.to).toBe(86400000);
    const fz = (s: typeof a) => s.state.freezes.find((f) => f.id === "FRZ-08")!.from;
    expect(fz(b)).toBe(fz(a)); // fixed future dates are not shifted
    a.state.people[0]!.name = "changed";
    expect(devSeed(SEED_ANCHOR).state.people[0]!.name).toBe("Asha Raman");
  });

  it("default matrix equals the seeded matrix for built-in roles", () => {
    const { state } = devSeed(NOW);
    const dm = defaultMatrix(DEFAULT_CATALOG.actions);
    for (const role of Object.keys(dm)) for (const a of DEFAULT_CATALOG.actions) expect(state.matrix[role]![a.id], `${role} ${a.id}`).toBe(dm[role]![a.id]);
  });
});

describe("on call is per project (owner decision 7)", () => {
  const release = (st: typeof S, project: string) => can(st, "p-lena", "release", { project, time: sun03 });

  it("Lena's on-call release on Identity needs Identity's own on-call list, not another project's", () => {
    expect(S.projects.find((p) => p.id === "identity")?.oncall).toContain("p-lena");
    expect(release(S, "identity")).toMatchObject({ allowed: true, rule: { id: "POL-103" } });
    const elsewhere = mutate(S, (s) => {
      for (const p of s.projects) p.oncall = p.id === "payments" ? ["p-lena"] : (p.oncall ?? []).filter((x) => x !== "p-lena");
    });
    const d = release(elsewhere, "identity");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("not on call");
  });

  it("the person's own legacy switch no longer counts", () => {
    const st = mutate(S, (s) => {
      for (const p of s.projects) p.oncall = [];
      for (const p of s.people) p.oncall = true;
    });
    expect(release(st, "identity").allowed).toBe(false);
  });

  it("a Factory Admin always counts as on call, with no list", async () => {
    const { isOnCall } = await import("./policy.js");
    const st = mutate(S, (s) => { for (const p of s.projects) p.oncall = []; });
    const asha = st.people.find((p) => p.id === "p-asha")!;
    const lena = st.people.find((p) => p.id === "p-lena")!;
    expect(isOnCall(st, asha, "identity")).toBe(true);
    expect(isOnCall(st, asha, null)).toBe(true);
    expect(isOnCall(st, lena, "identity")).toBe(false);
  });
});

describe("role templates: Factory Manager and Security Reviewer (owner decision 6)", () => {
  const m = defaultMatrix(DEFAULT_CATALOG.actions);
  const has = (role: string, ids: string[]) => ids.filter((a) => m[role]?.[a] !== true);
  const lacks = (role: string, ids: string[]) => ids.filter((a) => m[role]?.[a] === true);

  it("are factory-level built-in roles", () => {
    for (const id of ["factory_manager", "security_reviewer"]) expect(DEFAULT_CATALOG.roles.find((r) => r.id === id)?.level).toBe("factory");
  });

  it("a Factory Manager reads everything and operates every project, but administers no access", () => {
    expect(has("factory_manager", ["project.view", ...READ_ACTIONS, "audit.view", "wo.move", "gate.approve", "flow.edit", "project.config", "line.halt", "line.resume", "kill.project", "restore.project", "halt.factory", "resume.factory", "project.create", "template.edit"])).toEqual([]);
    expect(lacks("factory_manager", [...PROTECTED_RIGHTS, "project.members", "approvers.edit", "trust.grant", "api.keys", "kill.factory", "agent.edit", "model.edit", "integration.edit"])).toEqual([]);
    expect(lacks("factory_manager", DEFAULT_CATALOG.actions.map((a) => a.id).filter((a) => a.startsWith("console.propose")))).toEqual([]);
  });

  it("a Security Reviewer reads everything and can stop or sign off risky work, and changes no configuration", () => {
    expect(has("security_reviewer", ["project.view", ...READ_ACTIONS, "audit.view", "gate.approve", "wo.sendback", "line.halt", "kill.workorder"])).toEqual([]);
    expect(lacks("security_reviewer", [...PROTECTED_RIGHTS, "line.resume", "flow.edit", "project.config", "wo.move", "release", "agent.edit"])).toEqual([]);
  });
});
