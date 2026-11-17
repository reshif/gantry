/**
 * What a model was given (spec 7.4, 10.2). Owns:
 *   GET /api/v1/prompt-calls?wo={id}|run={id}|project={id}   the recorded model calls of a work order, run or project (surface, turn, model, tokens, prompt hash, trace reference)
 *   GET /api/v1/prompt-traces/{sha256-hash}                    one stored trace: the full request (system prompt, tools, messages) and the answer, with the prompt manifest
 *
 * Run calls (the edge's model gateway) and conversational calls (the service gateway: console, explain, work-order and onboarding sessions) are stored the same way, with
 * secrets redacted before they were stored. Access: a trace of a work order, run or project is readable by the people who may read that project (project.view); a trace
 * of a console or explain call, or any call that belongs to no project, only by the person who asked. Anything else answers 404, as if it did not exist.
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { fetchTrace } from "../areas/console/model.js";
import { decide, policyState, refuse } from "../core/index.js";

const Ref = z.object({ ref: z.string().regex(/^[0-9a-f]{64}$/) });
const ListQ = z.object({ wo: z.string().min(1).max(100).optional(), run: z.string().min(1).max(200).optional(), project: z.string().min(1).max(100).optional() }).refine((q) => !!(q.wo || q.run || q.project), { message: "Give wo, run or project." });

interface CallRow {
  request_id: string | null;
  run_id: string | null;
  wo_id: string | null;
  project_id: string | null;
  surface: string | null;
  station: string | null;
  actor_id: string | null;
  turn_id: string | null;
  model_id: string;
  input_tokens: string;
  output_tokens: string;
  cost_micros: string;
  prompt_hash: string | null;
  trace_ref: string | null;
  outcome: string;
  at: Date;
}

const SELECT = `select u.request_id, u.run_id, coalesce(u.wo_id, r.wo_id) as wo_id, u.project_id, u.surface, u.station, u.actor_id, u.turn_id, u.model_id,
       u.input_tokens::text, u.output_tokens::text, u.cost_micros::text, u.prompt_hash, u.trace_ref, u.outcome, u.at
  from usage_meter u left join runs r on r.org_id = u.org_id and r.id = u.run_id`;

export const promptTraceRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  const person = (req: FastifyRequest): { id: string } => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Prompt records are for signed-in people.");
    return { id: p.id };
  };

  /** May this person read the record of a call that belongs here? Never explains why not: the answer is a 404. */
  async function mayRead(req: FastifyRequest, who: { id: string }, c: { surface: string | null; project: string | null; actor: string | null }): Promise<boolean> {
    if (c.surface === "console" || c.surface === "explain" || !c.project) return c.actor === who.id;
    const st = await policyState(req);
    const p = st.people.find((x) => x.id === who.id);
    const seen = p?.roles.some((r) => r.scope === "factory") || visibleProjects(st, who.id).some((x) => x.id === c.project);
    return !!seen && (await decide(req, "project.view", { project: c.project })).allowed;
  }

  app.get("/api/v1/prompt-calls", async (req) => {
    const who = person(req);
    const q = ListQ.parse(req.query);
    const cond = q.wo ? "(u.wo_id = $2 or r.wo_id = $2)" : q.run ? "u.run_id = $2" : "u.project_id = $2";
    const { rows } = await g.pool.query<CallRow>(`${SELECT} where u.org_id = $1 and u.trace_ref is not null and ${cond} order by u.at desc, u.id desc limit 200`, [g.orgId, q.wo ?? q.run ?? q.project]);
    const out = [];
    const cache = new Map<string, boolean>();
    for (const r of rows) {
      const key = `${r.surface}|${r.project_id}|${r.actor_id}`;
      let ok = cache.get(key);
      if (ok === undefined) cache.set(key, (ok = await mayRead(req, who, { surface: r.surface, project: r.project_id, actor: r.actor_id })));
      if (!ok) continue;
      out.push({ requestId: r.request_id, run: r.run_id, wo: r.wo_id, project: r.project_id, surface: r.surface ?? (r.run_id ? "run" : null), station: r.station, turn: r.turn_id, model: r.model_id, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costMicros: Number(r.cost_micros), promptHash: r.prompt_hash, trace: r.trace_ref?.replace(/^sha256\//, "") ?? null, outcome: r.outcome, at: r.at.toISOString() });
    }
    return { ok: true, calls: out };
  });

  app.get("/api/v1/prompt-traces/:ref", async (req, reply) => {
    const who = person(req);
    const { ref } = Ref.parse(req.params);
    const { rows } = await g.pool.query<CallRow>(`${SELECT} where u.org_id = $1 and u.trace_ref = $2 order by u.id limit 1`, [g.orgId, `sha256/${ref}`]);
    const c = rows[0];
    if (!c || !(await mayRead(req, who, { surface: c.surface, project: c.project_id, actor: c.actor_id }))) throw refuse("not_found", "No such prompt record.");
    const t = await fetchTrace(g.config.secrets.edgeToken, `sha256/${ref}`);
    if (!t.ok) throw refuse(t.status === 404 ? "not_found" : "conflict", t.status === 404 ? "No such prompt record." : "The prompt record store is not reachable right now. Try again shortly.");
    void reply.header("cache-control", "no-store");
    return { ok: true, trace: t.trace };
  });
};
