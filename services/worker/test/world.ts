import { randomUUID } from "node:crypto";
import { bootstrapOrg, job } from "@gantry/api/core";
import { enqueue, type Job } from "@gantry/db";
import pino from "pino";
import type { WorkerConfig } from "../src/config.js";
import { buildDeps, Worker } from "../src/worker.js";
import type { Deps } from "../src/deps.js";
import { createTestDb, type TestDb } from "./db.js";
import { FakeBroker, FakeLauncher, FakeSmtp } from "./doubles.js";

export function testWorkerConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    launcherUrl: "", launcherToken: "launcher-test-token", brokerUrl: "", brokerToken: "github-test-token", runnerVariant: "base",
    smtp: { host: "127.0.0.1", port: 0, from: "Gantry <gantry@test>", secure: false }, egressProxy: null, egressCa: null,
    s3: { endpoint: null, bucket: "gantry", accessKey: "gantry", secretKey: null, region: "us-east-1" }, heartbeatFile: `/tmp/gantry-worker-test-${randomUUID()}`,
    concurrency: { flow: 4, stop: 4, github: 2, system: 2, timers: 2 }, jobLeaseMs: 30_000, pollMs: 50, terminationVerifyMs: 300, terminationPollMs: 20, haltGraceMs: 0, reaperGraceMs: 0,
    reaperEveryMs: 60_000, reconcileEveryMs: 300_000, verifyEveryMs: 86_400_000, watchdogEveryMs: 100, baseStaleMs: 600_000, startupLeaseMs: 180_000, publishLeaseMs: 900_000, maxDispatchDeferrals: 3, allowStubAdapter: true, dataKey: null,
    ...over,
  };
}

export interface World {
  db: TestDb;
  orgId: string;
  launcher: FakeLauncher;
  broker: FakeBroker;
  smtp: FakeSmtp;
  deps: Deps;
  worker: Worker;
  /** Rows as the owner. */
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** A work order at `station` with a queued attempt and its dispatch job. */
  workOrderAt(id: string, o?: { station?: string; agent?: string; repo?: string | null; github?: boolean; project?: string; dispatch?: boolean }): Promise<{ attemptId: string; fencing: number; runId: string }>;
  enqueue(kind: Parameters<typeof job>[0], payload: any, o?: { dedupeKey?: string; runAt?: Date; maxAttempts?: number }): Promise<string>;
  /** Run every claimable job (and due timer) to completion. Failed jobs that were rescheduled are made due again `retries` times. */
  drain(retries?: number): Promise<void>;
  jobs(kind?: string): Promise<Array<{ id: string; kind: string; status: string; attempts: number; last_error: string | null; result: any; payload: any }>>;
  close(): Promise<void>;
}

export async function startWorld(o: { cfg?: Partial<WorkerConfig>; smtp?: boolean; deps?: Partial<Deps> } = {}): Promise<World> {
  const db = await createTestDb();
  const { orgId } = await bootstrapOrg(db.app, { orgSlug: "acme", orgName: "Acme Test", devSeed: true }, undefined, { seedAudit: false, seedEvals: false });
  const launcher = await new FakeLauncher().start();
  const broker = await new FakeBroker().start();
  const smtp = await new FakeSmtp().start();
  const cfg = testWorkerConfig({ launcherUrl: launcher.url, brokerUrl: broker.url, smtp: { host: "127.0.0.1", port: smtp.port, from: "Gantry <gantry@test>", secure: false }, ...o.cfg });
  const deps = buildDeps(db.app, cfg, pino({ level: "silent" }), o.deps ?? {});
  const worker = new Worker(deps);
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

  const w: World = {
    db, orgId, launcher, broker, smtp, deps, worker, q,
    async workOrderAt(id, x = {}) {
      const station = x.station ?? "build";
      const repo = x.repo === undefined ? "payments-api" : x.repo;
      if (x.github && repo) await q(`update repos set github_full_name = $2 where org_id = $1 and id = $3`, [orgId, `acme/${repo}`, repo]);
      await q(
        `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, position, state, flow_version, submitter, risk, sla_due_at, data)
         values ($1,$2,$3,$4,$5,'feature','P2',$6,'running',(select current_flow_version from projects where org_id = $1 and id = $3),'p-tomas','normal', now() + interval '3 days', $7::jsonb)`,
        [orgId, id, x.project ?? "payments", repo, `Work ${id}`, station, JSON.stringify({ history: [{ station, agent: x.agent ?? "", model: "", startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" }], log: [] })],
      );
      const attemptId = `ATT-${id}-${station}-1`;
      const ins = await q<{ fencing: string }>(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,1,'queued',$5::jsonb) returning fencing::text`, [orgId, attemptId, id, station, JSON.stringify({ agent: x.agent ?? "" })]);
      const fencing = Number(ins[0]!.fencing);
      if (x.dispatch !== false) await w.enqueue("attempt.dispatch", { woId: id, station, attemptId, fencing }, { dedupeKey: `attempt:${attemptId}` });
      const { runIdFor } = await import("../src/handlers/common.js");
      return { attemptId, fencing, runId: runIdFor(attemptId) };
    },
    async enqueue(kind, payload, x = {}) {
      const j = job(kind, payload, x);
      const r = await enqueue(db.app, { orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(x.dedupeKey ? { dedupeKey: x.dedupeKey } : {}), ...(x.runAt ? { runAt: x.runAt } : {}), ...(x.maxAttempts ? { maxAttempts: x.maxAttempts } : {}) });
      return r.id;
    },
    async drain(retries = 0) {
      await worker.runner.drain();
      for (let i = 0; i < retries; i++) {
        const n = await q(`update jobs set run_at = now() where status = 'queued' and run_at > now()`);
        void n;
        await worker.runner.drain();
      }
    },
    async jobs(kind) {
      return q(`select id, kind, status, attempts, last_error, result, payload from jobs ${kind ? "where kind = $1" : ""} order by created_at`, kind ? [kind] : []);
    },
    async close() {
      await worker.stop(1_000).catch(() => undefined);
      await Promise.allSettled([launcher.stop(), broker.stop(), smtp.stop()]);
      await db.drop();
    },
  };
  return w;
}

export type { Job };
