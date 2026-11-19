/** System health data: GET /api/v1/system/health and the dead letter retry. Shapes mirror services/api/src/areas/system/health.ts. */
import { qk } from "../../api/keys";
import { useQuery } from "@tanstack/react-query";
import { api, get, post, type ApiResult } from "../../api/client";
import { invalidateSlices } from "../../api/keys";

export type ServiceStatus = "ok" | "degraded" | "down" | "unknown";
export interface ServiceHealth { id: string; name: string; status: ServiceStatus; detail: string; latencyMs: number | null; heartbeatAgeSeconds?: number | null }
export interface BackupStatus { status: "ok" | "stale" | "failed" | "unknown"; at: string | null; ageHours: number | null; set: string | null; detail: string }
export interface DrillStatus { status: "ok" | "failed" | "unknown"; at: string | null; ageHours: number | null; set: string | null; seconds: number | null; failedChecks: number; detail: string }
export interface DeadLetter { id: string; destination: string; scope: "factory" | "project"; attempts: number; maxAttempts: number; lastError: string | null; createdAt: string; failedAt: string;
  /** The work order the delivery was about. Optional: the server does not report it yet (backend gap). */ workOrder?: string | null }
export interface StuckJob { id: string; queue: string; kind: string; attempts: number; maxAttempts: number; owner: string | null; startedAt: string | null; leaseUntil: string | null; reason: "lease_expired" | "running_long"; lastError: string | null;
  /** The work order the job advances. Optional: the server reports only the job, not the work order (backend gap). */ workOrder?: { id: string; title: string; project?: string | null; reason?: string | null } | null }
export interface DeadJob { id: string; queue: string; kind: string; attempts: number; maxAttempts: number; lastError: string | null; diedAt: string }
export interface RunStartFailure { code: string; reason: string; count: number; lastAt: string }
export interface SystemHealth {
  at: string;
  services: ServiceHealth[];
  backup: BackupStatus;
  drill: DrillStatus;
  outbox: { counts: Record<"pending" | "sending" | "delivered" | "dead", number>; oldestPendingSeconds: number | null; dead: DeadLetter[] };
  jobs: { counts: Record<"queued" | "running" | "done" | "dead", number>; stuck: StuckJob[]; runningLongMinutes: number; dead?: DeadJob[]; deadWindowHours?: number };
  runStarts?: { windowMinutes: number; failed: number; reasons: RunStartFailure[] };
}

/** Refreshes itself every 30 s: this page is for watching. */
export const useSystemHealth = () =>
  useQuery({ queryKey: qk.systemHealth(), queryFn: () => get<SystemHealth>(api("system/health")), refetchInterval: 30_000, staleTime: 10_000 });

export async function retryDeadLetter(id: string): Promise<ApiResult> {
  const r = await post(api(`system/outbox/${encodeURIComponent(id)}/retry`));
  if (r.ok) invalidateSlices(["system", "audit"]);
  return r;
}
