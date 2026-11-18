/**
 * The agent-session core (spec 11.3): the pieces every "a person talks to an agent about one thing, for that thing's whole life" conversation shares. The onboarding session
 * (one per repository) and the work-order session (one per work order) differ in their rows, tools and commands; they share how a turn is built from the thread, how it
 * is streamed (SSE), how it is costed and budgeted, and how a station agent is judged usable. Nothing here knows about a repository or a work order, and nothing here
 * writes: cards are data, and only a person's approval runs a command.
 */
import type { Queryable } from "@gantry/db";
import type { FastifyReply } from "fastify";
import { costMicros, currentPrices } from "../internal/metering.js";
import { pinRunConfig } from "../agents/compose.js";
import { resolveFor } from "../models/facts.js";

/** Earlier turns for the model: the thread's person and agent messages, merged per role, starting with a person's (the Messages API needs that). */
export function historyFrom(prior: Array<{ role: "user" | "assistant" | "system"; text: string }>, kind: "message" | "open" | "continue" | "followup", question: string, o: { take?: number; clip?: number } = {}): { hist: Array<{ role: "user" | "assistant"; text: string }>; question: string } {
  const hist: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of prior.filter((x) => (x.role === "user" || x.role === "assistant") && x.text).slice(-(o.take ?? 12))) {
    const last = hist[hist.length - 1];
    const t = m.text.slice(0, o.clip ?? 700);
    if (last && last.role === m.role) last.text += `\n${t}`;
    else hist.push({ role: m.role as "user" | "assistant", text: t });
  }
  while (hist.length && hist[0]!.role !== "user") hist.shift();
  let q = question;
  // The newest user message is the question; for open/continue/follow-up there is a short instruction instead.
  if (kind === "message" && hist.length && hist[hist.length - 1]!.role === "user") hist.pop();
  if (kind !== "message" && hist.length && hist[hist.length - 1]!.role === "user") q = `${hist.pop()!.text}\n\n${question}`;
  return { hist, question: q };
}

/** Starts a streamed answer: hijacks the reply, writes the SSE head, and aborts the turn when the client goes away. */
export function openSse(reply: FastifyReply): { send: (event: string, data: unknown) => void; ac: AbortController; end: () => void } {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
  const ac = new AbortController();
  raw.on("close", () => {
    if (!raw.writableFinished) ac.abort();
  });
  return {
    send: (event, data) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    ac,
    end: () => {
      if (!raw.writableEnded) raw.end();
    },
  };
}

/** What a turn cost, in micro-dollars, at the price book in force. */
export async function turnCostMicros(db: Queryable, orgId: string, model: string, usage: { inputTokens: number; outputTokens: number }): Promise<number> {
  const book = await currentPrices(db, orgId).catch(() => null);
  return book ? costMicros(book.prices[model], { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }) : 0;
}

/** The agent's own budget for one session, in dollars (its `budget`), or the default. */
export async function agentBudgetUsd(db: Queryable, orgId: string, agentId: string, fallback: number): Promise<number> {
  const ag = (await db.query<{ budget: string | null }>(`select data->>'budget' as budget from agents where org_id = $1 and id = $2`, [orgId, agentId])).rows[0];
  return Number(ag?.budget) > 0 ? Number(ag!.budget) : fallback;
}

export interface StationAgentPin { agent: string; version: number; model: string; vendor: string; name: string }
export type StationAgentGate = { usable: true; pin: StationAgentPin } | { usable: false; reason: string };

/**
 * Whether an agent may run at all: "off" when it is not active, "unpromoted" when its live version never passed its eval suite, else null. The one definition of
 * "active and promoted", used by the chat gate below and by the worker before it starts a station's run. With `requirePromotionRecord` false a version is judged
 * unpromoted only when the agent keeps a promotion record that lacks it (the promote command keeps it; fixtures that never went through it have none).
 */
export function agentOffKind(ag: { status: string; live_version: number | null; data: Record<string, unknown> }, o: { requirePromotionRecord: boolean }): "off" | "unpromoted" | null {
  if (ag.status !== "active") return "off";
  if (ag.live_version === null) return null;
  const record = Array.isArray(ag.data.promoted) ? (ag.data.promoted as unknown[]) : null;
  return (record || o.requirePromotionRecord) && !(record ?? []).includes(ag.live_version) ? "unpromoted" : null;
}

/** The reason a station's agent may not start a run now, or null (an agent id of "" or one not set up is judged elsewhere). */
export async function stationRunBlock(db: Queryable, orgId: string, agentId: string): Promise<string | null> {
  if (!agentId) return null;
  const ag = (await db.query<{ name: string; status: string; live_version: number | null; data: Record<string, unknown> }>(`select name, status, live_version, data from agents where org_id = $1 and id = $2`, [orgId, agentId])).rows[0];
  const kind = ag ? agentOffKind(ag, { requirePromotionRecord: false }) : null;
  if (!ag || !kind) return null;
  return kind === "off" ? `The ${ag.name} agent is turned off; turn it on or reassign the station.` : `Version ${ag.live_version} of the ${ag.name} agent has not passed its eval suite; promote it or reassign the station.`;
}

/**
 * Whether a station's agent may talk now: it exists, is active, has a promoted live version, pins a model that a connected vendor serves for this project, and no stop
 * covers the work. The reason is shown when it falls back to the rules.
 */
export async function stationAgentGate(db: Queryable, orgId: string, agentId: string, scope: { station: string; project: string; repoId?: string | null }): Promise<StationAgentGate> {
  if (!agentId) return { usable: false, reason: "No agent is assigned to this station." };
  const ag = (await db.query<{ name: string; status: string; live_version: number | null; data: Record<string, unknown> }>(`select name, status, live_version, data from agents where org_id = $1 and id = $2`, [orgId, agentId])).rows[0];
  if (!ag) return { usable: false, reason: `Agent ${agentId} is not set up in this factory.` };
  if (agentOffKind(ag, { requirePromotionRecord: false }) === "off") return { usable: false, reason: `${ag.name} is ${ag.status}.` };
  if (ag.live_version === null) return { usable: false, reason: `${ag.name} has no live version.` };
  if (agentOffKind(ag, { requirePromotionRecord: true }) === "unpromoted") return { usable: false, reason: `Version ${ag.live_version} of ${ag.name} has not passed its eval suite.` };
  const v = (await db.query<{ body: Record<string, unknown>; model_id: string | null }>(`select body, model_id from agent_versions where org_id = $1 and agent_id = $2 and version = $3`, [orgId, agentId, ag.live_version])).rows[0];
  if (!v) return { usable: false, reason: `${ag.name}'s live version is missing.` };
  const run = await pinRunConfig(db, { orgId, agentId, agentVersion: ag.live_version, projectId: scope.project, repoId: scope.repoId ?? null }).catch(() => null);
  const model = run?.modelOverride || v.model_id || (typeof v.body.model === "string" ? v.body.model : "");
  if (!model) return { usable: false, reason: `${ag.name} pins no model.` };
  const res = await resolveFor(db, orgId, { station: scope.station, project: scope.project, repoId: scope.repoId ?? null, pinned: model });
  if (!res.pick) return { usable: false, reason: res.blocked ?? `No connected vendor serves ${model}.` };
  const stop = (await db.query<{ mode: string; scope_type: string }>(
    `select mode, scope_type from stops where org_id = $1 and lifted_at is null and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) ${scope.repoId ? "or (scope_type = 'repo' and repo_id = $3)" : ""}) order by (mode = 'kill') desc limit 1`,
    scope.repoId ? [orgId, scope.project, scope.repoId] : [orgId, scope.project],
  )).rows[0];
  if (stop) return { usable: false, reason: `${stop.mode === "kill" ? "A kill" : "A halt"} at ${stop.scope_type} scope is in force.` };
  return { usable: true, pin: { agent: agentId, version: ag.live_version, model: res.pick.model, vendor: res.pick.vendor, name: ag.name } };
}
