/**
 * Event-driven follow-ups in the work-order session (spec 8.4). Station transitions, gate decisions, bays, merges and failed checks that Gantry records on a work order are
 * posted ONCE into its session as a system update with the observed facts (the message id is derived from the event, so a second scan posts nothing). A few of them ask
 * for an agent turn (`followUp: pending`): the agent then says what it means and puts up the next proposal. The bell lists an update for the people involved until they open the
 * session. Nothing here writes anything about the work itself: it only reads events and posts messages.
 */
import { appendEvent, withTx, type Queryable, type Tx } from "@gantry/db";
import type pg from "pg";
import { addWoMessage, updateId } from "./store.js";

export interface UpdateOpts { key: string; event: string; text: string; now: Date; followUp?: boolean }

/** Posts the update once. Returns false when this transition was already posted. */
export async function postWoUpdate(tx: Tx, orgId: string, wo: { id: string; project_id: string; title: string }, o: UpdateOpts): Promise<boolean> {
  const id = updateId(orgId, wo.id, o.key);
  const { rowCount } = await tx.query(`select 1 from workorder_messages where org_id = $1 and id = $2`, [orgId, id]);
  if (rowCount) return false;
  await addWoMessage(tx, orgId, wo.id, "system", "system", o.text, { kind: "update", mode: "rule-based", cards: [], event: o.event, ...(o.followUp ? { followUp: "pending" } : {}) }, o.now, id);
  await appendEvent(tx, {
    orgId, type: "wo.session.update", category: "flow", actor: "system", channel: "system", subject: { type: "wo", id: wo.id }, projectId: wo.project_id, woId: wo.id, outcome: "ok", occurredAt: o.now,
    after: { wo: wo.id, title: wo.title, event: o.event, text: o.text },
  });
  return true;
}

/** Who a session update concerns: the submitter, whoever spoke in the session or answered the intake questions, and the project's admins and line leads (through teams too). */
export async function involvedInWo(db: Queryable, orgId: string, woId: string, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ p: string }>(
    `select author as p from workorder_messages where org_id = $1 and wo_id = $2 and role = 'user'
     union select submitter from work_orders where org_id = $1 and id = $2 and submitter is not null
     union select author from messages where org_id = $1 and conversation_id = 'CONV-' || $2 and author_kind = 'person'
     union select person_id from effective_role_assignments where org_id = $1 and project_id = $3 and role_id in ('project_admin','line_lead') and revoked_at is null and (expires_at is null or expires_at > now())`,
    [orgId, woId, projectId],
  );
  return [...new Set(rows.map((r) => r.p).filter((p) => p && !p.startsWith("apikey:") && p !== "system"))];
}

const nameOf = async (db: Queryable, orgId: string, id: unknown): Promise<string> => {
  if (typeof id !== "string" || !id) return "someone";
  return (await db.query<{ name: string }>(`select name from people where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.name ?? id;
};

interface EventRow { id: string; type: string; wo_id: string; project_id: string; title: string; after: Record<string, unknown> | null; occurred_at: Date }

const SCANNED = ["wo.enter", "gate.waiting", "gate.decision", "wo.decline", "wo.bay", "wo.merged", "wo.station.done", "wo.sendback", "wo.classify", "gate.check", "wo.state", "release"];

/**
 * Posts the updates for events of the last days on work orders that have a session. Idempotent per event. `wo.classify` and a send-back to Intake ask the agent to follow up
 * (a new class or a returned brief needs a new draft).
 */
export async function scanWoEvents(pool: pg.Pool, orgId: string, now = new Date(), days = 3): Promise<number> {
  const { rows } = await pool.query<EventRow>(
    `select e.id, e.type, e.wo_id, w.project_id, w.title, e.after, e.occurred_at from events e join work_orders w on w.org_id = e.org_id and w.id = e.wo_id
      where e.org_id = $1 and e.wo_id is not null and e.type = any($2) and e.occurred_at > $3::timestamptz - ($4 || ' days')::interval and e.outcome = 'ok'
        and exists (select 1 from workorder_messages m where m.org_id = e.org_id and m.wo_id = e.wo_id)
      order by e.seq desc limit 200`,
    [orgId, SCANNED, now, String(days)],
  ).catch(async () => ({ rows: [] as EventRow[] }));
  let n = 0;
  for (const e of rows.reverse()) {
    const a = e.after ?? {};
    const st = typeof a.station === "string" ? a.station : "";
    let text = "";
    let followUp = false;
    switch (e.type) {
      case "wo.enter": text = `${e.wo_id} moved on to the ${st} station.`; break;
      case "wo.station.done": text = `The ${st} station finished${a.text ? `: ${String(a.text).slice(0, 300)}` : "."}`; break;
      case "gate.waiting": text = `Waiting at gate ${String(a.gate ?? "")}${a.text ? ` (${String(a.text)})` : ""}. Someone with the right needs to decide.`; break;
      case "gate.decision": text = `Gate ${String(a.gate ?? "")} ${typeof a.text === "string" && a.text.startsWith("rejected") ? a.text : `approved${a.by ? ` by ${await nameOf(pool, orgId, a.by)}` : a.mode === "auto" ? " automatically" : a.mode === "trust" ? " by trust" : ""}`}.`; break;
      case "gate.check": text = `A check at gate ${String(a.gate ?? "")} reported ${String(a.text ?? "a result")}.`; break;
      case "wo.decline": text = `The request was declined: ${String(a.text ?? "").slice(0, 300)}`; break;
      case "wo.bay": text = a.bay ? `Moved to the ${String(a.bay)} bay${a.text ? `: ${String(a.text).slice(0, 300)}` : "."}` : "Back on the belt."; break;
      case "wo.merged": text = `The pull request ${String(a.text ?? "")} was merged.`; break;
      case "wo.state": text = `The work order is now ${String(a.to ?? "")}${a.text ? `: ${String(a.text).slice(0, 300)}` : "."}`; break;
      case "wo.sendback": text = `Sent back to ${String(a.to ?? "an earlier station")}${a.text ? `: ${String(a.text).slice(0, 300)}` : "."}`; followUp = a.to === "intake"; break;
      case "wo.classify": if (a.initial === true) continue; text = `The class changed from ${String(a.from ?? "")} to ${String(a.to ?? "")}: ${String(a.text ?? "").slice(0, 300)}`; followUp = true; break;
      case "release": text = "The release was recorded."; break;
      default: continue;
    }
    if (!text) continue;
    // The station already said this in its own message, with its documents and questions.
    if (e.type === "wo.station.done" && typeof a.attempt === "string" && (await pool.query(`select 1 from workorder_messages where org_id = $1 and id = $2`, [orgId, updateId(orgId, e.wo_id, `station:${a.attempt}`)])).rowCount) continue;
    const posted = await withTx(pool, (tx) => postWoUpdate(tx, orgId, { id: e.wo_id, project_id: e.project_id, title: e.title }, { key: `ev:${e.id}`, event: e.type, text, now: e.occurred_at, followUp }));
    if (posted) n++;
  }
  return n;
}

/** Opens the session of a work order still at Intake that has none: a system line and a follow-up request, so the agent starts the dialogue by itself. */
export async function openIntakeSessions(pool: pg.Pool, orgId: string, now = new Date()): Promise<number> {
  const { rows } = await pool.query<{ id: string; project_id: string; title: string }>(
    `select w.id, w.project_id, w.title from work_orders w
      where w.org_id = $1 and w.position = 'intake' and w.state not in ('done','killed','declined') and w.source not in ('eval','onboarding') and w.created_at > $2::timestamptz - interval '14 days'
        and coalesce(w.data->>'classifyPending', '') not in ('pending', 'running')
        and not exists (select 1 from workorder_messages m where m.org_id = w.org_id and m.wo_id = w.id and m.data->>'event' is distinct from 'agent.classified') order by w.created_at limit 5`,
    [orgId, now],
  );
  let n = 0;
  for (const w of rows) if (await withTx(pool, (tx) => postWoUpdate(tx, orgId, w, { key: "opened", event: "session.opened", text: "The Intake conversation is open. The agent reads the request and will ask only what it needs.", now, followUp: true }))) n++;
  return n;
}
