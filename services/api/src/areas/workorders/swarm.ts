/**
 * Research scouts (agent workspace, Phase 3, G3). A station agent may split its question into a few sub-questions with `spawn_scouts`; its run
 * ends, and Gantry starts one scout run per sub-question: separate attempts at the same station, each with the station's agent and tools, the
 * work order's handoff and its own question. Scouts cannot spawn scouts or propose plans, they spend from the same budget (the station's plan
 * budget covers every run at the station), and they write `research/scout-<x>.md`. When every scout has ended, the station runs again to
 * bring their findings together. People see the scouts as a board and may stop any one of them.
 *
 * The rails: at most MAX_SCOUTS at once, MAX_SCOUTS_PER_WO over the work order's life, a web scout only under an approved plan with the web.
 */
import { createHash } from "node:crypto";
import { stationDef } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { job } from "../../core/jobs-contract.js";
import { conflict, refuse } from "../../core/errors.js";
import { revokeRunTokens } from "../internal/tokens.js";
import { enterStation, ev, flushFx, note, dispatchQueued, type Fx } from "./engine.js";
import { begin, done, person, type CmdResult } from "./ctx.js";
import { lockWo, saveWo, type Wo } from "./model.js";
import { recordDialogue } from "./documents.js";
import { planOf } from "./research.js";
import { addWoMessage, updateId } from "./session/store.js";

export const MAX_SCOUTS = 4;
export const MAX_SCOUTS_PER_WO = 12;

export interface Scout { id: string; attempt: string; question: string; focus: "repo" | "web"; state: "queued" | "running" | "done" | "failed" | "stopped"; summary?: string; stoppedBy?: string }
export interface Swarm { station: string; parent: string; startedAt: number; scouts: Scout[]; endedAt?: number }

export const swarmOf = (data: Record<string, unknown>): Swarm | null => (data.swarm && typeof data.swarm === "object" ? (data.swarm as Swarm) : null);
/** The run id the worker derives from an attempt id (worker/src/handlers/common.ts runIdFor). */
const runIdFor = (attemptId: string): string => `r-${createHash("sha256").update(attemptId).digest("hex").slice(0, 24)}`;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Validates what the run asked for; null with a reason when it cannot go ahead (the caller then parks the work order for a person instead). */
export function scoutRequest(raw: unknown, w: Wo): { ok: true; scouts: Array<{ question: string; focus: "repo" | "web" }> } | { ok: false; reason: string } {
  const list = Array.isArray(raw) ? raw : [];
  const scouts = list
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ question: typeof x.question === "string" ? x.question.trim().slice(0, 500) : "", focus: x.focus === "web" ? ("web" as const) : ("repo" as const) }))
    .filter((x) => x.question.length >= 5);
  if (!scouts.length) return { ok: false, reason: "The run asked for scouts but gave no questions." };
  if (scouts.length > MAX_SCOUTS) return { ok: false, reason: `The run asked for ${scouts.length} scouts; at most ${MAX_SCOUTS} run at once.` };
  const used = (swarmOf(w.data)?.scouts.length ?? 0) + Number(w.data.scoutsUsed ?? 0);
  if (used + scouts.length > MAX_SCOUTS_PER_WO) return { ok: false, reason: `A work order may use at most ${MAX_SCOUTS_PER_WO} scouts; ${used} were used.` };
  const plan = planOf(w.data);
  if (scouts.some((s) => s.focus === "web") && !(plan?.status === "approved" && plan.web)) return { ok: false, reason: "A web scout needs an approved research plan with the web." };
  return { ok: true, scouts };
}

/** Starts the scouts for a station whose run asked for them. The work order stays at the station, running. */
export async function startSwarm(fx: Fx, w: Wo, station: string, parent: string, scouts: Array<{ question: string; focus: "repo" | "web" }>): Promise<Swarm> {
  const prior = swarmOf(w.data);
  if (prior) w.data.scoutsUsed = Number(w.data.scoutsUsed ?? 0) + prior.scouts.length;
  const agent = stationDef(fx.catalog, station)?.agent ?? "";
  const out: Scout[] = [];
  let visit = Number((await fx.tx.query(`select coalesce(max(visit), 0) as v from attempts where org_id = $1 and wo_id = $2 and station = $3`, [fx.orgId, w.id, station])).rows[0].v);
  for (const [i, s] of scouts.entries()) {
    const letter = LETTERS[(Number(w.data.scoutsUsed ?? 0) + i) % 26]!;
    const id = `ATT-${w.id}-${station}-${++visit}`;
    const { rows } = await fx.tx.query<{ fencing: string }>(
      `insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,$5,'queued',$6::jsonb) returning fencing`,
      [fx.orgId, id, w.id, station, visit, JSON.stringify({ agent, scout: { id: letter, question: s.question, focus: s.focus, parent } })],
    );
    fx.jobs.push(job("attempt.dispatch", { woId: w.id, station, attemptId: id, fencing: Number(rows[0]!.fencing) }, { dedupeKey: `attempt:${id}` }));
    out.push({ id: letter, attempt: id, question: s.question, focus: s.focus, state: "queued" });
  }
  const swarm: Swarm = { station, parent, startedAt: fx.now.getTime(), scouts: out };
  w.data.swarm = swarm;
  w.state = "running";
  w.data.progress = 10;
  fx.changes.add("floor");
  note(w, fx, fx.actor, `${stationDef(fx.catalog, station)?.name ?? station} sent ${out.length} scout${out.length === 1 ? "" : "s"}: ${out.map((s) => `${s.id} (${s.focus})`).join(", ")}.`);
  ev(fx, w, "research.swarm.started", { station, text: out.map((s) => `${s.id}: ${s.question}`).join(" · ").slice(0, 300), scouts: out.length }, { category: "flow" });
  await addWoMessage(fx.tx, fx.orgId, w.id, "assistant", fx.actor, `${stationDef(fx.catalog, station)?.name ?? station} sent ${out.length} scout${out.length === 1 ? "" : "s"} to work in parallel.`, { kind: "station", station, mode: "agent", agent: fx.actor, cards: [{ kind: "swarm", station }] }, fx.now, updateId(fx.orgId, w.id, `swarm:${parent}`));
  return swarm;
}

const terminal = (s: Scout) => s.state === "done" || s.state === "failed" || s.state === "stopped";

/** When every scout has ended, the station runs again (the run that brings the findings together). */
async function closeIfDone(fx: Fx, w: Wo, swarm: Swarm): Promise<boolean> {
  if (!swarm.scouts.every(terminal)) return false;
  swarm.endedAt = fx.now.getTime();
  w.data.swarm = swarm;
  const ok = swarm.scouts.filter((s) => s.state === "done").length;
  note(w, fx, "system", `All scouts ended (${ok} of ${swarm.scouts.length} delivered); ${stationDef(fx.catalog, swarm.station)?.name ?? swarm.station} brings their findings together.`);
  ev(fx, w, "research.swarm.ended", { station: swarm.station, text: `${ok} of ${swarm.scouts.length} delivered` }, { category: "flow" });
  await enterStation(fx, w, swarm.station);
  return true;
}

/** A scout run delivered (or failed). Called by the worker in place of the flow engine: a scout never moves the work order by itself. */
export async function applyScoutResult(tx: Tx, attemptId: string, fencing: number, r: { status: string; summary: string; output: Record<string, unknown> | null; error?: { msg: string } | null }, now = new Date()): Promise<{ applied: boolean; reason?: string; closed?: boolean }> {
  const a = (await tx.query<{ org_id: string; wo_id: string; station: string; state: string; fencing: string; data: { scout?: { id: string } } }>(`select org_id, wo_id, station, state, fencing::text, data from attempts where id = $1`, [attemptId])).rows[0];
  if (!a?.data.scout) return { applied: false, reason: "Not a scout attempt." };
  if (Number(a.fencing) !== fencing || (a.state !== "queued" && a.state !== "running")) return { applied: false, reason: `That scout is ${a.state}.` };
  const w = await lockWo(tx, a.org_id, a.wo_id);
  const { newFx } = await import("./engine.js");
  const fx = await newFx(tx, a.org_id, ((a.data as { agent?: string }).agent as string) || "system", now);
  const ok = r.status === "succeeded" || r.status === "needs_person";
  await tx.query(`update attempts set state = $3, outcome = $4, ended_at = $5, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`, [a.org_id, attemptId, ok ? "succeeded" : "failed", r.status, now]);
  // A scout's questions are not blocking (it cannot stop the work order); its assumptions are recorded like any station's.
  const dl = (r.output?.dialogue ?? {}) as { questions?: Array<Record<string, unknown>>; assumptions?: unknown };
  await recordDialogue(tx, { orgId: a.org_id, woId: a.wo_id, station: a.station, attemptId, agent: fx.actor, dialogue: { questions: (dl.questions ?? []).map((q) => ({ ...q, blocking: false })), assumptions: dl.assumptions ?? [] }, now });
  const swarm = swarmOf(w.data);
  const sc = swarm?.scouts.find((s) => s.attempt === attemptId);
  if (!swarm || !sc) {
    await saveWo(tx, a.org_id, w);
    await flushFx(fx);
    return { applied: true };
  }
  sc.state = ok ? "done" : "failed";
  sc.summary = (ok ? r.summary : r.error?.msg ?? r.summary).slice(0, 600);
  const docs = (await tx.query<{ id: string; doc: string; version: number }>(`select id, doc, version from artefacts where org_id = $1 and wo_id = $2 and attempt_id = $3 and doc is not null order by doc`, [a.org_id, a.wo_id, attemptId])).rows;
  await addWoMessage(tx, a.org_id, a.wo_id, "assistant", fx.actor, `Scout ${sc.id} ${ok ? "finished" : "failed"}: ${sc.summary || sc.question}`, { kind: "station", station: a.station, mode: "agent", agent: fx.actor, cards: docs.map((d) => ({ kind: "document" as const, id: d.id, name: d.doc, version: d.version })) }, now, updateId(a.org_id, a.wo_id, `scout:${attemptId}`));
  ev(fx, w, "research.scout.ended", { station: a.station, scout: sc.id, outcome: r.status, text: sc.summary.slice(0, 200) }, { category: "flow" });
  const closed = await closeIfDone(fx, w, swarm);
  w.data.swarm = swarm;
  await saveWo(tx, a.org_id, w);
  await flushFx(fx);
  await dispatchQueued(fx, w.project);
  await flushFx(fx);
  return { applied: true, closed };
}

/** A person stops one scout: its run is refused from the next call on, and it counts as ended. */
export async function stopScout(tx: Tx, actor: Actor, woId: string, scoutId: string, reason: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.park");
  const by = person(actor, "Stopping a scout is");
  const swarm = swarmOf(w.data);
  const sc = swarm?.scouts.find((s) => s.id === scoutId);
  if (!swarm || !sc || swarm.endedAt) throw refuse("not_found", "No such scout is working on this work order.");
  if (terminal(sc)) throw conflict(`Scout ${sc.id} already ended.`);
  await tx.query(`update attempts set state = 'cancelled', outcome = 'stopped', ended_at = $3, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2 and state in ('queued','running')`, [fx.orgId, sc.attempt, fx.now]);
  await revokeRunTokens(tx, { orgId: fx.orgId, runIds: [runIdFor(sc.attempt)], reason: `scout stopped by ${by}` });
  sc.state = "stopped";
  sc.stoppedBy = by;
  sc.summary = reason.slice(0, 300);
  ev(fx, w, "research.scout.stopped", { station: swarm.station, scout: sc.id, text: reason.slice(0, 200) });
  note(w, fx, by, `Stopped scout ${sc.id}${reason ? `: ${reason}` : "."}`);
  const closed = await closeIfDone(fx, w, swarm);
  w.data.swarm = swarm;
  await saveWo(tx, fx.orgId, w);
  return done(fx, closed ? `Scout ${sc.id} stopped; the station brings the findings together now.` : `Scout ${sc.id} stopped.`, w.project, { version: w.version });
}
