import { useInfiniteQuery } from "@tanstack/react-query";
import type { AuditEntry } from "@gantry/domain";
import { api, get } from "../../api/client";
import { qk } from "../../api/keys";

/** An audit entry as GET /api/v1/audit returns it: the legacy shape plus the chain digests and who the actor is. */
export interface AuditRow extends AuditEntry {
  seq: number;
  actorKind: "human" | "agent" | "system";
  actorName: string;
  channel: string;
  digest: string;
  prev: string;
}

export interface AuditPage {
  items: AuditRow[];
  next: string | null;
  total: number;
  summary: {
    entries: number;
    denied: number;
    changes: number;
    head: string;
    categories: Record<string, number>;
    topics: Record<string, number>;
    facets: { outcomes: string[]; channels: string[]; actors: Array<{ id: string; name: string }> };
  };
}

export interface AuditDetail extends AuditRow {
  rule: string | null;
  onBehalfOf: string | null;
  topic: string | null;
  workOrder: string | null;
  session: { id: string; method: string | null; ip: string | null; userAgent: string | null; startedAt: number | null } | null;
  request: { id: string | null; command: string | null; idempotencyKey: string | null };
  sourceIp: string | null;
  diff: Array<{ field: string; before: unknown; after: unknown; changed: boolean }> | null;
  history: AuditRow[];
}

export interface Filters {
  q: string;
  project: string;
  cat: string;
  topic: string;
  actor: string;
  outcome: string;
  via: string;
  changes: boolean;
}
export const NO_FILTERS: Filters = { q: "", project: "all", cat: "all", topic: "all", actor: "all", outcome: "all", via: "all", changes: false };
export const PAGE = 60;

export const CAT_ICON: Record<string, string> = { auth: "key", access: "lock", flow: "belt", onboarding: "branch", approvals: "gate", config: "tool", integrations: "plug", api: "api", agents: "agent", kill: "kill", trust: "trust", learning: "learn" };
export const CAT_NAME: Record<string, string> = { auth: "Auth", access: "Access", flow: "Flow", onboarding: "Onboarding", approvals: "Approvals", config: "Config", integrations: "Integrations", api: "API", agents: "Agents", kill: "Kill", trust: "Trust", learning: "Learning" };
export const TOPICS = [
  { id: "trust", name: "Trust", icon: "trust" },
  { id: "learning", name: "Learning", icon: "learn" },
  { id: "catalogue", name: "Catalogue", icon: "tool" },
  { id: "record", name: "Records", icon: "record" },
] as const;
export const topicName = (id: string | null): string | null => TOPICS.find((t) => t.id === id)?.name ?? null;

const params = (f: Filters): Record<string, string> => {
  const o: Record<string, string> = {};
  if (f.q.trim()) o.q = f.q.trim();
  if (f.project !== "all") o.project = f.project;
  if (f.cat !== "all") o.category = f.cat;
  if (f.topic !== "all") o.topic = f.topic;
  if (f.actor !== "all") o.actor = f.actor;
  if (f.outcome !== "all") o.outcome = f.outcome;
  if (f.via !== "all") o.channel = f.via;
  if (f.changes) o.changes = "true";
  return o;
};

/** The ledger, newest first, one page at a time. The `audit` slice (SSE) refetches it. */
export function useAuditFeed(f: Filters) {
  const p = params(f);
  return useInfiniteQuery({
    queryKey: qk.audit({ ...p, feed: true }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => get<AuditPage>(api("audit"), { ...p, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.next ?? undefined,
  });
}
