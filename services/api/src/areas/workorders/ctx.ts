/** Shared plumbing for the work-order commands: the effects collector, the locked row, the stop guard and the flow state of one work order. */
import type { FlowState, WorkOrder } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, refuse } from "../../core/errors.js";
import { readCatalog, readOrg } from "../../core/read/index.js";
import { coveringStop, type Fx } from "./engine.js";
import { loadFlow, lockWo, stateWithPinned, type Wo } from "./model.js";

export type CmdResult = CommandResult<Record<string, unknown>>;

/** Actions a halt blocks (spec 9.7: no gate progression, no merges, no moves); a kill blocks everything. Mirrors the domain's `stopBlocks`, which cannot see work-order-scope halts. */
const HALT_BLOCKS = new Set(["gate.approve", "release", "wo.move", "brief.confirm", "gate.reject"]);

export async function makeFx(tx: Tx, actor: Actor, changes: string[] = []): Promise<Fx> {
  const catalog = await readCatalog(tx, actor.orgId, await readOrg(tx, actor.orgId));
  return { tx, orgId: actor.orgId, now: actor.now, actor: actor.id, catalog, events: [], jobs: [], changes: new Set(["workOrders", "floor", "home", ...changes]) };
}

export function done(fx: Fx, msg: string, project: string | null, extra: Record<string, unknown> = {}): CmdResult {
  return { msg, events: fx.events, jobs: fx.jobs, changes: [...fx.changes], extra, project };
}

export function person(actor: Actor, what = "This"): string {
  if (!actor.personId) throw refuse("denied", /\b(is|are)$/.test(what) ? `${what} for signed-in people.` : `${what} is for signed-in people.`);
  return actor.personId;
}

/** The refusal for a stop covering the work order: audited as a denial by the pipeline (spec 15.4). */
export async function guardStop(fx: Fx, w: Wo, action: string, o: { haltOverride?: boolean } = {}): Promise<void> {
  const s = await coveringStop(fx.tx, fx.orgId, w);
  if (!s) return;
  if (s.mode === "halt" && !HALT_BLOCKS.has(action)) return;
  // A Factory Admin's "Approve anyway": the gate decision (gateDecision, with the override) decides who may; a kill is never skipped here.
  if (s.mode === "halt" && o.haltOverride) return;
  const where = s.scope === "factory" ? "The factory" : s.scope === "wo" ? "This work order" : s.scope === "project" ? `Project ${w.project}` : `Repo ${w.repo ?? ""}`;
  throw refuse("stopped", `${where} is ${s.mode === "halt" ? "halted (andon)" : "killed"}: ${s.reason || "no reason given"}.`, {
    rule: { kind: "stop", id: `STOP-${s.scope.toUpperCase()}`, name: "Stop state" }, needs: s.mode === "halt" ? "Resume first" : "Restore first",
  });
}

export const guardOpen = (w: Wo): void => {
  if (w.state === "done" || w.state === "killed") throw conflict(`${w.id} is ${w.state}.`);
};

/** Locks the work order (F2: commands on one work order are serialised and `If-Match` is checked against the locked row) and applies the stop guard. */
export async function begin(tx: Tx, actor: Actor, woId: string, action: string, o: { allowClosed?: boolean; skipStop?: boolean; haltOverride?: boolean } = {}): Promise<{ fx: Fx; w: Wo }> {
  const w = await lockWo(tx, actor.orgId, woId, actor.ifMatch);
  const fx = await makeFx(tx, actor);
  if (!o.skipStop) await guardStop(fx, w, action, { haltOverride: !!o.haltOverride });
  if (!o.allowClosed) guardOpen(w);
  return { fx, w };
}

/** The flow state as this work order sees it (its flow version pinned, approver rules live) with the work order built from rows. */
export async function flowFor(fx: Pick<Fx, "tx" | "orgId">, w: Pick<Wo, "id" | "project" | "flowVersion">): Promise<{ st: FlowState; wo: WorkOrder }> {
  const loaded = await loadFlow(fx.tx, fx.orgId, { ids: [w.id] });
  const st = await stateWithPinned(fx.tx, fx.orgId, loaded, w);
  const wo = st.workOrders[0];
  if (!wo) throw conflict("That work order no longer exists.");
  return { st, wo };
}
