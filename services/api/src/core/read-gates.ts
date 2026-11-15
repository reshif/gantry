/**
 * Default deny for reads (spec 14.3). Beyond their own profile and sessions, a signed-in person reads only what a role of theirs lets
 * them read: every GET below is answered by the same decision point as a command (`decide`). Writes are gated in their own routes.
 *
 *   project.view          anywhere   catalogue, templates, home, activity, workload, conversations, stops, console, evals, learning, triggers, trust, card templates, deliveries
 *                                    (any project role; these views filter to the projects the person can see)
 *   project.view          on :id     everything under /projects/{id}
 *   people.view / policy.view / agents.view / models.view / integrations.view   the factory-wide registers (factory-level role)
 *                                    (the plain lists of people, teams, agents, skills, MCP servers and integrations answer anyone on a
 *                                    project with a directory view of their own projects instead: core/directory.ts)
 *
 * Own data stays open: /me, own sessions and sign-ins, saved views, notifications, the stream (filtered by visibility), `can`.
 * API keys and services are not touched here (keys carry their own scopes).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { decide } from "./decide.js";
import { DIRECTORY_PATHS } from "./directory.js";
import { canonicalPath } from "./paths.js";

interface Gate {
  re: RegExp;
  action: string;
  /** Capture group 1 is the project id. */
  project?: boolean;
}

const G = (re: RegExp, action: string, project = false): Gate => ({ re, action, project });

export const READ_GATES: readonly Gate[] = [
  G(/^\/api\/v1\/projects\/([^/]+)(\/|$)/, "project.view", true),
  G(/^\/api\/v1\/(people|teams)(\/|$)/, "people.view"),
  G(/^\/api\/v1\/(policies|freezes|access|roles)(\/|$)/, "policy.view"),
  G(/^\/api\/v1\/agents\/[^/]+\/effective$/, "project.view"), // composed instructions for a project: filtered to visible projects
  G(/^\/api\/v1\/(agents|skills|instructions)(\/|$)/, "agents.view"),
  G(/^\/api\/v1\/(vendors|vendor-templates|models|routing|prices|budgets)(\/|$)/, "models.view"),
  G(/^\/api\/v1\/(integrations|integration-types|mcp)(\/|$)/, "integrations.view"),
  G(/^\/api\/v1\/(catalog|templates|project-presets|guidelines|home|activity|workload|conversations|stops|console|suites|evals|learning|triggers|trigger-proposals|trust|card-templates|deliveries)(\/|$)/, "project.view"),
];

export function readGateFor(path: string): { action: string; project: string | null } | null {
  for (const g of READ_GATES) {
    const m = g.re.exec(path);
    if (m) return { action: g.action, project: g.project ? decodeURIComponent(m[1]!) : null };
  }
  return null;
}

/** Refuses (403) a read; read refusals are not written to the ledger (a no-access screen polls several reads, which would flood it); writes are. Covers a read the person has no role for. Called after authentication; only for people reading with GET/HEAD. */
export async function enforceReadGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.gx.principal?.kind !== "person") return;
  const path = canonicalPath(req.url) ?? "";
  const gate = readGateFor(path);
  if (!gate) return;
  const d = await decide(req, gate.action, gate.project ? { project: gate.project } : {});
  if (d.allowed) return;
  // A list with a directory view: someone on a project reads the rows that touch their projects (core/directory.ts).
  if (DIRECTORY_PATHS.has(path.split("?")[0]!) && d.rule.kind !== "stop" && (await decide(req, "project.view", {})).allowed) {
    req.gx.directory = true;
    return;
  }
  // A project the person holds no role on does not reveal itself: the same 404 as an unknown project.
  if (gate.project) {
    await reply.code(404).send({ ok: false, msg: "No such project." });
    return;
  }
  await reply.code(d.rule.kind === "stop" ? 409 : 403).send({ ok: false, msg: d.reason, rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) });
}
