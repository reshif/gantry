/**
 * Shared pieces of the API & triggers screen (legacy views/api.js helpers): the viewer's projects, keys, settings, triggers and sources, a rights check across projects,
 * the status chip, the copyable code block and the labels the screen uses. Same classes and ids as legacy.
 */
import { useMemo } from "react";
import type { ApiConfig, ApiKey, IntegrationInstance, Project, RequestLogEntry, Trigger } from "@gantry/domain";
import { useCanMany } from "../../api/can";
import { useApiConfig, useApiKeys, useApiRequests, useIntegrationTypes, useIntegrations, useMe, useProjects, useTriggers } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";
import { Btn, useCopy, type Decision } from "../../ui/primitives";

export const KEY_ACTIONS: Array<[string, string]> = [["wo.submit", "Submit work orders"], ["wo.read", "Read work orders"], ["wo.answer", "Answer intake questions"], ["triggers.run", "Fire triggers"]];
export const TTYPES: Record<string, { name: string; icon: string }> = {
  issue: { name: "Issue with label", icon: "tag" }, comment: { name: "PR / MR comment command", icon: "chat" }, schedule: { name: "Schedule", icon: "clock" }, ci: { name: "Failing CI on main", icon: "alert" },
};
/** Who may trigger, by trigger type. A trigger creates work only for a source user who maps to a Gantry person allowed to submit; everything else is held for a person (spec 11.7). */
export const WHO_ISSUE = [{ value: "org", label: "Org members (others held for a person)" }, { value: "proposal", label: "Everyone held for a person" }];
export const WHO_SYSTEM = [{ value: "system", label: "System creates the work order" }, { value: "proposal", label: "Held for a person" }];
export const whoOptions = (type: string) => (type === "issue" || type === "comment" ? WHO_ISSUE : WHO_SYSTEM);

export const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export const emptyDecision: Decision = { allowed: false, reason: "Create a key first.", needs: undefined };

/** Legacy G.meAnyProject: allowed when the action is allowed on any of the viewer's projects; else the first project's refusal. */
export function useCanAny(action: string, projects: Project[]): Decision {
  const rs = useCanMany(projects.map((p) => ({ action, project: p.id })));
  const ok = rs.find((r) => r.allowed);
  const r = ok ?? rs[0] ?? { allowed: false, reason: "You have no projects.", needs: "" };
  return dec(r);
}

export interface ApiData {
  me: ReturnType<typeof useMe>;
  /** The viewer's projects (legacy G.visibleProjects). */
  vis: Project[];
  visIds: string[];
  pname: (id: string) => string;
  /** Keys in the top-bar scope; `allKeys` is every key on the viewer's projects (the prototype's "N of M" total and tab count). */
  keys: ApiKey[];
  allKeys: ApiKey[];
  cfg: ApiConfig | undefined;
  triggers: Trigger[];
  allTriggers: Trigger[];
  log: RequestLogEntry[];
  last24h: number;
  limited24h: number;
  insts: IntegrationInstance[];
  typeOf: (id: string) => { id: string; name: string; category: string; source?: boolean | undefined; custom?: boolean | undefined } | undefined;
  loading: boolean;
  keysQ: ReturnType<typeof useApiKeys>;
  trigQ: ReturnType<typeof useTriggers>;
  logQ: ReturnType<typeof useApiRequests>;
  cfgQ: ReturnType<typeof useApiConfig>;
}

export function useApiData(): ApiData {
  const me = useMe();
  const prefs = usePrefs();
  const projectsData = useProjects().data;
  const projects = useMemo(() => projectsData ?? [], [projectsData]);
  const keysQ = useApiKeys();
  const cfgQ = useApiConfig();
  const trigQ = useTriggers();
  const logQ = useApiRequests({ limit: 200 });
  const insts = useIntegrations().data ?? [];
  const types = useIntegrationTypes().data ?? [];
  const vis = useMemo(() => (me ? projects.filter((p) => me.projects.some((x) => x.id === p.id)) : []), [me, projects]);
  const visIds = vis.map((p) => p.id);
  // the top bar scope: a chosen project narrows keys and triggers to it, All projects shows every project the person can see
  const scoped = !prefs.scopeAll && prefs.project && visIds.includes(prefs.project) ? [prefs.project] : visIds;
  const raw = logQ.data;
  const items = Array.isArray(raw) ? raw : raw?.items ?? [];
  const extra = (!Array.isArray(raw) && raw ? (raw as unknown as { last24h?: number; limited24h?: number }) : {}) as { last24h?: number; limited24h?: number };
  const day = Date.now() - 86_400_000;
  return {
    me, vis, visIds, pname: (id) => projects.find((p) => p.id === id)?.name ?? id,
    keys: (keysQ.data ?? []).filter((k) => scoped.includes(k.project)), allKeys: (keysQ.data ?? []).filter((k) => visIds.includes(k.project)), cfg: cfgQ.data, triggers: (trigQ.data ?? []).filter((t) => scoped.includes(t.project)), allTriggers: (trigQ.data ?? []).filter((t) => visIds.includes(t.project)),
    log: items, last24h: extra.last24h ?? items.filter((x) => x.at > day).length, limited24h: extra.limited24h ?? items.filter((x) => x.at > day && x.status === 429).length,
    insts, typeOf: (id) => types.find((t) => t.id === id), loading: keysQ.isPending || trigQ.isPending, keysQ, trigQ, logQ, cfgQ,
  };
}

export function StatusChip({ code }: { code: number }) {
  const c = code >= 500 ? "failed" : code >= 400 ? (code === 429 ? "warn" : "denied") : "ok";
  return <span className={`outcome o-${c} mono`}>{(c === "ok" ? "✓ " : c === "warn" ? "◆ " : "✕ ") + code}</span>;
}

export function CodeBlock({ id, text, label }: { id: string; text: string; label?: string }) {
  const copy = useCopy();
  return (
    <div className="api-code">
      <div className="api-code-bar">
        <span className="kv-k">{label || "Sample"}</span>
        <Btn label="Copy" small icon="copy" id={id} onClick={() => copy(text)} />
      </div>
      <pre className="mono" tabIndex={0} aria-label={label || "Code sample"}>{text}</pre>
    </div>
  );
}

/** Which trigger kinds a source connection can drive (legacy kindsFor). */
export function kindsFor(src: string, d: ApiData): string[] {
  if (src === "schedule") return ["schedule"];
  const i = d.insts.find((x) => x.id === src);
  const t = i && d.typeOf(i.type);
  if (!t) return ["issue"];
  // A custom connection's signed webhook says which kind of event it sends (spec 12.1).
  if (t.custom) return ["issue", "comment", "ci"];
  if (t.category === "source") return ["issue", "comment", "ci"];
  if (t.category === "ci") return ["ci"];
  return ["issue"];
}
export const srcName = (src: string | undefined, d: ApiData): string => (src === "schedule" ? "Schedule" : d.insts.find((i) => i.id === src)?.name ?? (src ? `${src} (removed)` : "No source"));
export function srcState(src: string | undefined, d: ApiData): string {
  if (src === "schedule") return "healthy";
  const i = d.insts.find((x) => x.id === src);
  return !i ? "missing" : !i.connected ? "disabled" : i.status;
}
/** Source connections of a project that can be trigger sources (legacy srcInsts). */
export const sourceInsts = (pid: string, d: ApiData): IntegrationInstance[] => d.insts.filter((i) => (i.projects === "all" || i.projects.includes(pid)) && d.typeOf(i.type)?.source);
export function srcOptions(pid: string, cur: string | null | undefined, kind: string | null, d: ApiData): Array<{ value: string; label: string }> {
  const list = sourceInsts(pid, d).filter((i) => !kind || kindsFor(i.id, d).includes(kind)).map((i) => ({ value: i.id, label: i.name + (srcState(i.id, d) === "healthy" ? "" : ` (${srcState(i.id, d)})`) }));
  if (!kind || kind === "schedule") list.push({ value: "schedule", label: "Schedule (no external source)" });
  if (cur && !list.some((o) => o.value === cur)) list.unshift({ value: cur, label: `${srcName(cur, d)} (not open to this project)` });
  return list;
}
export const BASE = typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null" ? window.location.origin : "https://gantry.example";

/** Where a custom connection's trigger events are posted (spec 12.1), or null for a connection that is not a custom trigger source. */
export function hookUrl(src: string | undefined, d: ApiData): string | null {
  const i = d.insts.find((x) => x.id === src);
  return i && d.typeOf(i.type)?.custom ? `${BASE}/hooks/trigger/${i.id}` : null;
}

/** The prototype's source tag of a trigger: issue, pr-comment, schedule, ci or jira (an issue trigger whose connection is Jira). */
export function trigTag(t: { type: string; source?: string | undefined }, d: ApiData): string {
  if (t.type === "comment") return "pr-comment";
  const inst = t.source ? d.insts.find((i) => i.id === t.source) : undefined;
  if (t.type === "issue" && inst?.type === "jira") return "jira";
  return t.type;
}
/** The prototype's source choices, and the real trigger kind (and connection type) each one stands for. */
export const TRIG_SOURCES = ["issue", "pr-comment", "schedule", "ci", "jira"] as const;
