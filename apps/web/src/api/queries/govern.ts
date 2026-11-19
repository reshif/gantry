/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { useQuery } from "@tanstack/react-query";
import { api, get } from "../client";
import { qk } from "../keys";
import { readIfAllowed } from "../can";
import type { AccessMatrixData, AuditEntry, AuditFilters, Freeze, Page, Person, Policy, Workload } from "../types";
import type { Team } from "@gantry/domain";

const POLICY = ["policy.view"] as const;
const PEOPLE = ["people.view"] as const;

/* ---------- people, access, audit, workload ---------- */

/** GET /api/v1/teams. The one teams read: People, Access and the project wizard share this key and this shape. */
export const useTeams = () => useQuery({ queryKey: qk.teams(), queryFn: () => get<Team[]>(api("teams")), staleTime: 30_000 });
export const usePeople = () => useQuery({ queryKey: qk.people(), queryFn: () => get<Person[]>(api("people")) });
export const useEffectivePermissions = (personId: string | null | undefined) =>
  useQuery({ queryKey: qk.effectivePermissions(personId ?? ""), queryFn: () => readIfAllowed(PEOPLE, () => get<unknown>(api(`people/${encodeURIComponent(personId ?? "")}/effective-permissions`))), enabled: !!personId });
export const useAccessMatrix = () => useQuery({ queryKey: qk.matrix(), queryFn: () => readIfAllowed(POLICY, () => get<AccessMatrixData>(api("access/matrix"))) });
export const usePolicies = () => useQuery({ queryKey: qk.policies(), queryFn: () => readIfAllowed(POLICY, () => get<Policy[]>(api("policies"))) });
export const useFreezes = () => useQuery({ queryKey: qk.freezes(), queryFn: () => readIfAllowed(POLICY, () => get<Freeze[]>(api("freezes"))) });
export const useAudit = (filters: AuditFilters = {}) =>
  useQuery({ queryKey: qk.audit(filters), queryFn: () => get<Page<AuditEntry> | AuditEntry[]>(api("audit"), { ...filters }) });
export const useAuditEntry = (seq: number | string | null | undefined) =>
  useQuery({ queryKey: qk.auditEntry(seq ?? ""), queryFn: () => get<AuditEntry>(api(`audit/${encodeURIComponent(String(seq))}`)), enabled: seq != null && seq !== "" });
/** Walks the hash chain server-side. Not cached long: a verification is a statement about now. */
export const useAuditVerify = (enabled = false) =>
  useQuery({ queryKey: qk.auditVerify(), queryFn: () => get<{ ok: boolean; checked: number; [k: string]: unknown }>(api("audit/verify")), enabled, staleTime: 0 });
export const useWorkload = (scope?: string, days?: number) => useQuery({ queryKey: qk.workload(scope, days), queryFn: () => get<Workload>(api("workload"), { scope, days }), placeholderData: (prev) => prev });

export interface FactoryStop { id: string; scope: string; mode: string; reason: string; inFlight: string | null; by: string; at: number }
/** Every stop in force (GET /api/v1/stops), for the Security screen's Emergency stop section. */
export const useFactoryStops = () => useQuery({ queryKey: qk.factoryStops(), queryFn: async () => (await get<{ items: FactoryStop[] }>(api("stops"))).items });
