/** Work order creation (spec 9.4 "submit"): classification, pinned flow version, the verbatim request and the intake conversation. */
import { buildWorkOrder, classesOf, route, routeGates, type Project, type WorkOrder } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { insertConversation } from "./conversation.js";
import { enterStation, ev, note, openInstance, closeInstance, type Fx } from "./engine.js";
import { saveWo, toWo, WO_COLS, type Wo } from "./model.js";
import { projectOf } from "./engine.js";

export async function newWoId(tx: Tx): Promise<string> {
  return `WO-${(await tx.query<{ n: string }>(`select nextval('wo_number_seq') as n`)).rows[0]!.n}`;
}

export interface CreateInput {
  id: string;
  project: string;
  repo: string;
  /** As typed: title is trimmed into the work order, the request row keeps the raw text. */
  title: string;
  description?: string;
  rawText?: string;
  attachments?: unknown[];
  requestedCls?: string | null;
  forceCls?: string;
  priority?: string;
  source: string;
  requestedBy: string;
  via?: string | null;
  awaiting?: string | null;
  paths?: string[];
  parent?: string | null;
  submittedBy?: string | null;
  /** An epic child: brief inherited, G0+G1 passed, Research to Plan skipped, straight to Build. */
  childOf?: { by: string; parent: string };
}

export interface Created {
  wo: Wo;
  classification: { cls: string; confidence: number; rationale: string; suggested: string; alternatives: string[] };
  route: string[];
  gates: string[];
}

export async function createWorkOrder(fx: Fx, i: CreateInput): Promise<Created> {
  const project: Project = await projectOf(fx, i.project);
  const now = fx.now.getTime();
  if (i.requestedCls && !classesOf(fx.catalog, project).some((c) => c.id === i.requestedCls)) throw new Error(`unknown class ${i.requestedCls}`);
  const built: WorkOrder = buildWorkOrder(fx.catalog, project, {
    id: i.id, project: i.project, repo: i.repo, title: i.title, description: i.description ?? "", attachments: i.attachments ?? [], requestedCls: i.requestedCls ?? null,
    ...(i.forceCls ? { forceCls: i.forceCls } : {}), ...(i.priority ? { priority: i.priority as WorkOrder["priority"] } : {}), source: i.source, requestedBy: i.requestedBy, createdAt: now,
    awaiting: i.awaiting ?? "submitter", paths: i.paths ?? [], parent: i.parent ?? null,
  });
  const flowVersion = (await fx.tx.query<{ v: number }>(`select current_flow_version as v from projects where org_id = $1 and id = $2`, [fx.orgId, i.project])).rows[0]?.v;
  if (!flowVersion) throw new Error(`project ${i.project} has no published flow`);
  const data = {
    description: built.description, attachments: built.attachments, clsConfidence: built.clsConfidence, clsRationale: built.clsRationale, clsSuggested: built.clsSuggested, clsOverridden: null, requestedCls: built.requestedCls,
    progress: 0, history: [], log: [{ at: now, who: i.requestedBy, text: `Submitted from ${i.source}.` }], diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 0, failed: 0, added: 0 },
    clsBy: i.requestedCls || i.forceCls ? { kind: "person", at: now } : { kind: "rule", at: now },
    // No class was requested: the Intake agent classifies it next (a job). Until then the keyword match above is provisional.
    ...(!i.requestedCls && !i.forceCls && !i.childOf && !["eval", "onboarding"].includes(i.source) ? { classifyPending: "pending" } : {}),
    blockReason: null, failReason: null, paths: built.paths, brief: built.brief, children: [], gateStatus: {}, ...(i.submittedBy ? { submittedBy: i.submittedBy } : {}),
  };
  await fx.tx.query(
    `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, source, position, state, flow_version, submitter, parent_id, risk, sla_due_at, data, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'intake','waiting',$9,$10,$11,$12,$13,$14::jsonb,$15)`,
    [fx.orgId, i.id, i.project, i.repo, i.title, built.cls, built.priority, i.source, flowVersion, i.requestedBy, i.parent ?? null, built.risk, new Date(built.slaDue), JSON.stringify(data), fx.now],
  );
  await fx.tx.query(`insert into requests (org_id, id, wo_id, original_text, submitted_by, via, created_at) values ($1,$2,$3,$4,$5,$6,$7)`, [fx.orgId, `REQ-${i.id}`, i.id, i.rawText ?? i.title, i.requestedBy, i.via ?? i.source, fx.now]);
  await insertConversation(fx, i.id, i.project, i.requestedBy, built.conv);
  const { rows: [r] } = await fx.tx.query(`select ${WO_COLS} from work_orders where org_id = $1 and id = $2`, [fx.orgId, i.id]);
  const w = toWo(r);
  const gates = routeGates(fx.catalog, project, built.cls);
  ev(fx, w, "wo.submit", { text: w.title, station: "intake" });
  if (i.childOf) {
    const by = i.childOf.by;
    built.conv.done = true;
    built.conv.qi = built.conv.questions.length;
    await fx.tx.query(`update conversations set status = 'closed', data = data || $3::jsonb, updated_at = now() where org_id = $1 and wo_id = $2 and kind = 'intake'`, [fx.orgId, i.id, JSON.stringify({ done: true, qi: built.conv.qi })]);
    await fx.tx.query(`insert into messages (org_id, id, conversation_id, author, author_kind, body, data) values ($1,$2,$3,'system','system',$4,$5::jsonb)`, [fx.orgId, `${i.id}:m99999`, `CONV-${i.id}`, `Created from epic ${i.childOf.parent}; brief inherited.`, JSON.stringify({ at: now + 3000 })]);
    w.state = "waiting";
    const inst = await openInstance(fx.tx, fx.orgId, w, "G0G1", { station: "intake", flowVersion, now: fx.now });
    await closeInstance(fx, inst, "decision");
    await fx.tx.query(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, decided_by, rule, flow_version, detail, at) values ($1,$2,$3,$4,'approved',$5,'APR-G0G1',$6,$7::jsonb,$8)`, [fx.orgId, `GD-${inst}`, inst, i.id, by, flowVersion, JSON.stringify({ mode: "human", channel: "system", via: "epic" }), fx.now]);
    const skipped: Record<string, string> = {};
    for (const sid of ["research", "spec", "design", "plan"]) {
      const g = fx.catalog.gates.find((x) => x.after === sid);
      if (g && gates.includes(g.id)) skipped[g.id] = "skipped";
    }
    w.data.gateStatus = skipped;
    // No agent ran at Intake for an inherited brief: no history entry is invented.
    w.data.history = [];
    note(w, fx, by, `Created from epic ${i.childOf.parent}.`);
    await enterStation(fx, w, "build", { project });
    await saveWo(fx.tx, fx.orgId, w);
  } else {
    await enterStation(fx, w, "intake", { project });
    await saveWo(fx.tx, fx.orgId, w);
  }
  return {
    wo: w,
    classification: { cls: built.cls, confidence: built.clsConfidence, rationale: built.clsRationale, suggested: built.clsSuggested, alternatives: [] },
    route: route(fx.catalog, project, built.cls),
    gates,
  };
}
