/**
 * Port fidelity: every answer of the TypeScript engine is compared with the legacy engine
 * (legacy/js, evaluated unchanged in a stubbed window) over the same seed.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS dev tool
import { loadLegacy } from "../scripts/legacy-eval.mjs";
import { CONSOLE_RIGHTS, READ_ACTIONS, answerConversation, buildWorkOrder, can, classify, completeness, flowOf, freeSlot, gateDecision, gateProgress, moveCheck, route, routeGates, simulate, slotsUsed, submitGuard, summaryText, policyTrace, trust, workload, istTime } from "./index.js";
import { NOW, seedState } from "./testkit.js";
import type { WorkOrder } from "./types.js";

const { G } = loadLegacy();
const S = seedState();
const legacyState = G.store.get();
// The Factory Manager and Security Reviewer templates (owner decision 6) are newer than the legacy engine and nobody in the seed holds
// them; they only show up in "Needs …" wording. Compare without them.
for (const r of ["factory_manager", "security_reviewer"]) {
  delete (S.matrix as Record<string, unknown>)[r];
  S.catalog.roles = S.catalog.roles.filter((x) => x.id !== r);
}
// On call is per project now, and a Factory Admin always counts (owner decision 7). The seed puts each on-call person on
// call for every project they hold a role on, which the legacy engine's global switch expresses exactly; it has no notion
// of the Factory Admin rule, so give it the same input.
for (const p of legacyState.people as Array<{ oncall?: boolean; roles: Array<{ role: string; scope: string }> }>) if (p.roles.some((g) => g.role === "factory_admin" && g.scope === "factory")) p.oncall = true;

const times = [NOW, istTime("2026-11-20", "22:00"), istTime("2026-11-18", "11:00"), istTime("2026-11-22", "03:00"), istTime("2026-11-15", "02:00"), istTime("2026-12-25", "12:00")];

describe("can() equals legacy G.can", () => {
  it("is identical for every person, action, project and time", () => {
    let n = 0;
    let diverged = 0;
    const projects: Array<string | null> = [null, ...S.projects.map((p) => p.id)];
    for (const person of S.people) {
      for (const act of S.catalog.actions) {
        if (CONSOLE_RIGHTS.includes(act.id)) continue; // console rights (spec 12.6) are newer than the legacy engine: no legacy answer
        if ((READ_ACTIONS as readonly string[]).includes(act.id)) continue; // rights added after the legacy engine (Read rights) have no legacy answer
        if (act.id === "halt.factory" || act.id === "resume.factory") continue; // factory-scoped stop rights (2026-11 security fix) are newer than the legacy engine
        for (const project of projects) {
          for (const time of times) {
            const ctx = { project, time };
            const a = can(S, person.id, act.id, ctx);
            const b = G.can(person.id, act.id, ctx);
            // Intentional divergence from the legacy engine: a factory-scoped action needs a factory-level grant (a project role never
            // reaches beyond its project). The legacy allowed audit.view / eval.run to Project Admins and Line Leads factory-wide.
            const projectOnly = act.scope === "factory" && !person.roles.some((g) => g.scope === "factory");
            if (act.scope === "factory" && !a.allowed && !b.allowed) {
              n++; // both refuse; the wording differs because the legacy matrix still lists the right on a project role ("needs Project Admin")
              continue;
            }
            if (projectOnly && b.allowed && !a.allowed) {
              expect(a.reason, `${person.id} ${act.id}`).toMatch(/needs a factory-level role|includes/);
              expect(["audit.view", "eval.run"]).toContain(act.id);
              diverged++;
              continue;
            }
            expect(a, `${person.id} ${act.id} ${project} ${time}`).toEqual(b);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(30000);
    expect(diverged).toBeGreaterThan(0);
  });

  it("is identical with a repo in the context (freezes)", () => {
    for (const person of S.people) {
      for (const repo of S.repos) {
        for (const act of ["release", "gate.approve", "kill.project"]) {
          for (const time of times) {
            const ctx = { repo: repo.id, time };
            expect(can(S, person.id, act, ctx), `${person.id} ${act} ${repo.id}`).toEqual(G.can(person.id, act, ctx));
          }
        }
      }
    }
  });

  it("answers unknown people and invited people like legacy", () => {
    expect(can(S, "nobody", "project.view", { project: "payments" })).toEqual(G.can("nobody", "project.view", { project: "payments" }));
    const invited = S.people.find((p) => p.status !== "active");
    if (invited) expect(can(S, invited.id, "project.view", {})).toEqual(G.can(invited.id, "project.view", {}));
  });

  it("policyTrace equals legacy", () => {
    for (const [person, action, project, repo] of [["p-kenji", "release", "payments", "payouts-worker"], ["p-tomas", "gate.approve", "storefront", null], ["p-priya", "kill.project", "risk", null]] as const) {
      const ctx = { project, repo, time: times[1] };
      expect(policyTrace(S, person, action, ctx)).toEqual(G.policyTrace(person, action, ctx));
    }
  });
});

describe("gateDecision equals legacy", () => {
  it("is identical for every work order, waiting gate and active person", () => {
    let n = 0;
    for (const wo of S.workOrders) {
      for (const gate of Object.keys(wo.gates)) {
        const lw = G.find.wo(wo.id);
        for (const person of S.people) {
          const mine = gateDecision(S, person.id, wo, gate, NOW);
          const legacy = G.gateDecision(person.id, lw, gate);
          // Deliberate divergence (user decision 2026-11-14): a Factory Admin may decide any gate, including their own work order under
          // separation of duties; the API turns a vote the rule would not pass into an audited override with a reason. The legacy
          // prototype denied the author and used other wording, so for Factory Admins only the outcome on non-SoD cases is compared.
          if (person.roles.some((r) => r.role === "factory_admin" && r.scope === "factory") && gate !== "G0G1" && mine.allowed) {
            if (legacy.allowed) expect(mine.rule, `${wo.id} ${gate} ${person.id}`).toEqual(legacy.rule);
            else expect(legacy.reason, `${wo.id} ${gate} ${person.id}`).toMatch(/Separation of duties|already approved/);
          } else {
            expect(mine, `${wo.id} ${gate} ${person.id}`).toEqual(legacy);
          }
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
  });

  it("gateProgress equals legacy on the shared fields", () => {
    for (const wo of S.workOrders) {
      const project = S.projects.find((p) => p.id === wo.project)!;
      for (const gate of Object.keys(wo.gates)) {
        const a = gateProgress(project, wo, gate, S.people);
        const b = G.gateProgress(G.find.project(wo.project), G.find.wo(wo.id), gate);
        expect({ have: a.have, need: a.need, unmet: a.unmet.map((c) => c.id), conds: a.conds.map((c) => c.id) }).toEqual({ have: b.have, need: b.need, unmet: b.unmet.map((c: { id: string }) => c.id), conds: b.conds.map((c: { id: string }) => c.id) });
      }
    }
  });
});

describe("moveCheck equals legacy", () => {
  it("is identical for every work order and target, for several viewers", () => {
    const targets = [...S.catalog.stations.map((s) => s.id), ...S.catalog.bays.map((b) => b.id)];
    let n = 0;
    for (const viewer of ["p-asha", "p-meera", "p-tomas", "p-kenji", "p-arjun"]) {
      legacyState.session = { id: "x", person: viewer };
      for (const wo of S.workOrders) {
        for (const t of targets) {
          expect(moveCheck(S, viewer, wo, t, NOW), `${viewer} ${wo.id} -> ${t}`).toEqual(G.moveCheck(G.find.wo(wo.id), t));
          n++;
        }
      }
    }
    legacyState.session = null;
    expect(n).toBeGreaterThan(5000);
  });
});

describe("flow definition equals legacy", () => {
  it("route, routeGates and flowOf agree for every project and class", () => {
    for (const project of S.projects) {
      const lp = G.find.project(project.id);
      for (const cls of S.catalog.classes) {
        expect(route(S.catalog, project, cls.id)).toEqual(G.route(lp, cls.id));
        expect(routeGates(S.catalog, project, cls.id)).toEqual(G.routeGates(lp, cls.id));
      }
      const a = flowOf(S.catalog, project);
      const b = G.flowOf(lp);
      expect(a.stations.map((s) => [s.id, s.enabled, s.wip, s.index])).toEqual(b.stations.map((s: { id: string; enabled: boolean; wip: number; index: number }) => [s.id, s.enabled, s.wip, s.index]));
      expect(a.gates.map((g) => [g.id, g.enabled, g.mode])).toEqual(b.gates.map((g: { id: string; enabled: boolean; mode: string }) => [g.id, g.enabled, g.mode]));
      expect(a.bays.map((x) => x.id)).toEqual(b.bays.map((x: { id: string }) => x.id));
    }
  });

  it("classify agrees on representative requests", () => {
    const texts = [
      "Production is down, urgent hotfix for the checkout service", "Patch XML parser CVE in document upload", "Investigate edge rendering for product pages",
      "Notification preferences centre redesign", "Runbook for refund reconciliation docs", "Bump Go toolchain to 1.25", "Extract posting rules into a package refactor",
      "Fix rounding on JPY partial captures", "Add idempotency keys to refund endpoint", "Retrain the model and tune the drift threshold", "something vague",
    ];
    for (const project of S.projects) {
      for (const t of texts) expect(classify(S.catalog, t, null, project)).toEqual(G.classify(t, null, G.find.project(project.id)));
    }
    expect(classify(S.catalog, "Fix login", "feature", null)).toEqual(G.classify("Fix login", "feature", null));
  });
});

describe("intake, slots and records equal legacy", () => {
  it("buildWorkOrder equals legacy buildWO except where Gantry no longer writes what an agent authors (G-01)", () => {
    const inputs = [
      { project: "payments", repo: "payments-api", title: "Fix rounding on JPY partial captures", description: "see steps", requestedBy: "p-tomas" },
      { project: "payments", repo: "ledger-service", title: "Notification preferences centre redesign", requestedBy: "p-meera" },
      { project: "risk", repo: "risk-models", title: "Retrain model and tune drift threshold", requestedBy: "p-priya" },
      { project: "storefront", repo: "web-storefront", title: "Evaluate edge rendering", requestedBy: "p-arjun" },
    ];
    const strip = (w: Record<string, unknown>) => {
      const x = JSON.parse(JSON.stringify(w));
      for (const k of ["conv", "brief", "clsRationale", "clsConfidence", "history"]) delete x[k];
      return x;
    };
    inputs.forEach((i, n) => {
      const o = { ...i, id: "WO-9" + n, createdAt: NOW };
      const project = S.projects.find((p) => p.id === i.project)!;
      const a = buildWorkOrder(S.catalog, project, o);
      const b = JSON.parse(JSON.stringify(G.buildWO(legacyState, o)));
      expect(strip(a as never)).toEqual(strip(b));
      // Answering walks the same scripted questions, and the brief fields a person answered agree with legacy; children are never derived from an answer.
      const lw = G.buildWO(legacyState, o);
      let wo = a;
      let t = NOW + 5000;
      for (let k = 0; k < 4 && !wo.conv.done; k++) {
        const text = "Typed answer " + k;
        const r = answerConversation(S.catalog, project, wo, text, i.requestedBy, t);
        G.answerConversation(lw, text, i.requestedBy, t);
        wo = { ...wo, conv: r.conv, brief: r.brief };
        t += 60000;
        expect(wo.brief.scopeIn).toEqual(lw.brief.scopeIn);
        expect(wo.brief.ac).toEqual(lw.brief.ac);
        expect(wo.brief.children).toEqual([]);
      }
    });
  });

  it("slotsUsed, freeSlot and submitGuard equal legacy", () => {
    for (const p of S.projects) {
      expect(slotsUsed(S.workOrders, p.id).map((w) => w.id)).toEqual(G.slotsUsed(p.id).map((w: { id: string }) => w.id));
      freeSlot(S.workOrders, p);
      for (const r of [null, ...S.repos]) expect(submitGuard(S, p.id, r ? r.id : null)).toEqual(G.submitGuard(p.id, r ? r.id : null));
    }
  });

  it("summaryText and completeness equal legacy for every work order", () => {
    for (const wo of S.workOrders) {
      expect(summaryText(S, wo)).toEqual(G.lc.summaryText(G.find.wo(wo.id)));
      expect(completeness(wo)).toEqual(G.lc.completeness(G.find.wo(wo.id)));
    }
  });
});

describe("insight equals legacy", () => {
  it("trust.decide agrees for every work order and gate", () => {
    for (const wo of S.workOrders) {
      for (const gate of Object.keys(wo.gates)) {
        expect(trust.decide(S, wo, gate), `${wo.id} ${gate}`).toEqual(G.trust.decide(G.find.wo(wo.id), gate));
      }
    }
  });

  it("trust evidence, meets and projection agree for every cell", () => {
    for (const cell of S.trust.cells) {
      const lc = G.find.trustCell(cell.id);
      expect(trust.evidence(S, cell)).toEqual(G.trust.evidence(lc));
      expect(trust.meets(S, cell)).toEqual(G.trust.meets(lc));
      expect(trust.projection(S, cell, cell.level + 1, NOW)).toEqual(G.trust.projection(lc, cell.level + 1));
    }
    expect(trust.coverage(S, null, NOW)).toEqual(G.trust.coverage(null));
  });

  it("workload people, teams, bottlenecks and minutes agree", () => {
    expect(workload.people(S, undefined, NOW)).toEqual(G.workload.people());
    expect(workload.teams(S, undefined, NOW)).toEqual(G.workload.teams());
    expect(workload.bottlenecks(S, undefined, NOW)).toEqual(G.workload.bottlenecks());
    expect(workload.minutesBy(S, "cls", undefined, NOW)).toEqual(G.workload.minutesBy("cls"));
    expect(workload.suggestions(S, undefined, NOW)).toEqual(G.workload.suggestions());
  });
});

describe("simulate()", () => {
  it("returns the same decision as can() and a 7 x 24 strip whose cells agree with can()", () => {
    const q = { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", time: istTime("2026-11-18", "11:00") };
    const sim = simulate(S, q, NOW);
    expect(sim.decision).toEqual(can(S, q.person, q.action, { project: q.project, repo: q.repo, time: q.time }));
    expect(sim.week).toHaveLength(7);
    for (const row of sim.week) {
      expect(row.cells).toHaveLength(24);
      for (const c of row.cells) {
        const d = can(S, q.person, q.action, { project: q.project, repo: q.repo, time: row.day0 + c.hour * 3600000 + 30 * 60000 });
        expect([c.allowed, c.rule]).toEqual([d.allowed, d.rule.id]);
      }
    }
    expect(sim.week.some((r) => r.cells.some((c) => c.selected))).toBe(true);
  });
});

export type _Unused = WorkOrder;
