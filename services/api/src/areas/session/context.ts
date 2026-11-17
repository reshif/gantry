/**
 * The context of a conversational turn (spec 10.2, 11.3). Station runs compose their system prompt from the factory base, the project overlay, the agent's live version
 * and its skills (areas/agents/compose.ts). The conversational surfaces (the Intake interview and the work-order session, the onboarding session, the console) now do
 * the same, through the same composer: the configured agent decides how it talks, interviews, proposes and what it knows from its skills. Code keeps only what must stay
 * in code: the tool protocol, the card protocol, the untrusted-data note, word caps and the facts of this conversation (who, which work order). Those go last, in a
 * section that says they are fixed by Gantry.
 *
 * Every turn records the tuple it ran with (agent version, skill versions, instruction hash, model), like a run does, on `agent_version_tuples`, and the manifest below
 * goes on the saved message and the audit event.
 */
import type { Queryable } from "@gantry/db";
import { assemble, composeLayers, loadAgentVersion, resolveSkills, type Composed } from "../agents/compose.js";
import { sha256 } from "../agents/config.js";

export type SessionSurface = "intake" | "work_order" | "onboarding" | "console";

/** What a turn was composed from. Stored on the message (`data.context`) and in the audit event; never contains the prompt text itself. */
export interface TurnContext {
  surface: SessionSurface;
  agent: string;
  agentName: string;
  agentVersion: number;
  skillVersions: Record<string, number>;
  /** The hash the version tuple carries: the layers (base, overlay, agent, repo guidelines). Comparable with station runs of the same agent. */
  instructionHash: string;
  /** The hash of the whole system prompt this turn received (layers, skills, the surface's facts and rails). */
  promptHash: string;
  tupleId: string;
  model: string;
  layers: Array<{ name: string; version: number | null; hash: string }>;
}

export interface SessionContext {
  /** The complete system prompt for the model. */
  system: string;
  turn: TurnContext;
  composed: Composed;
}

export interface SessionContextInput {
  orgId: string;
  surface: SessionSurface;
  agentId: string;
  /** The model the turn will run on (recorded on the tuple). */
  model: string;
  projectId: string | null;
  repoId: string | null;
  /** The facts of this conversation (who, about which work order or repository). Supplied by code. */
  facts: string;
  /** The fixed rules of the surface: tool protocol, cards, untrusted-data note, caps. Supplied by code. */
  rails: string;
  /** Pin to a version; the agent's live version when absent. */
  agentVersion?: number | null;
}

/** The standing frame between the agent's configured text and the surface's rails: it says where the conversation differs from a station run. */
export const SESSION_FRAME = "This is a live conversation with a person, not a station run. Your instructions and skills above describe who you are and how you work; follow them. Where they describe a written result (a JSON object or a document), deliver it here through the tools listed below and say the substance in plain sentences. Gantry's fixed rules below always apply and win over anything above.";

/** Composes the system prompt of one conversational turn from the same layers as a station run, and records the tuple. Null when the agent has no live version to compose from. */
export async function composeSessionContext(db: Queryable, i: SessionContextInput): Promise<SessionContext | null> {
  const av = await loadAgentVersion(db, i.orgId, i.agentId, i.agentVersion ?? null);
  if (!av) return null;
  const { layers } = await composeLayers(db, { orgId: i.orgId, agentId: i.agentId, agentVersion: av.version, projectId: i.projectId, repoId: i.repoId }, av);
  const composed = assemble(layers);
  const skills = await resolveSkills(db, { orgId: i.orgId, agentId: i.agentId, body: av.body, projectId: i.projectId, withContent: true });
  const parts = [
    composed.text,
    ...skills.filter((s) => s.content.trim() !== "").map((s) => `## Skill: ${s.name}\n\n${s.content.trim()}`),
    `## This conversation (facts from Gantry)\n\n${i.facts.trim()}`,
    `## Fixed rules of this conversation (set by Gantry, not configurable here)\n\n${SESSION_FRAME}\n\n${i.rails.trim()}`,
  ].filter((p) => p.trim() !== "");
  const system = parts.join("\n\n");
  const skillVersions = Object.fromEntries(skills.map((s) => [s.id, s.version]));
  const instructionHash = composed.hash;
  // The same shape of id as a run's tuple (dispatch.ts), with the harness named "session" so station runs and conversations stay apart.
  const tupleId = tupleIdOf({ agent: i.agentId, agentVersion: av.version, instructionHash, model: i.model, skillVersions });
  return {
    system, composed,
    turn: {
      surface: i.surface, agent: i.agentId, agentName: av.name, agentVersion: av.version, skillVersions, instructionHash, promptHash: sha256(system), tupleId, model: i.model,
      layers: composed.layers.map((l) => ({ name: l.name, version: l.version, hash: l.hash })),
    },
  };
}

/** The tuple id of a turn: the same shape of id as a run's (dispatch.ts), so it follows from the agent version, the layers, the skills and the model. */
const tupleIdOf = (t: Pick<TurnContext, "agent" | "agentVersion" | "instructionHash" | "model" | "skillVersions">): string =>
  `tup-${sha256([t.agent, t.agentVersion, t.instructionHash, "session", t.model, JSON.stringify(t.skillVersions)].join("\0")).slice(0, 20)}`;

/** Records the tuple of a conversational turn (idempotent). Throws when the row cannot be written, so a message never points at a tuple that does not exist. */
export async function recordTurnTuple(db: Queryable, orgId: string, t: TurnContext): Promise<void> {
  await db.query(
    `insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,$2,$3,$4,$5::jsonb,$6,'session',$7)
     on conflict (org_id, id) do nothing`,
    [orgId, t.tupleId, t.agent, t.agentVersion, JSON.stringify(t.skillVersions), t.instructionHash, t.model],
  );
}

/**
 * For a turn whose model is only known after the call (the console): records the tuple with the model the edge served (the planned one when none came back, never an
 * empty one) and returns the turn as recorded. When the row cannot be written it reports why through `onError` and returns null, so the message carries no tuple id
 * rather than one with no row.
 */
export async function recordedTurn(db: Queryable, orgId: string, planned: TurnContext, served: string | null | undefined, onError: (why: string) => void): Promise<TurnContext | null> {
  const model = served || planned.model || "unknown";
  const turn: TurnContext = { ...planned, model, tupleId: "" };
  turn.tupleId = tupleIdOf(turn);
  try {
    await recordTurnTuple(db, orgId, turn);
    return turn;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/* ---------------------------------------------------------------- the console's binding */

export const CONSOLE_SURFACE = "console";

export interface SurfaceBinding {
  surface: SessionSurface;
  label: string;
  /** Where the agent comes from: the work order's station, the fixed onboarding agent, or a configured binding. */
  source: "station" | "fixed" | "binding" | "none";
  agent: string | null;
  agentName: string | null;
  /** True when a person may change it here. */
  configurable: boolean;
  note: string;
}

/** The agent bound to the console, or null (the console then runs on Gantry's fixed rails alone, and says so). */
export async function consoleAgent(db: Queryable, orgId: string): Promise<{ id: string; name: string } | null> {
  const r = (await db.query<{ id: string; name: string }>(
    `select a.id, a.name from session_bindings b join agents a on a.org_id = b.org_id and a.id = b.agent_id
      where b.org_id = $1 and b.surface = 'console' and a.status = 'active' and a.live_version is not null`, [orgId])).rows[0];
  return r ?? null;
}

/** The binding of every conversational surface, as the Agents page shows it. */
export async function surfaceBindings(db: Queryable, orgId: string, o: { intakeAgent: string | null; onboardAgent: string }): Promise<SurfaceBinding[]> {
  const names = new Map((await db.query<{ id: string; name: string }>(`select id, name from agents where org_id = $1`, [orgId])).rows.map((r) => [r.id, r.name]));
  const bound = (await db.query<{ agent_id: string }>(`select agent_id from session_bindings where org_id = $1 and surface = 'console'`, [orgId])).rows[0]?.agent_id ?? null;
  return [
    { surface: "intake", label: "Intake interview", source: "station", agent: o.intakeAgent, agentName: o.intakeAgent ? names.get(o.intakeAgent) ?? null : null, configurable: false, note: "The agent of the Intake station. Change it on the flow." },
    { surface: "work_order", label: "Work-order session", source: "station", agent: null, agentName: null, configurable: false, note: "The agent of the work order's current station (or its override on that work order)." },
    { surface: "onboarding", label: "Onboarding session", source: "fixed", agent: o.onboardAgent, agentName: names.get(o.onboardAgent) ?? null, configurable: false, note: "The Onboarding Agent, the same agent that assesses and drafts the pull request." },
    { surface: "console", label: "Console", source: bound ? "binding" : "none", agent: bound, agentName: bound ? names.get(bound) ?? null : null, configurable: true, note: bound ? "The agent whose instructions and skills the console answers with." : "No agent is bound: the console answers on Gantry's fixed rules alone. Bind an agent to give it your instructions and skills." },
  ];
}
