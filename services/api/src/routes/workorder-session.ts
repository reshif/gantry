/**
 * The work-order session (spec 8.4, 11.3): one agent conversation per work order, for its whole life. Owns:
 *   GET  /api/v1/work-order-sessions                                          the list: who waits on whom, the latest message, the station (no forms)
 *   GET  /api/v1/work-orders/{id}/session                                     the conversation, the station agent's mode, the belt, the brief, the cost
 *   POST /api/v1/work-orders/{id}/session/messages                            a person's message (or `open`/`continue`); the agent's answer streams as SSE
 *   POST /api/v1/work-orders/{id}/session/proposals/{mid}/{pid}               approve | changes | discard a proposal card
 *   POST /api/v1/work-orders/{id}/session/seen                                the bell stops listing this session's updates for the caller
 *   GET  /api/v1/work-orders/{id}/session/people?q=                           people the composer's @ may offer (and whether they can already read the project)
 *   GET  /api/v1/access-requests, POST /api/v1/access-requests/{id}/dismiss  requests a mention opened for a person without access; the project's admins read and dismiss them
 *
 * The conversation runs on the API in the console's engine (the edge's service gateway, the bounded tool loop, SSE) with the tools of areas/workorders/session/tools.ts and the
 * pinned model of the CURRENT station's agent (the Intake Clerk at Intake). The agent understands, asks and proposes by itself; Gantry supplies observed facts, rails and permission
 * checks. An approval is the only way anything changes: it runs the ordinary command (confirm brief at G0+G1, reclassify, decline) under the approving person's own rights.
 * With no usable model the scripted questionnaire answers instead, labelled "Rule-based (no agent)".
 */
import { appendEvent, withTx, type Queryable } from "@gantry/db";
import { briefGateOff, can, SESSION_BUDGET_DEFAULT_USD, WO_AGENT_LABEL, classOf, classesOf, route, stationDef, visibleProjects, type Catalog, type FlowState, type Project, type WoCard, type WorkOrder } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { runConversation, ModelUnavailable, readiness, isVendorUnreachable, VENDOR_RETRY_DELAY_MS } from "../areas/console/model.js";
import { UNTRUSTED_NOTE } from "../areas/console/mark.js";
import { brokerInspect, brokerReadFile } from "../areas/onboarding/session/broker.js";
import { readRepoRow } from "../areas/onboarding/state.js";
import { composeSessionContext, recordTurnTuple } from "../areas/session/context.js";
import { agentBudgetUsd, historyFrom, openSse, stationAgentGate, turnCostMicros } from "../areas/session/core.js";
import { postMessage, reclassify, decline } from "../areas/workorders/intake.js";
import { applyAgentClass, claimClassifications, retryClassification, settleClassification } from "../areas/workorders/classify.js";
import { loadFlow, readWoRow, stateWithPinned, woVersion } from "../areas/workorders/model.js";
import { autoConfirmProposedBrief, confirmAgentBrief } from "../areas/workorders/session/approve.js";
import { addWoMessage, legacyMessages, listWoMessages, lockWoMessage, newWoMessageId, saveWoMessageData, supersedeWoPending, woSessionSpend, markWoSeen, type WoMessage } from "../areas/workorders/session/store.js";
import { executeWoTool, stationName, woToolDefs, type WoSessionCtx } from "../areas/workorders/session/tools.js";
import { openIntakeSessions, scanWoEvents } from "../areas/workorders/session/updates.js";
import { command, decide, decideFor, policyState, refuse, type CommandResult, type EventSpec } from "../core/index.js";
import { askedOfGone, asksMe, askOfLabel, requesterActive } from "../areas/workorders/asked.js";
import { listDialogue, listDocuments } from "../areas/workorders/documents.js";
import { listSources, planOf } from "../areas/workorders/research.js";
import { swarmOf } from "../areas/workorders/swarm.js";
import { openAccessRequests, recordMentions, searchMentionable, MAX_MENTIONS, type Mentioned } from "../areas/workorders/session/mentions.js";
import { endSentence } from "../core/text.js";
import { readSecurity } from "../core/read/index.js";

/** Output room for one turn: enough for a full brief (several lists) in a single tool call. */
export const WO_SESSION_MAX_TOKENS = 16_000;

const Id = z.object({ id: z.string().min(1).max(100) });
const ProposalParams = z.object({ id: z.string().min(1).max(100), mid: z.string().min(1).max(60), pid: z.string().min(1).max(40) });
const MessageBody = z.object({ text: z.string().trim().max(6000).optional(), kind: z.enum(["message", "open", "continue"]).default("message"), mentions: z.array(z.string().min(1).max(100)).max(MAX_MENTIONS).optional() }).strict();
const PeopleQ = z.object({ q: z.string().trim().min(1).max(60) });
const AccessQ = z.object({ project: z.string().max(100).optional() });
const DecisionBody = z.object({ decision: z.enum(["approve", "changes", "discard"]), text: z.string().trim().max(2000).optional() }).strict();
const ListQ = z.object({ project: z.string().max(100).optional() });

export const NO_AGENT_WO_TEXT = "No agent is available to talk to right now, so Gantry's scripted intake questions answer instead (rule-based, no agent). Connect a model vendor to talk to the Intake Clerk in your own words.";

const active = new Set<string>();
/** The runners of the running app (tests call them directly; the app runs them on a timer). */
export const woSessionJobs = { classify: async (): Promise<number> => 0, followUps: async (): Promise<number> => 0, scan: async (): Promise<number> => 0, open: async (): Promise<number> => 0 };

type Gate = Awaited<ReturnType<typeof stationAgentGate>>;
interface Mode { mode: "agent"; pin: Extract<Gate, { usable: true }>["pin"]; vendor: string; model: string; budget: { spentUsd: number; limitUsd: number } }
interface RuleMode { mode: "rule-based"; reason: string; budget: { spentUsd: number; limitUsd: number } }

const stationOf = (c: Catalog, w: WorkOrder): string => (w.bay ? (w.bayFrom ?? "intake") : (c.stations[w.station]?.id ?? "intake"));

/** The facts of this conversation: supplied by Gantry, never decided by the agent. */
const facts = (o: { agent: string; station: string; purpose: string; wo: string; project: string; person: string; canConfirm: boolean; atIntake: boolean; cls: string }): string => [
  `You are ${o.agent}, the agent at the ${o.station} station. This conversation is about ${o.wo} in project ${o.project}, and it lasts for the whole life of that work order. Station purpose: ${o.purpose}`,
  `You are talking with ${o.person}.${o.atIntake ? ` The work order is at Intake: the request was submitted as text and the person is waiting. Gantry classified it as ${o.cls}. ${o.canConfirm ? "This person may confirm the brief." : "This person may not confirm the brief; an approver with the right does."}` : " The work order is past Intake."}`,
].join("\n");

/** The fixed rules of the work-order session: evidence labelling, the card protocol and what the tools can and cannot do, the untrusted-data note and the answer cap. */
const rails = (o: { atIntake: boolean }): string => [
  "Facts about the work order, the project and the repository come only from your tools; say \"Gantry observed\" for tool results and \"I suggest\" for your own judgement; never present a guess as an observation. What a person tells you is their claim: use it and say it is theirs. You never change anything yourself: you propose, as cards, and a person approves; say plainly when something waits for their approval and never claim a change happened. Answer every message the person writes in plain sentences, then say the next concrete step.",
  o.atIntake
    ? "Tools at Intake: get_work_order, get_station_progress, inspect_repository, list_related_work read facts; read_file reads any text file of the repository at the assessed commit (read-only, secret and binary files refused, capped per turn). ask_user puts a question with suggested answers to the person. propose_brief (goal, scope in and out, acceptance criteria, risks, open questions, estimate) puts a brief up for confirmation; propose_reclassify and propose_decline put those proposals up. A blocking question (ask_user with blocking set) must be answered before a brief can be proposed. A question is closed only by a click on its own card or by you calling resolve_question with the person's exact words (Gantry checks them against what they wrote); when you must ask again, pass replaces with the old question's ref instead of posting a second card, and never ask a question that is already open. Never describe tool or system mechanics to the person (cards, ids, what Gantry holds or records): ask the question plainly, in your own words; open questions that do not block may stay open in a brief. Anything you proceed on without confirmation belongs in the brief as an assumption, said as such. How and how much you ask is for you to decide."
    : "Past Intake you cannot change anything: gates are decided by people on the work order's traveler. Your tools (get_work_order, get_station_progress) read facts: where it is, what each station did, what waits on whom.",
  UNTRUSTED_NOTE,
  "Keep each answer under 140 words. Plain sentences, no headings, no emoji.",
].join("\n\n");

export interface WoSessionRow {
  id: string; project: string; title: string; cls: string; station: string; stationName: string; state: string; bay: string | null; gate: string | null; agent: string | null; agentName: string | null;
  waitingOn: "you" | "approver" | "agent" | "person" | "nobody"; latest: { text: string; at: number; by: string; role: string } | null; unread: boolean; closed: boolean; started: boolean; requestedBy: string | null; createdAt: number; closedAt: number | null;
  /** "Asked of <name> (deactivated)" when an open blocking question is for a requester who is no longer active (S-31). */
  askedOf?: string;
}

/** The work-order sessions a person sees (the Conversations list and the workspace inbox): who waits on whom, the latest message, the station. */
export async function woSessionRows(db: Queryable, orgId: string, req: FastifyRequest, who: { id: string }, project: string | null, o: { all?: boolean } = {}): Promise<WoSessionRow[]> {
    const st = await policyState(req);
    const factory = st.people.find((x) => x.id === who.id)?.roles.some((r) => r.scope === "factory");
    const ids = factory ? null : visibleProjects(st, who.id).map((p) => p.id);
    // `all` (the workspace's Archived view) also lists work orders closed more than 14 days ago.
    const { rows: wos } = await db.query<{ id: string; project_id: string; title: string; class: string; position: string; state: string; submitter: string | null; created_at: Date; closed_at: Date | null }>(
      `select id, project_id, title, class, position, state, submitter, created_at, closed_at from work_orders
        where org_id = $1 and source not in ('eval','onboarding') and ($2::text is null or project_id = $2) and ($3::text[] is null or project_id = any($3))
          and ($4 or state not in ('done','killed','declined') and position <> 'declined' or coalesce(closed_at, created_at) > now() - interval '14 days')
        order by created_at desc limit ${o.all ? 400 : 200}`,
      [orgId, project ?? null, ids, o.all === true],
    );
    const woIds = wos.map((w) => w.id);
    const [lastRows, seenRows, gateRows, legacyRows, agentRows] = await Promise.all([
      db.query<{ wo_id: string; role: string; author: string; body: string; data: WoMessage["data"]; created_at: Date }>(`select distinct on (wo_id) wo_id, role, author, body, data, created_at from workorder_messages where org_id = $1 and wo_id = any($2) order by wo_id, created_at desc, id desc`, [orgId, woIds]),
      db.query<{ wo_id: string; seen_at: Date }>(`select wo_id, seen_at from workorder_session_seen where org_id = $1 and person_id = $2 and wo_id = any($3)`, [orgId, who.id, woIds]),
      db.query<{ wo_id: string; gate_id: string }>(`select wo_id, gate_id from gate_instances where org_id = $1 and status = 'open' and wo_id = any($2)`, [orgId, woIds]),
      db.query<{ wo_id: string; author_kind: string; body: string; created_at: Date; status: string }>(`select distinct on (c.wo_id) c.wo_id, m.author_kind, m.body, m.created_at, c.status from conversations c join messages m on m.org_id = c.org_id and m.conversation_id = c.id where c.org_id = $1 and c.wo_id = any($2) order by c.wo_id, m.created_at desc, m.id desc`, [orgId, woIds]),
      db.query<{ id: string; name: string }>(`select id, name from agents where org_id = $1`, [orgId]),
    ]);
    const askRows = (await db.query<{ wo_id: string; ask_of: string }>(`select wo_id, ask_of from wo_questions where org_id = $1 and status = 'open' and blocking and wo_id = any($2)`, [orgId, woIds])).rows;
    const pst = await policyState(req);
    const meP = pst.people.find((p) => p.id === who.id);
    const last = new Map(lastRows.rows.map((r) => [r.wo_id, r]));
    const seen = new Map(seenRows.rows.map((r) => [r.wo_id, r.seen_at.getTime()]));
    const gates = new Map(gateRows.rows.map((r) => [r.wo_id, r.gate_id]));
    const legacy = new Map(legacyRows.rows.map((r) => [r.wo_id, r]));
    const names = new Map(agentRows.rows.map((a) => [a.id, a.name]));
    const catalog = st.catalog;
    const items = wos.map((w) => {
      const m = last.get(w.id);
      const l = legacy.get(w.id);
      const closed = w.state === "done" || w.state === "killed" || w.state === "declined" || w.position === "declined";
      const bay = catalog.bays.some((b) => b.id === w.position);
      const sid = bay ? "intake" : w.position;
      const stn = stationDef(catalog, sid);
      const pending = !!m && m.role === "assistant" && (m.data.cards ?? []).some((c) => (c.kind === "proposal" && c.status === "pending") || (c.kind === "question" && c.answered === undefined && !c.superseded));
      const gate = gates.get(w.id) ?? null;
      const asks = askRows.filter((a) => a.wo_id === w.id);
      const askedMe = asks.some((a) => asksMe(a.ask_of, meP, { project: w.project_id, requestedBy: w.submitter, requesterActive: requesterActive(pst.people, w.submitter) }, (act) => decideFor(pst, req.gx.principal!, act, { project: w.project_id }).allowed));
      const waitingOn: "you" | "approver" | "agent" | "person" | "nobody" = closed ? "nobody"
        : pending ? "you"
        : asks.length ? (askedMe ? "you" : "person")
        : w.position === "person" || w.state === "failed" || w.state === "blocked" ? "you"
        : gate ? "approver"
        : m && m.role === "user" ? "agent"
        : l && l.status === "open" && l.author_kind === "agent" && !m ? "you"
        : "agent";
      const latest = m ? { text: m.body, at: m.created_at.getTime(), by: m.author, role: m.role } : l ? { text: l.body, at: l.created_at.getTime(), by: l.author_kind === "person" ? "person" : "ag-intake", role: l.author_kind === "person" ? "user" : "assistant" } : null;
      const unread = !!m && m.role !== "user" && m.created_at.getTime() > (seen.get(w.id) ?? 0);
      return {
        id: w.id, project: w.project_id, title: w.title, cls: w.class, station: sid, stationName: bay ? (catalog.bays.find((b) => b.id === w.position)?.name ?? w.position) : stn?.name ?? sid, state: w.state, bay: bay ? w.position : null, gate,
        agent: stn?.agent ?? null, agentName: stn?.agent ? (names.get(stn.agent) ?? stn.name) : null, waitingOn, latest, unread, closed, started: !!m, requestedBy: w.submitter, createdAt: w.created_at.getTime(), closedAt: closed ? (w.closed_at ?? w.created_at).getTime() : null,
        ...(asks.some((a) => a.ask_of === "requester" || a.ask_of === "anyone") && askedOfGone(pst.people, w.submitter) ? { askedOf: askedOfGone(pst.people, w.submitter)! } : {}),
      };
    });
    return items;
}

export const workOrderSessionRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const inspect = brokerInspect({ brokerUrl: g.config.brokerUrl, token: g.config.secrets.githubToken });
  const readFile = brokerReadFile({ brokerUrl: g.config.brokerUrl, token: g.config.secrets.githubToken });

  const person = (req: FastifyRequest): { id: string; name: string } => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "The work-order session is for signed-in people.");
    return { id: p.id, name: p.name };
  };
  const scopeOf = (w: { id: string; project: string; repo: string | null }) => ({ project: w.project, repo: w.repo, wo: w.id });

  /** The work order, for a person who holds project.view on its project (read is default-deny; anything else is a 404). */
  async function woOf(req: FastifyRequest, id: string) {
    const who = person(req);
    const row = await readWoRow(g.pool, g.orgId, id);
    if (!row) throw refuse("not_found", "No such work order.");
    const st = await policyState(req);
    const p = st.people.find((x) => x.id === who.id);
    const seen = p?.roles.some((r) => r.scope === "factory") || visibleProjects(st, who.id).some((x) => x.id === row.project);
    if (!seen || !(await decide(req, "project.view", { project: row.project })).allowed) throw refuse("not_found", "No such work order.");
    return { row, who };
  }

  async function flowOf(row: { id: string; project: string; flowVersion: number }): Promise<{ st: FlowState; wo: WorkOrder; project: Project; catalog: Catalog }> {
    const loaded = await loadFlow(g.pool, g.orgId, { ids: [row.id] });
    const st = await stateWithPinned(g.pool, g.orgId, loaded, row);
    const wo = st.workOrders[0];
    if (!wo) throw refuse("not_found", "No such work order.");
    return { st, wo, project: st.projects.find((p) => p.id === row.project)!, catalog: st.catalog };
  }

  /** The station agent for this work order now (a per-work-order override wins), whether it can take a turn, and its budget for this session. */
  async function agentState(row: { id: string; project: string; repo: string | null; data: Record<string, unknown> }, wo: WorkOrder, catalog: Catalog): Promise<(Mode | RuleMode) & { agentId: string; agentName: string; station: string }> {
    const sid = stationOf(catalog, wo);
    const st = stationDef(catalog, sid);
    const override = (row.data.agentOverride as Record<string, string> | undefined)?.[sid];
    const agentId = override ?? st?.agent ?? "";
    const agentName = (await g.pool.query<{ name: string }>(`select name from agents where org_id = $1 and id = $2`, [g.orgId, agentId])).rows[0]?.name ?? st?.name ?? "Station agent";
    const spent = await woSessionSpend(g.pool, g.orgId, row.id);
    const limit = await agentBudgetUsd(g.pool, g.orgId, agentId, SESSION_BUDGET_DEFAULT_USD);
    const budget = { spentUsd: spent / 1e6, limitUsd: limit };
    const base = { agentId, agentName, station: sid, budget };
    const gate = await stationAgentGate(g.pool, g.orgId, agentId, { station: sid, project: row.project, repoId: row.repo }).catch((e: Error) => ({ usable: false as const, reason: `The agent could not be checked: ${e.message}` }));
    if (!gate.usable) return { ...base, mode: "rule-based", reason: gate.reason };
    if (spent >= limit * 1e6) return { ...base, mode: "rule-based", reason: `${agentName}'s budget for this work order ($${limit.toFixed(2)}) is spent. Raise the agent's budget to talk to it again.` };
    const ready = await readiness(g.config.secrets.edgeToken, "console", { model: gate.pin.model, project: row.project });
    if (!ready.ready) return { ...base, mode: "rule-based", reason: ready.reason };
    return { ...base, mode: "agent", pin: gate.pin, vendor: ready.vendor, model: ready.model };
  }

  /** Whether this person may talk on the work order: the requester always may; anyone else needs the right to answer (wo.answer). */
  async function canTalk(req: FastifyRequest, row: { id: string; project: string; repo: string | null; submitter: string | null }, who: { id: string }): Promise<{ allowed: boolean; reason: string }> {
    if (row.submitter === who.id) return { allowed: true, reason: "" };
    const d = await decide(req, "wo.answer", scopeOf(row));
    return { allowed: d.allowed, reason: d.allowed ? "" : d.reason };
  }

  /** The scouts with what their attempts and runs say now (state, turn, cost). */
  async function swarmView(data: Record<string, unknown>, woId: string) {
    const sw = swarmOf(data);
    if (!sw) return null;
    const rows = (await g.pool.query<{ id: string; state: string; turn: number | null; micros: string }>(
      `select a.id, a.state, (r.data->'heartbeat'->>'turn')::int as turn, coalesce((select sum(cost_micros) from run_usage u where u.org_id = a.org_id and u.attempt_id = a.id), 0)::text as micros
         from attempts a left join runs r on r.org_id = a.org_id and r.attempt_id = a.id where a.org_id = $1 and a.wo_id = $2 and a.id = any($3)`, [g.orgId, woId, sw.scouts.map((x) => x.attempt)],
    )).rows;
    return {
      ...sw,
      scouts: sw.scouts.map((x) => {
        const r = rows.find((y) => y.id === x.attempt);
        const live = r && (r.state === "queued" || r.state === "running") ? (r.state as "queued" | "running") : null;
        const gone = r && (r.state === "superseded" || r.state === "cancelled") && (x.state === "queued" || x.state === "running");
        return { ...x, state: live ?? (gone ? "stopped" : x.state), turn: r?.turn ?? null, costUsd: Number(r?.micros ?? 0) / 1e6 };
      }),
    };
  }

  const briefOpenOf = (wo: WorkOrder, catalog: Catalog): boolean => !wo.bay && stationOf(catalog, wo) === "intake" && !!wo.gates.G0G1 && wo.gates.G0G1.status !== "passed" && wo.state !== "done" && wo.state !== "killed";

  function ctxFor(row: { repo: string | null }, repoFull: string | null, f: { st: FlowState; wo: WorkOrder; project: Project; catalog: Catalog }, who: { id: string; name: string }, ag: (Mode | RuleMode) & { agentId: string; agentName: string }): WoSessionCtx {
    void row;
    return {
      db: g.pool, orgId: g.orgId, wo: f.wo, st: f.st, project: f.project, catalog: f.catalog, repoFull, inspect, readFile, person: who,
      // The model the route resolves for the call (what the meter will record), not the agent's pinned wish.
      agent: ag.mode === "agent" ? { id: ag.agentId, name: ag.agentName, version: ag.pin.version, model: ag.model } : null,
      withTx: (fn) => withTx(g.pool, fn), briefOpen: briefOpenOf(f.wo, f.catalog), cards: [], drafts: {}, used: [], next: 1,
    };
  }
  const repoFullOf = async (repoId: string | null): Promise<string | null> => {
    if (!repoId) return null;
    const r = await readRepoRow(g.pool, g.orgId, repoId);
    return r ? (r.github_full_name ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.name) ? r.name : null)) : null;
  };

  /** Saves one assistant (or system) message with its cards, replaces older pending proposals, and records who said it in the audit. */
  async function persist(row: { id: string; project: string }, role: "assistant" | "system", author: string, text: string, data: WoMessage["data"], onBehalfOf: string, ev: Record<string, unknown>): Promise<string> {
    const id = newWoMessageId();
    await withTx(g.pool, async (tx) => {
      if ((data.cards ?? []).some((c) => c.kind === "proposal")) await supersedeWoPending(tx, g.orgId, row.id, id, ["brief", "reclassify", "decline"]);
      const now = new Date();
      await addWoMessage(tx, g.orgId, row.id, role, author, text, data, now, id);
      await appendEvent(tx, {
        orgId: g.orgId, type: "wo.session.answer", category: "flow", actor: role === "assistant" ? author : "system", channel: "system", onBehalfOf,
        subject: { type: "wo", id: row.id }, projectId: row.project, woId: row.id, outcome: "ok", occurredAt: now, after: { message: id, chars: text.length, cards: (data.cards ?? []).map((c) => c.kind), ...ev },
      });
    });
    return id;
  }

  /** One turn of the station agent: history (the scripted history included), the tool loop (cards are sent as they appear), the cost, the saved answer. Throws ModelUnavailable. */
  async function agentTurn(o: { row: NonNullable<Awaited<ReturnType<typeof readWoRow>>>; who: { id: string; name: string }; canConfirm: boolean; ag: Mode & { agentId: string; agentName: string; station: string }; question: string; kind: "message" | "open" | "continue" | "followup"; send: (e: string, d: unknown) => void; signal: AbortSignal }): Promise<string> {
    const f = await flowOf(o.row);
    const ctx = ctxFor(o.row, await repoFullOf(o.row.repo), f, o.who, o.ag);
    const prior = [...(await legacyMessages(g.pool, g.orgId, o.row.id, { withScripted: false })), ...(await listWoMessages(g.pool, g.orgId, o.row.id, 30))];
    const { hist, question } = historyFrom(prior.map((m) => ({ role: m.role, text: m.text })), o.kind, o.question, { take: 16 });
    const atIntake = ctx.briefOpen;
    const defs = woToolDefs().filter((t) => atIntake || !/^(propose_|ask_user)/.test(t.name));
    // The agent's own instructions and skills, composed like a station run; code adds the facts and the fixed rules.
    const sc = await composeSessionContext(g.pool, {
      orgId: g.orgId, surface: atIntake ? "intake" : "work_order", agentId: o.ag.agentId, agentVersion: o.ag.pin.version, model: o.ag.pin.model, projectId: o.row.project, repoId: o.row.repo,
      facts: facts({ agent: o.ag.agentName, station: stationName(f.catalog, o.ag.station), purpose: stationDef(f.catalog, o.ag.station)?.purpose ?? "", wo: o.row.id, project: f.project.name, person: o.who.name, canConfirm: o.canConfirm, atIntake, cls: classOf(f.catalog, f.project, f.wo.cls).name }),
      rails: rails({ atIntake }),
    });
    if (!sc) throw new ModelUnavailable("no_agent_context", `${o.ag.agentName} has no live version to speak from.`);
    // The turn runs only if its tuple is recorded: a message must never point at a tuple with no row.
    await recordTurnTuple(g.pool, g.orgId, sc.turn).catch((e: Error) => {
      app.log.error({ err: e, tuple: sc.turn.tupleId }, "session tuple not recorded");
      throw new ModelUnavailable("tuple_not_recorded", "This turn could not be recorded, so it was not run. Try again; if it keeps happening, tell a Factory Admin.");
    });
    const r = await runConversation({
      edgeToken: g.config.secrets.edgeToken, purpose: "console", pick: { model: o.ag.pin.model, project: o.row.project }, maxTokens: WO_SESSION_MAX_TOKENS, maxSteps: 8,
      system: sc.system,
      history: hist, question, signal: o.signal, trace: { parts: sc.parts, surface: "workorder", actor: o.who.id, project: o.row.project, woId: o.row.id },
      toolset: { defs, execute: async (name, input) => {
        const before = ctx.cards.length;
        const out = await executeWoTool(ctx, name, input);
        for (const c of ctx.cards.slice(before)) o.send("card", { card: c });
        return out;
      } },
      onText: (delta) => o.send("text", { delta }), onTool: (t) => o.send("tool", t),
    });
    const model = r.model ?? o.ag.pin.model;
    const micros = await turnCostMicros(g.pool, g.orgId, model, r.usage);
    const text = r.text || (r.stopped ? "" : r.truncated ? "My answer was cut off at the output limit before I finished, so nothing was proposed. Ask me to continue." : "The model returned no text.");
    const savedId = await persist(o.row, "assistant", o.ag.agentId, text, {
      mode: "agent", model, agent: o.ag.agentName, version: o.ag.pin.version, station: o.ag.station, context: sc.turn, cards: ctx.cards, drafts: ctx.drafts, tools: ctx.used, usage: r.usage, costMicros: micros, ...(r.stopped ? { stopped: true } : {}), ...(r.truncated ? { truncated: true } : {}),
    }, o.who.id, { mode: "agent", model, agent: o.ag.agentId, version: o.ag.pin.version, skills: sc.turn.skillVersions, instructionHash: sc.turn.instructionHash, promptHash: sc.turn.promptHash, tuple: sc.turn.tupleId, tools: ctx.used, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costMicros: micros });
    // The brief gate (G0+G1) switched off by an admin override: a brief the agent proposes is the brief; nobody has to approve the card for the work order to move on.
    if (briefGateOff(f.project)) {
      for (const c of ctx.cards) {
        if (c.kind !== "proposal" || c.what !== "brief") continue;
        await withTx(g.pool, (tx) => autoConfirmProposedBrief(tx, g.orgId, o.row.id, savedId, c.id)).catch((e: Error) => app.log.error({ err: e, wo: o.row.id }, "auto-confirm of the proposed brief failed; the card stays for a person"));
      }
    }
    return savedId;
  }

  /** Follow-ups: an update that asked for one (data.followUp = pending) gets an agent turn that says what it means and puts up the next proposal. Never writes anything about the work. */
  async function runFollowUps(): Promise<number> {
    const { rows } = await g.pool.query<{ id: string; wo_id: string; body: string; ev: string | null; retried: string | null }>(
      `update workorder_messages set data = jsonb_set(data, '{followUp}', '"running"') where org_id = $1 and id in (select id from workorder_messages where org_id = $1 and data->>'followUp' = 'pending' and coalesce((data->>'followUpRetryAt')::bigint, 0) <= $2::bigint order by created_at limit 3 for update skip locked) returning id, wo_id, body, data->>'event' as ev, data->>'followUpRetried' as retried`,
      [g.orgId, Date.now()],
    );
    const done = (id: string, status: string) => g.pool.query(`update workorder_messages set data = jsonb_set(data, '{followUp}', to_jsonb($3::text)) where org_id = $1 and id = $2`, [g.orgId, id, status]);
    let n = 0;
    for (const m of rows) {
      const row = await readWoRow(g.pool, g.orgId, m.wo_id);
      if (!row) { await done(m.id, "skipped"); continue; }
      if (active.has(row.id)) { await done(m.id, "pending"); continue; }
      // Claim the work order in the same tick as the check (no await between): a check, a wait and then an add let two turns pass the check (statechart intake-questions, race).
      active.add(row.id);
      try {
        // The "conversation is open" nudge starts the dialogue once: if the agent already spoke (the person's own opening turn ran first), a second opening turn would ask everything again.
        if (m.ev === "session.opened" && (await g.pool.query(`select 1 from workorder_messages where org_id = $1 and wo_id = $2 and role = 'assistant' and data->>'mode' = 'agent' limit 1`, [g.orgId, row.id])).rows.length) { await done(m.id, "skipped"); continue; }
        const f = await flowOf(row);
        const ag = await agentState(row, f.wo, f.catalog);
        if (ag.mode === "agent") {
          await agentTurn({
            row, who: { id: "system", name: "Gantry" }, canConfirm: true, ag, kind: "followup", send: () => undefined, signal: AbortSignal.timeout(180_000),
            question: `(Gantry observed, and posted in this conversation: "${m.body.slice(0, 600)}". Say in a few plain sentences what this means for the person. If this is the start of the conversation, read the request and either ask the one thing you need or propose the brief. If the class or the brief needs redoing, draft it again. If you wait on someone, say who and that Gantry will post here and notify them: never ask them to ask again.)`,
          });
        }
        await done(m.id, "done");
        n++;
      } catch (e) {
        app.log.error({ err: e }, "work-order session follow-up failed");
        // A network drop (the vendor could not be reached) gets one more automatic attempt after a pause; the person sees the failure only if that one fails too.
        if (isVendorUnreachable(e) && m.retried !== "true") {
          await g.pool.query(`update workorder_messages set data = jsonb_set(jsonb_set(jsonb_set(data, '{followUp}', '"pending"'), '{followUpRetried}', 'true'), '{followUpRetryAt}', to_jsonb($3::bigint)) where org_id = $1 and id = $2`, [g.orgId, m.id, Date.now() + VENDOR_RETRY_DELAY_MS]);
        } else await done(m.id, "failed");
      } finally {
        active.delete(row.id);
      }
    }
    return n;
  }
  /** The Intake agent classifies new requests that named no class: one bounded model call with the work-order tools, which ends in `set_class`. */
  async function classifyTurn(row: NonNullable<Awaited<ReturnType<typeof readWoRow>>>, ag: Mode & { agentId: string; agentName: string; station: string }): Promise<{ text: string; applied: Awaited<ReturnType<typeof applyAgentClass>> | null; reason: string }> {
    const f = await flowOf(row);
    const who = { id: "system", name: "Gantry" };
    const ctx = ctxFor(row, await repoFullOf(row.repo), f, who, ag);
    const classes = classesOf(f.catalog, f.project);
    let chosen: { cls: string; confidence: number; rationale: string } | null = null;
    const sc = await composeSessionContext(g.pool, {
      orgId: g.orgId, surface: "intake", agentId: ag.agentId, agentVersion: ag.pin.version, model: ag.pin.model, projectId: row.project, repoId: row.repo,
      facts: `You are ${ag.agentName}, the agent at the Intake station. A new request (${row.id}) arrived in project ${f.project.name} and no person named a class. Gantry's keyword match (${f.wo.cls}) is only a placeholder: it is not evidence.`,
      rails: [
        "Classify this one request. Read it with get_work_order, and read the repository when that helps (inspect_repository, then read_file for AGENTS.md, the README and the build files): the repository's own rules can change what kind of work this is. Then call set_class exactly once with a class id from get_work_order availableClasses, your own confidence between 0 and 1 and a rationale in your own plain words: what in the request and the repository made you choose it, and what else it could have been. Say nothing the tools did not show you. Ask no questions here; a conversation with the person follows. You change nothing else.",
        UNTRUSTED_NOTE,
      ].join("\n\n"),
    });
    if (!sc) throw new ModelUnavailable("no_agent_context", `${ag.agentName} has no live version to speak from.`);
    await recordTurnTuple(g.pool, g.orgId, sc.turn).catch(() => { throw new ModelUnavailable("tuple_not_recorded", "The classification turn could not be recorded, so it was not run."); });
    const readTools = woToolDefs().filter((t) => ["get_work_order", "inspect_repository", "read_file", "list_related_work"].includes(t.name));
    const setClass = { name: "set_class", description: "Set the class of this request: your classification, with your own confidence and rationale. A person can still change it.", input_schema: { type: "object", properties: { cls: { type: "string", description: "A class id from get_work_order availableClasses." }, confidence: { type: "number", description: "Your confidence between 0 and 1." }, rationale: { type: "string" } }, required: ["cls", "confidence", "rationale"] } };
    const r = await runConversation({
      edgeToken: g.config.secrets.edgeToken, purpose: "console", pick: { model: ag.pin.model, project: row.project }, maxTokens: 2_000, maxSteps: 6, system: sc.system, history: [],
      question: "(A new request needs a class. Read it and classify it with set_class.)", signal: AbortSignal.timeout(120_000), trace: { parts: sc.parts, surface: "workorder", actor: "system", project: row.project, woId: row.id },
      toolset: { defs: [...readTools, setClass], execute: async (name, input) => {
        if (name !== "set_class") return executeWoTool(ctx, name, input);
        const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        const cls = typeof i.cls === "string" ? i.cls.trim() : "";
        const confidence = typeof i.confidence === "number" ? i.confidence : NaN;
        const rationale = typeof i.rationale === "string" ? i.rationale.trim().slice(0, 600) : "";
        if (!classes.some((c) => c.id === cls)) return { text: JSON.stringify({ error: "Unknown class. Use an id from get_work_order availableClasses." }), ok: false };
        if (!(confidence >= 0 && confidence <= 1)) return { text: JSON.stringify({ error: "confidence must be a number between 0 and 1." }), ok: false };
        if (rationale.length < 5) return { text: JSON.stringify({ error: "Give your rationale in a sentence." }), ok: false };
        chosen = { cls, confidence, rationale };
        return { text: JSON.stringify({ ok: true, note: "Recorded as your classification. You are done." }), ok: true };
      } },
      onText: () => undefined, onTool: () => undefined,
    });
    const model = r.model ?? ag.pin.model;
    const micros = await turnCostMicros(g.pool, g.orgId, model, r.usage);
    const picked = chosen as { cls: string; confidence: number; rationale: string } | null;
    const applied = picked ? await applyAgentClass(g.pool, g.orgId, row.id, { ...picked, agent: { id: ag.agentId, name: ag.agentName, version: ag.pin.version, model } }) : null;
    const name = picked ? classOf(f.catalog, f.project, picked.cls).name : "";
    const text = picked ? `Class by ${ag.agentName}: ${name}, confidence ${Math.round(picked.confidence * 100)}%. ${picked.rationale}${applied && !applied.applied ? ` Not applied: ${applied.why}` : ""}` : `${ag.agentName} did not set a class.`;
    await persist(row, "assistant", ag.agentId, text, { kind: "update", event: "agent.classified", mode: "agent", model, agent: ag.agentName, version: ag.pin.version, station: ag.station, context: sc.turn, cards: [], tools: ctx.used, usage: r.usage, costMicros: micros }, "system", { mode: "agent", model, agent: ag.agentId, kind: "classify", tuple: sc.turn.tupleId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costMicros: micros });
    return { text, applied, reason: picked ? "" : "The agent returned no class." };
  }

  /** The classification job: claims new requests that named no class and asks the Intake agent; the keyword match stays only where no model is usable (labelled so). */
  async function runClassify(): Promise<number> {
    let n = 0;
    for (const id of await claimClassifications(g.pool, g.orgId)) {
      try {
        const row = await readWoRow(g.pool, g.orgId, id);
        if (!row) continue;
        const f = await flowOf(row);
        const ag = await agentState(row, f.wo, f.catalog);
        if (ag.mode !== "agent") { await settleClassification(g.pool, g.orgId, id, "rule", ag.reason); continue; }
        const out = await classifyTurn(row, ag);
        if (!out.applied) await settleClassification(g.pool, g.orgId, id, "rule", out.reason);
        else if (out.applied.applied) n++;
      } catch (e) {
        app.log.error({ err: e }, "intake classification failed");
        if (isVendorUnreachable(e) && (await retryClassification(g.pool, g.orgId, id, Date.now() + VENDOR_RETRY_DELAY_MS).catch(() => false))) continue;
        await settleClassification(g.pool, g.orgId, id, "failed", e instanceof ModelUnavailable ? e.message : "The classification call failed.").catch(() => undefined);
      }
    }
    return n;
  }
  woSessionJobs.classify = runClassify;
  woSessionJobs.followUps = runFollowUps;
  woSessionJobs.scan = () => scanWoEvents(g.pool, g.orgId);
  woSessionJobs.open = () => openIntakeSessions(g.pool, g.orgId);
  if (process.env.NODE_ENV !== "test") {
    const tick = (): void => void (async () => { await runClassify(); await openIntakeSessions(g.pool, g.orgId); await scanWoEvents(g.pool, g.orgId); await runFollowUps(); })().catch((e) => app.log.error({ err: e }, "work-order session jobs"));
    const timer = setInterval(tick, 15_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  /* ------------------------------------------------------------------ the list */

  app.get("/api/v1/work-order-sessions", async (req) => {
    const who = person(req);
    const q = ListQ.parse(req.query);
    const items = await woSessionRows(g.pool, g.orgId, req, who, q.project ?? null);
    return { items, next: null, total: items.length };
  });

  /* ------------------------------------------------------------------ read */

  app.get("/api/v1/work-orders/:id/session", async (req) => {
    const { id } = Id.parse(req.params);
    const { row, who } = await woOf(req, id);
    const f = await flowOf(row);
    const wo = f.wo;
    const c = f.catalog;
    const ag = await agentState(row, wo, c);
    const [own, confirm, legacy, mine, dialogue, pst] = await Promise.all([
      canTalk(req, row, who), decide(req, "brief.confirm", scopeOf(row)), legacyMessages(g.pool, g.orgId, id), listWoMessages(g.pool, g.orgId, id), listDialogue(g.pool, g.orgId, id), policyState(req),
    ]);
    // Station questions still open, and whether this person is the one asked (G11).
    const meP = pst.people.find((p) => p.id === who.id);
    const openAsks = dialogue.questions.filter((q) => q.status === "open");
    const blockingAsks = openAsks.filter((q) => q.blocking);
    const askedMe = blockingAsks.some((q) => asksMe(q.askOf, meP, { project: row.project, requestedBy: wo.requestedBy, requesterActive: requesterActive(pst.people, wo.requestedBy) }, (act) => decideFor(pst, req.gx.principal!, act, { project: row.project }).allowed));
    const roleName = (rid: string) => (f.catalog.roles ?? []).find((r) => r.id === rid)?.name ?? rid.replace(/_/g, " ");
    const gone = askedOfGone(pst.people, wo.requestedBy);
    const askedOf = [...new Set(blockingAsks.map((q) => (gone && q.askOf === "requester" ? `${gone.replace(/^Asked of /, "")}, so the project admins and line leads` : askOfLabel(q.askOf, roleName))))].join(" or ");
    const planWaiting = planOf(row.data)?.status === "proposed" ? planOf(row.data) : null;
    const canDecidePlan = planWaiting ? (await decide(req, "gate.approve", scopeOf(row))).allowed : false;
    // The scripted questionnaire is history: shown until the session starts, never mixed into it afterwards.
    // With an agent talking, Gantry's scripted questions and notes are not shown at all (they were never an agent's words); in rule-based mode they are the conversation, labelled as such.
    const legacyShown = ag.mode === "agent" ? legacy.filter((m) => !m.data.scripted) : legacy;
    const messages = mine.length ? mine : legacyShown;
    const history = mine.length ? legacyShown.filter((m) => m.at < (mine[0]?.at ?? 0)) : [];
    const cards = mine.flatMap((m) => (m.data.cards ?? []).map((cd) => ({ m, cd })));
    const pending = cards.filter((x): x is { m: WoMessage; cd: Extract<WoCard, { kind: "proposal" }> } => x.cd.kind === "proposal" && x.cd.status === "pending").map((x) => ({ mid: x.m.id, id: x.cd.id, what: x.cd.what, title: x.cd.title }));
    const lastM = mine.at(-1);
    const openQuestion = !!lastM && lastM.role === "assistant" && (lastM.data.cards ?? []).some((cd) => cd.kind === "question");
    const sid = ag.station;
    const closed = wo.state === "done" || wo.state === "killed" || wo.bay === "declined";
    const gateWaiting = Object.entries(wo.gates).find(([, gi]) => gi.status === "waiting");
    const atIntake = briefOpenOf(wo, c);
    const r = route(c, f.project, wo.cls);
    const stepIdx = r.indexOf(sid);
    const cls = classOf(c, f.project, wo.cls);
    const gdef = gateWaiting ? c.gates.find((x) => x.id === gateWaiting[0]) : null;
    // A failed or blocked work order is not being worked on: it waits for a person, with the reason, and Retry or another agent is what moves it.
    const stuck = !closed && (wo.state === "failed" || wo.state === "blocked" || (wo.bay === "person" && (wo.bayCause === "failed" || wo.bayCause === "merge")));
    const stuckWhy = (wo.state === "failed" ? wo.failReason : wo.state === "blocked" ? wo.blockReason : wo.bayReason) || `${stationName(c, sid)} did not finish.`;
    const next = closed ? { actor: "nobody", text: wo.bay === "declined" ? "The request was declined." : wo.state === "done" ? "The work order is finished." : "The work order was killed." }
      : stuck ? { actor: "you", text: `${stationName(c, sid)} ${wo.state === "blocked" ? "is blocked" : "stopped"}: ${stuckWhy} A person can retry it or assign another agent.` }
      : pending.length ? (confirm.allowed || !pending.some((p) => p.what === "brief") ? { actor: "you", text: "Review the proposal below: approve it, ask for changes, or discard it." } : { actor: "approver", text: "An approver with the right to confirm briefs has to approve the proposal." })
      : blockingAsks.length ? (askedMe ? { actor: "you", text: `${stationName(c, blockingAsks[0]!.station)} is waiting for your answer${blockingAsks.length > 1 ? `s to ${blockingAsks.length} questions` : ""} below.` } : { actor: "person", text: `${stationName(c, blockingAsks[0]!.station)} is waiting for an answer from ${askedOf}.` })
      : openQuestion ? { actor: "you", text: "Answer the agent's question (click a suggestion or write your own)." }
      : atIntake ? (ag.mode === "agent" ? { actor: "agent", text: `${ag.agentName} reads the request and will ask or propose the brief.` } : { actor: wo.conv.done ? "approver" : "you", text: wo.conv.done ? "Confirm the brief." : "Answer the intake question below." })
      : gateWaiting ? { actor: "approver", text: `Waiting for a decision at ${gdef?.label ?? gateWaiting[0]}${gdef?.purpose ? `: ${gdef.purpose}` : "."}` }
      : planWaiting ? (canDecidePlan ? { actor: "you", text: `${stationName(c, planWaiting.station)} proposed a research plan: approve it, change its hosts or budget, or reject it.` } : { actor: "approver", text: `${stationName(c, planWaiting.station)} proposed a research plan; someone who may approve gates decides it.` })
      : wo.bay ? { actor: "you", text: `${wo.id} is in the ${c.bays.find((b) => b.id === wo.bay)?.name ?? wo.bay} bay; a person has to move it on.` }
      : { actor: "agent", text: `${ag.agentName} works at ${stationName(c, sid)}.` };
    const swarmLive = swarmOf(row.data);
    const scoutsLive = swarmLive && !swarmLive.endedAt ? swarmLive.scouts.filter((x) => x.state === "queued" || x.state === "running").length : 0;
    const waiting = closed ? null : stuck ? { text: `${stationName(c, sid)} ${wo.state === "blocked" ? "is blocked" : "stopped"}: waiting for a person to retry it`, kind: "you" as const } : scoutsLive ? { text: `${scoutsLive} scout${scoutsLive === 1 ? "" : "s"} working at ${stationName(c, swarmLive!.station)}`, kind: "agent" }
      : planWaiting && !blockingAsks.length ? { text: `Waiting for ${canDecidePlan ? "you" : "an approver"}: the research plan from ${stationName(c, planWaiting.station)}`, kind: canDecidePlan ? "you" : "gate" }
      : blockingAsks.length ? { text: `Waiting for ${askedMe ? "you" : askedOf}: ${blockingAsks.length === 1 ? "1 question" : `${blockingAsks.length} questions`} from ${stationName(c, blockingAsks[0]!.station)}`, kind: askedMe ? "you" : "person" }
      : atIntake && ag.mode === "agent" && !pending.length && !openQuestion ? { text: `${ag.agentName} is reading the request`, kind: "agent" }
      : gateWaiting ? { text: `Waiting for approval at ${gdef?.label ?? gateWaiting[0]}`, kind: "gate" }
      : !atIntake && wo.state === "running" ? { text: `${ag.agentName} is working at ${stationName(c, sid)}`, kind: "agent" } : null;
    const legacyQ = !wo.conv.done ? wo.conv.questions[wo.conv.qi] : undefined;
    return {
      woId: id, project: row.project, repo: row.repo,
      wo: { id: wo.id, title: wo.title, description: wo.description, cls: wo.cls, clsName: cls.name, confidence: wo.clsConfidence, rationale: wo.clsRationale, priority: wo.priority, station: sid, stationName: stationName(c, sid), state: wo.state, bay: wo.bay, gate: gateWaiting ? { id: gateWaiting[0], label: gdef?.label ?? gateWaiting[0], name: gdef?.name ?? "", purpose: gdef?.purpose ?? "" } : null, requestedBy: wo.requestedBy, closed },
      messages: [...history, ...messages],
      agent: ag.mode === "agent" ? { mode: "agent", name: ag.agentName, id: ag.agentId, model: ag.model, vendor: ag.vendor, version: ag.pin.version, station: sid } : { mode: "rule-based", name: ag.agentName, id: ag.agentId, reason: ag.reason, label: WO_AGENT_LABEL, station: sid },
      budget: ag.budget, costUsd: ag.budget.spentUsd,
      can: { talk: own.allowed && !closed, talkWhy: closed ? "This work order is closed." : own.reason, confirm: confirm.allowed, confirmWhy: confirm.allowed ? "" : confirm.reason, ...(await (async () => { const d = await decide(req, "wo.park", scopeOf(row)); return { park: d.allowed, parkWhy: d.allowed ? "" : d.reason }; })()) },
      steps: r.map((s, i) => ({ id: s, name: stationName(c, s), state: closed && wo.state === "done" ? "done" : stepIdx < 0 ? "todo" : i < stepIdx ? "done" : i === stepIdx ? "current" : "todo" })),
      research: { plan: planOf(row.data), allowList: (await readSecurity(g.pool, g.orgId)).value.researchHosts ?? [], canDecide: (await decide(req, "gate.approve", scopeOf(row))).allowed, canApproveUnlisted: (await decide(req, "security.manage")).allowed },
      sources: await listSources(g.pool, g.orgId, id),
      swarm: await swarmView(row.data, id),
      dialogue: { questions: dialogue.questions.map((q) => ({ ...q, mine: q.status === "open" && asksMe(q.askOf, meP, { project: row.project, requestedBy: wo.requestedBy, requesterActive: requesterActive(pst.people, wo.requestedBy) }, (act) => decideFor(pst, req.gx.principal!, act, { project: row.project }).allowed) })), assumptions: dialogue.assumptions, objections: dialogue.objections, askedMe }, documents: await listDocuments(g.pool, g.orgId, id),
      next, waiting, pending, brief: wo.brief, briefConfirmed: (wo.briefVersions ?? []).length > 0 || wo.gates.G0G1?.status === "passed", briefOpen: atIntake,
      ruleQuestion: ag.mode === "rule-based" && atIntake && legacyQ ? { id: legacyQ.id, text: legacyQ.text, chips: legacyQ.chips } : null, ruleReady: ag.mode === "rule-based" && atIntake && wo.conv.done,
      busy: active.has(id),
    };
  });

  /* ------------------------------------------------------------------ a turn */

  app.post("/api/v1/work-orders/:id/session/messages", async (req, reply: FastifyReply) => {
    const { id } = Id.parse(req.params);
    const b = MessageBody.parse(req.body ?? {});
    const { row, who } = await woOf(req, id);
    if (b.kind === "message" && !b.text) throw refuse("invalid", "Write a message.");
    const t = await canTalk(req, row, who);
    if (!t.allowed) throw refuse("denied", t.reason || "You may not act on this work order.");
    if (b.kind === "open" && (await listWoMessages(g.pool, g.orgId, id, 400)).some((m) => m.data.kind !== "update")) return { ok: true, msg: "The conversation already started.", already: true };
    if (active.has(id)) throw refuse("conflict", "The agent is already answering. Wait for it to finish.");
    // Claimed in the same tick as the check, and released by whichever path leaves this handler (statechart intake-questions: check, many awaits, add let a second turn start, and the first to finish cleared the shared flag).
    active.add(id);
    try {
    const f0 = await flowOf(row);
    if (f0.wo.state === "done" || f0.wo.state === "killed" || f0.wo.bay === "declined") throw refuse("conflict", `${id} is closed.`);
    const ag = await agentState(row, f0.wo, f0.catalog);

    /* Rule-based: the scripted questionnaire answers through the ordinary answer command; it says so. */
    if (ag.mode !== "agent") {
      if (b.kind !== "message") return { ok: true, msg: "Rule-based: the scripted intake questions are shown.", mode: "rule-based", reason: ag.reason };
      const atIntake = briefOpenOf(f0.wo, f0.catalog);
      const own = row.submitter === who.id;
      if (!atIntake || f0.wo.conv.done) {
        const mid = await withTx(g.pool, async (tx) => {
          const msg = newWoMessageId();
          const rec = await recordMentions(tx, g.orgId, await policyState(req, tx), { woId: id, project: row.project, messageId: msg, by: who.id, byName: who.name, text: b.text!, ids: b.mentions ?? [], now: new Date() });
          await addWoMessage(tx, g.orgId, id, "user", who.id, b.text!, rec.mentioned.length ? { mentions: rec.mentioned.map(({ id: pid, name, access }) => ({ id: pid, name, access })) } : {}, new Date(), msg);
          for (const ev of rec.events) await appendEvent(tx, { orgId: g.orgId, type: ev.type, category: ev.category ?? "flow", actor: who.id, channel: "web", subject: ev.subject, projectId: row.project, woId: id, outcome: "ok", after: ev.after });
          return msg;
        });
        const sys = await persist(row, "system", "system", atIntake ? `${WO_AGENT_LABEL}: the brief is complete and waits for confirmation. Connect a model vendor to ask for changes in your own words.` : `${WO_AGENT_LABEL}: ${NO_AGENT_WO_TEXT}`, { kind: "no_agent", mode: "rule-based", cards: [] }, who.id, { mode: "rule-based", reason: ag.reason });
        return { ok: true, msg: NO_AGENT_WO_TEXT, mode: "rule-based", reason: ag.reason, messageId: sys, saved: mid };
      }
      const r = await command(req, { action: own ? null : "wo.answer", scope: scopeOf(row), ifMatch: woVersion(g.orgId, id) }, async (tx, a) => {
        const out = await postMessage(tx, a, id, { text: b.text!, kind: "answer" });
        if (!b.mentions?.length) return out;
        const rec = await recordMentions(tx, a.orgId, await policyState(req, tx), { woId: id, project: row.project, messageId: newWoMessageId(), by: who.id, byName: who.name, text: b.text!, ids: b.mentions, now: a.now });
        return { ...out, events: [...out.events, ...rec.events], extra: { ...(out.extra ?? {}), mentioned: rec.mentioned } };
      });
      return { ...r, mode: "rule-based", reason: ag.reason };
    }

    // 1. The person's words are saved first (idempotent on Idempotency-Key); an open question card is marked answered.
    const saved = await command(req, { action: null, scope: scopeOf(row), idempotent: true }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      let mid: string | null = null;
      let mentionEvents: EventSpec[] = [];
      let mentioned: Mentioned[] = [];
      if (b.text && b.kind !== "open") {
        mid = newWoMessageId();
        const rec = await recordMentions(tx, a.orgId, await policyState(req, tx), { woId: id, project: row.project, messageId: mid, by: who.id, byName: who.name, text: b.text, ids: b.mentions ?? [], now: a.now });
        mentionEvents = rec.events;
        mentioned = rec.mentioned;
        await addWoMessage(tx, a.orgId, id, "user", who.id, b.text, mentioned.length ? { mentions: mentioned.map(({ id: pid, name, access }) => ({ id: pid, name, access })) } : {}, a.now, mid);
        const last = (await tx.query<{ id: string; data: WoMessage["data"] }>(`select id, data from workorder_messages where org_id = $1 and wo_id = $2 and id <> $3 and role = 'assistant' order by created_at desc, id desc limit 1 for update`, [a.orgId, id, mid])).rows[0];
        if (last) {
          let changed = false;
          for (const cd of last.data.cards ?? []) if (cd.kind === "question" && cd.answered === undefined && !cd.superseded) { cd.answered = b.text.slice(0, 300); cd.answeredBy = "person"; cd.via = "card"; cd.answeredAt = a.now.toISOString(); cd.answerMessageId = mid; changed = true; }
          if (changed) await saveWoMessageData(tx, a.orgId, last.id, last.data);
        }
      }
      return { msg: "Saved.", events: [{ type: "wo.session.message", category: "flow", subject: { type: "wo", id }, projectId: row.project, woId: id, after: { message: mid, kind: b.kind, chars: b.text?.length ?? 0 } }, ...mentionEvents], extra: { messageId: mid, mentioned }, changes: ["conversations", "home"], project: row.project };
    });
    if (reply.getHeader("idempotent-replayed")) return { ...saved, replayed: true };
    // A person speaking (or opening) is the start the automatic "opened" follow-up would have made: it must not run a second opening turn.
    await g.pool.query(`update workorder_messages set data = jsonb_set(data, '{followUp}', '"done"') where org_id = $1 and wo_id = $2 and data->>'followUp' = 'pending' and data->>'event' = 'session.opened'`, [g.orgId, id]);

    /* The station agent's turn: streamed. */
    const fresh = (await readWoRow(g.pool, g.orgId, id))!;
    const confirm = await decide(req, "brief.confirm", scopeOf(fresh));
    const { send, ac, end } = openSse(reply);
    try {
      const question = b.kind === "open" ? "(The person opened the conversation about this work order. Begin.)" : b.kind === "continue" ? "(The person asked for changes to your proposal; see their last message. Revise and propose again.)" : (b.text ?? "");
      const mid = await agentTurn({ row: fresh, who, canConfirm: confirm.allowed, ag, question, kind: b.kind, send, signal: ac.signal });
      send("done", { messageId: mid });
    } catch (e) {
      const unavailable = e instanceof ModelUnavailable;
      if (!unavailable) req.log.error({ err: e }, "work-order session turn failed");
      const text = unavailable ? `${ag.agentName} did not answer: ${endSentence(e.message)} Nothing was changed; the scripted intake questions still work.` : "Something went wrong while answering. Nothing was changed.";
      try {
        const mid = await persist(fresh, "system", "system", text, { kind: unavailable ? e.code : "error", cards: [] }, who.id, { mode: "none", code: unavailable ? e.code : "error" });
        send("error", { code: unavailable ? e.code : "error", msg: text, messageId: mid });
      } catch (e2) {
        req.log.error({ err: e2 }, "work-order session could not save the failure notice");
        send("error", { code: "error", msg: text });
      }
    } finally {
      end();
    }
    return reply;
    } finally {
      active.delete(id);
    }
  });

  app.post("/api/v1/work-orders/:id/session/seen", async (req) => {
    const { id } = Id.parse(req.params);
    const { who, row } = await woOf(req, id);
    return command(req, { action: null }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      await markWoSeen(tx, a.orgId, id, who.id);
      return { msg: "Seen.", events: [], changes: ["home", "conversations"], project: row.project };
    });
  });

  /* ------------------------------------------------------------------ @mention */

  /** The composer's @: people to offer. Only someone who may talk on the work order can ask, and the answer says who cannot read the project yet. */
  app.get("/api/v1/work-orders/:id/session/people", async (req) => {
    const { id } = Id.parse(req.params);
    const { q } = PeopleQ.parse(req.query);
    const { row, who } = await woOf(req, id);
    const t = await canTalk(req, row, who);
    if (!t.allowed) throw refuse("denied", t.reason || "You may not act on this work order.");
    return { people: await searchMentionable(g.pool, g.orgId, await policyState(req), row.project, q, who.id) };
  });

  /** Open access requests for the projects the caller administers (project.members). A mention never grants access; this is where it asks. */
  app.get("/api/v1/access-requests", async (req) => {
    const who = person(req);
    const q = AccessQ.parse(req.query);
    const st = await policyState(req);
    const mine = q.project ? [q.project] : st.projects.map((p) => p.id);
    const allowed: string[] = [];
    for (const p of mine) if (can(st, who.id, "project.members", { project: p }).allowed) allowed.push(p);
    if (q.project && !allowed.length) throw refuse("denied", (await decide(req, "project.members", { project: q.project })).reason || "You may not manage this project's members.");
    return { items: await openAccessRequests(g.pool, g.orgId, st, allowed) };
  });

  /** Dismissing closes the request without granting anything. Granting is the people screen's role change (step-up, audited like any other). */
  app.post("/api/v1/access-requests/:id/dismiss", async (req) => {
    const { id } = Id.parse(req.params);
    person(req);
    const r = (await g.pool.query<{ project_id: string; person_id: string; status: string }>(`select project_id, person_id, status from access_requests where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    if (!r) throw refuse("not_found", "No such request.");
    return command(req, { action: "project.members", scope: { project: r.project_id } }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      const u = await tx.query(`update access_requests set status = 'dismissed', decided_by = $3, decided_at = $4 where org_id = $1 and id = $2 and status = 'open'`, [a.orgId, id, a.id, a.now]);
      if (!u.rowCount) throw refuse("conflict", "This request was already closed.");
      return { msg: "Request dismissed. Nothing was granted.", events: [{ type: "access.request.dismissed", category: "access", subject: { type: "person", id: r.person_id }, projectId: r.project_id, after: { request: id, person: r.person_id } }], changes: ["home"], project: r.project_id };
    });
  });

  /* ------------------------------------------------------------------ a decision on a proposal */

  app.post("/api/v1/work-orders/:id/session/proposals/:mid/:pid", async (req) => {
    const { id, mid, pid } = ProposalParams.parse(req.params);
    const b = DecisionBody.parse(req.body ?? {});
    const { row, who } = await woOf(req, id);
    const m0 = (await listWoMessages(g.pool, g.orgId, id)).find((m) => m.id === mid);
    const c0 = m0?.data.cards?.find((c): c is Extract<WoCard, { kind: "proposal" }> => c.kind === "proposal" && c.id === pid);
    if (!m0 || !c0) throw refuse("not_found", "No such proposal.");
    // Approving runs the ordinary command under the person's own rights; talking (changes, discard) needs the right to act on the work order.
    const action = b.decision !== "approve" ? ((await canTalk(req, row, who)).allowed ? null : "wo.answer") : c0.what === "brief" ? "brief.confirm" : c0.what === "reclassify" ? "wo.classify" : "wo.decline";
    return command(req, { action, scope: scopeOf(row), ifMatch: woVersion(g.orgId, id) }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      const m = await lockWoMessage(tx, a.orgId, id, mid);
      const card = m?.data.cards?.find((c): c is Extract<WoCard, { kind: "proposal" }> => c.kind === "proposal" && c.id === pid);
      if (!m || !card) throw refuse("not_found", "No such proposal.");
      if (card.status !== "pending") throw refuse("conflict", `This proposal is already ${card.status}. Ask the agent for a new one if you need it.`);
      const ev = (type: string, after: Record<string, unknown>) => ({ type, category: "flow" as const, subject: { type: "wo", id }, projectId: row.project, woId: id, after: { proposal: pid, message: mid, what: card.what, ...after } });
      const finish = async (status: Extract<WoCard, { kind: "proposal" }>["status"], note?: string): Promise<void> => {
        card.status = status;
        card.decidedBy = who.id;
        if (note) card.note = note.slice(0, 500);
        await saveWoMessageData(tx, a.orgId, mid, m.data);
      };
      if (b.decision === "discard" || b.decision === "changes") {
        const changes = b.decision === "changes";
        if (changes && !b.text) throw refuse("invalid", "Say what to change.");
        await finish(changes ? "changes" : "discarded", b.text);
        if (changes) await addWoMessage(tx, a.orgId, id, "user", who.id, `Changes requested: ${b.text}`, {}, a.now);
        return { msg: changes ? "Change requested. The agent will revise the proposal." : "Proposal discarded.", events: [ev(changes ? "wo.session.changes" : "wo.session.discarded", {})], changes: ["conversations"], project: row.project };
      }
      let out: CommandResult<Record<string, unknown>>;
      if (card.what === "brief") {
        const d = m.data.drafts?.[pid] as { brief?: unknown } | undefined;
        out = await confirmAgentBrief(tx, a, id, d?.brief, card.base ?? "", { agent: m.author, version: m.data.version ?? null, proposal: pid });
      } else if (card.what === "reclassify") {
        out = await reclassify(tx, a, id, card.cls?.id ?? "", card.reason ?? "Agreed in the work-order session.");
      } else {
        out = await decline(tx, a, id, card.reason ?? "Declined in the work-order session.", "web");
      }
      await finish("approved");
      return { ...out, events: [...out.events, ev("wo.session.approved", { mode: card.mode })], changes: [...new Set([...(out.changes ?? []), "conversations"])] };
    });
  });
};
