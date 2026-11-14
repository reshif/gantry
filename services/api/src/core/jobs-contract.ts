/**
 * The job contract shared by the flow API, the edge, the GitHub broker and the worker (spec 6.2, 9.1).
 * A job is `{ queue, kind, payload }`. Payloads are parsed with these schemas on both sides: the producer builds one
 * with `job(...)` (so a malformed payload cannot be enqueued) and the consumer calls `parseJob(...)`.
 */
import { z } from "zod";

export const QUEUES = { flow: "flow", stop: "stop", github: "github", system: "system", timers: "timers" } as const;
export type Queue = (typeof QUEUES)[keyof typeof QUEUES];

const id = z.string().min(1).max(200);
const fencing = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform((v) => Number(v));

/** Stop scopes as written in `stops.scope_type`. */
export const STOP_SCOPES = ["factory", "project", "repo", "wo"] as const;
export type StopScope = (typeof STOP_SCOPES)[number];

export const JOB_SCHEMAS = {
  /** 'flow' queue: a work order entered an agent-staffed station; the worker starts the run through the launcher. */
  "attempt.dispatch": z.object({ woId: id, station: id, attemptId: id, fencing }),
  /** 'flow' queue: the internal result intake stored a station result; the worker applies it (see `applyStationResult`). */
  "run.result": z.object({ runId: id, attemptId: id, fencing }),
  /** 'flow' queue: publish the attempt's workspace commits through gantry-github (refused for a superseded attempt). */
  publish: z.object({ attemptId: id, fencing }),
  /** 'flow' queue: ask gantry-github to merge a pull request at the approved head commit. */
  "merge.request": z.object({ woId: id, prNumber: z.number().int().positive(), headSha: z.string().min(7).max(64) }),
  /** 'flow' queue: escalation, soak and lease-expiry timers. */
  "flow.timer": z.object({ kind: z.enum(["escalation", "soak", "lease_expiry"]), woId: id.optional(), gateInstanceId: id.optional() }),
  /** 'stop' queue: make a committed stop true in the world (interrupt/kill runs, cancel merges, fail the Gantry check). */
  "stop.enforce": z.object({ stopId: id, scope: z.enum(STOP_SCOPES), targetId: id.nullable(), mode: z.enum(["halt", "kill"]) }),
  /** 'github' queue. */
  "github.reconcile": z.object({ repoId: id }),
  "github.event": z.object({ deliveryId: id }),
  /** 'github' queue: repository onboarding (spec 11.3). `runId` names the assessment run the job belongs to; a job whose run is no longer current does nothing. */
  "onboarding.assess": z.object({ repoId: id, runId: id }),
  "onboarding.open_pr": z.object({ repoId: id, runId: id, by: id.nullable().default(null), request: z.string().max(5000).nullable().default(null) }),
  "onboarding.merge": z.object({ repoId: id, runId: id, prNumber: z.number().int().positive(), headSha: z.string().regex(/^[0-9a-f]{40}$/), by: id }),
  "onboarding.verify": z.object({ repoId: id, runId: id.nullable().default(null), trigger: z.enum(["merge", "manual", "schedule"]), by: id.nullable().default(null) }),
  "onboarding.sync": z.object({ repoId: id }),
  /** 'github' queue: an event from a source (a labelled issue, a pull request comment, a failing default-branch build) offered to the project's triggers (spec 11.7). Text fields are untrusted. */
  "trigger.evaluate": z.object({
    kind: z.enum(["issue", "comment", "ci"]), repo: z.string().min(1).max(300), title: z.string().max(2000).optional(), body: z.string().max(20000).optional(), labels: z.array(z.string().max(200)).max(100).optional(),
    author: z.string().max(200).optional(), comment: z.string().max(20000).optional(), ref: z.string().max(300).optional(), url: z.string().max(1000).optional(), check: z.string().max(300).optional(), dedupeKey: z.string().min(1).max(300),
  }),
  /** 'github' queue: a schedule trigger came due (`due` is the instant it was scheduled for; it is also the run's dedupe key). */
  "trigger.tick": z.object({ triggerId: id, due: z.string().min(1).max(40) }),
  /** 'system' queue. */
  "chain.verify": z.object({}),
  "reaper.sweep": z.object({}),
} as const;

export type JobKind = keyof typeof JOB_SCHEMAS;
export type JobPayload<K extends JobKind> = z.infer<(typeof JOB_SCHEMAS)[K]>;
/** What a producer passes in: schemas with transforms accept looser input than they emit. */
export type JobPayloadInput<K extends JobKind> = z.input<(typeof JOB_SCHEMAS)[K]>;

export const JOB_QUEUE: { [K in JobKind]: Queue } = {
  "attempt.dispatch": "flow", "run.result": "flow", publish: "flow", "merge.request": "flow", "flow.timer": "flow",
  "stop.enforce": "stop", "github.reconcile": "github", "github.event": "github", "trigger.evaluate": "github", "trigger.tick": "github", "chain.verify": "system", "reaper.sweep": "system",
  "onboarding.assess": "github", "onboarding.open_pr": "github", "onboarding.merge": "github", "onboarding.verify": "github", "onboarding.sync": "github",
};

/** Outbox destinations (spec 6.2): delivered by the worker; chat and webhooks go through the edge forward proxy. */
export const OUTBOX_DESTINATIONS = ["smtp", "slack", "teams", "webhook"] as const;
export type OutboxDestination = (typeof OUTBOX_DESTINATIONS)[number];

export interface BuiltJob {
  kind: JobKind;
  queue: Queue;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
}

/** Validates the payload and returns a job in the shape `command()`'s `jobs` and `enqueue()` take. */
export function job<K extends JobKind>(kind: K, payload: JobPayloadInput<K>, o: { dedupeKey?: string; priority?: number; runAt?: Date; maxAttempts?: number } = {}): BuiltJob {
  const parsed = JOB_SCHEMAS[kind].parse(payload) as Record<string, unknown>;
  return { kind, queue: JOB_QUEUE[kind], payload: parsed, ...o };
}

/** Consumer side: the typed payload of a claimed job, or an error describing why it is malformed. */
export function parseJob<K extends JobKind>(kind: K, payload: unknown): { ok: true; value: JobPayload<K> } | { ok: false; error: string } {
  const r = JOB_SCHEMAS[kind].safeParse(payload);
  return r.success ? { ok: true, value: r.data as JobPayload<K> } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "payload"} ${i.message}`).join("; ") };
}

export const isJobKind = (k: string): k is JobKind => Object.prototype.hasOwnProperty.call(JOB_SCHEMAS, k);
