/**
 * Shared pieces of the Agents screen (legacy views/agents.js): the draft the detail panel edits (kept across tabs and screens, as legacy kept it),
 * the tool and autonomy catalogues, the create-agent templates, model and station lookups, the POL-112 display check and the audit history of one entity.
 * The server decides every change; the autonomy check here only disables a choice and says why.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { fmt, type Agent, type AgentVersion, type Policy, type Project } from "@gantry/domain";
import { useAudit, useRouting, useVendors } from "../../api/queries";
import type { AuditEntry } from "../../api/types";
import { Empty, Who, type Decision } from "../../ui/primitives";
import { useCatalog } from "../projects/kit";

export interface VersionElig {
  ok: boolean;
  text: string;
  score: number | null;
  run?: string;
  suite: string | null;
  threshold: number | null;
  needs: string;
  runs?: number;
}
export type AgentVersionRow = AgentVersion & { eligibility: VersionElig };
/** An agent as GET /agents returns it: the legacy shape plus the version to send as If-Match, its suite's name and threshold, and each version's promotion eligibility. */
export type AgentRow = Omit<Agent, "versions"> & { rev: number; suiteName: string | null; threshold: number | null; running?: number; versions: AgentVersionRow[] };

export type Tools = Record<string, boolean>;
export const TOOLS: Array<[string, string, string]> = [
  ["readRepo", "Read repo", "Clone and read files on any branch."],
  ["writeBranch", "Write to a branch", "Push commits to its own gantry/ branch."],
  ["runTests", "Run tests", "Run the repo test command in the sandbox."],
  ["openPR", "Open pull requests", "Open or update PRs from its branch."],
  ["merge", "Merge pull requests", "Merge after G5 passes. High risk."],
  ["postSlack", "Post to Slack", "Post updates to configured channels."],
  ["sendEmail", "Send email", "Send mail through the factory sender."],
  ["readSecrets", "Read CI secrets", "Read masked CI secrets at run time. High risk."],
];
export const AUTONOMY: Array<[string, string, string]> = [
  ["suggest", "Suggest", "Proposes output; a human applies it."],
  ["gate", "Act with gate", "Acts, then stops at the next human gate."],
  ["auto", "Act autonomously", "Acts and moves work on without a human."],
];
export interface Template { id: string; name: string; station: string; tools: Tools; skills: string[]; budget: number; autonomy: string; instructions: string }
export const TEMPLATES: Template[] = [
  { id: "builder", name: "Builder", station: "build", tools: { writeBranch: true, runTests: true, openPR: true }, skills: ["sk-testdesign"], budget: 10, autonomy: "gate", instructions: "Implement the approved plan on a branch. Keep diffs small and add tests." },
  { id: "reviewer", name: "Reviewer", station: "review", tools: {}, skills: ["sk-security"], budget: 3, autonomy: "suggest", instructions: "Review the diff against the spec and plan. Recommend; a human decides." },
  { id: "docs", name: "Docs Writer", station: "close", tools: { writeBranch: true, openPR: true }, skills: ["sk-relnotes"], budget: 2, autonomy: "gate", instructions: "Update READMEs, runbooks and changelogs to match the change." },
  { id: "migrations", name: "Migration Specialist", station: "plan", tools: {}, skills: ["sk-migration"], budget: 4, autonomy: "suggest", instructions: "Plan schema and data migrations with explicit rollback and backfill steps." },
  { id: "blank", name: "Blank agent", station: "intake", tools: {}, skills: [], budget: 1, autonomy: "suggest", instructions: "" },
];
export const EDIT_KEYS = ["name", "model", "fallbacks", "autonomy", "tools", "skills", "mcp", "stations", "projects", "budget", "guardrails", "instructions", "overrides", "suite"] as const;
export type EditKey = (typeof EDIT_KEYS)[number];
export type Draft = Omit<Pick<AgentRow, EditKey>, "tools"> & { tools: Tools };

export const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
export const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
export const pick = (a: AgentRow): Draft => Object.fromEntries(EDIT_KEYS.map((k) => [k, clone(a[k] ?? null)])) as unknown as Draft;
export const words = (t: string): number => (String(t || "").trim() ? String(t).trim().split(/\s+/).length : 0);
export const liveVersion = (a: AgentRow): AgentVersionRow | undefined => a.versions.find((v) => v.live) ?? a.versions[a.versions.length - 1];
/** The next candidate label: 2.6.1 gives 2.7.0-rc1 (legacy nextVersion). */
export function nextVersion(a: AgentRow): string {
  const p = String(a.version).replace(/-.*/, "").split(".").map(Number);
  const c = `${p[0] ?? 0}.${(p[1] ?? 0) + 1}.0-rc`;
  let n = 1;
  while (a.versions.some((v) => v.v === c + n)) n++;
  return c + n;
}

/* ---------- screen state, kept across tabs and screens like legacy `ui` ---------- */

export const ui = { sel: null as string | null, tab: "config", ctxProject: null as string | null, ctxRepo: null as string | null, newVer: "", newNote: "" };
let tick = 0;
const listeners = new Set<() => void>();
export const rerender = (): void => {
  tick++;
  listeners.forEach((l) => l());
};
export const useAgentsUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);
/** Other screens (evals, skills, palette) can ask for an agent. */
export const agentsSelect = (id: string, tab?: string): void => {
  ui.sel = id;
  if (tab) ui.tab = tab;
  rerender();
};

/* ---------- models and stations ---------- */

export interface ModelOpt { id: string; name: string; vendor: string }
/** Enabled models on connected vendors (legacy enabledModels). Empty while the models screen's endpoint is unavailable. */
export function useModels() {
  const vendors = useVendors().data ?? [];
  const routing = useRouting().data;
  const list: ModelOpt[] = [];
  for (const v of vendors) for (const m of v.models ?? []) if (m.enabled && v.connected) list.push({ id: m.id, name: m.name, vendor: v.name });
  const find = (id: string) => vendors.flatMap((v) => (v.models ?? []).map((m) => ({ m, v }))).find((x) => x.m.id === id);
  return {
    list,
    name: (id: string): string => find(id)?.m.name ?? id,
    usable: (id: string): boolean => { const x = find(id); return !!(x && x.m.enabled && x.v.connected); },
    defaultModel: routing?.defaultModel ?? "",
    overrides: (routing?.overrides ?? {}) as Record<string, string>,
  };
}

export function useStations() {
  const cat = useCatalog();
  const stations = cat?.stations ?? [];
  return {
    all: stations,
    find: (id: string | null) => stations.find((s) => s.id === id) ?? null,
    label: (id: string | null, projects: Project[] = []): string => {
      const s = stations.find((x) => x.id === id);
      return s ? `${s.no} ${s.name}${s.custom ? ` (${projects.find((p) => p.id === s.project)?.name ?? s.project})` : ""}` : "Off-belt";
    },
  };
}

/* ---------- POL-112 (display only; the server refuses) ---------- */

const EARLY = ["intake", "research", "spec", "design"];
export interface Verdict { allowed: boolean; reason?: string; rule?: string }
export function autonomyCheck(policies: Policy[], projects: Project[], agent: { station: string | null; projects: "all" | string[] }, autonomy: string, projectId?: string): Verdict {
  if (autonomy !== "auto") return { allowed: true };
  const p = policies.find((x) => x.id === "POL-112");
  if (!p || !p.enabled) return { allowed: true };
  if (agent.station === null || EARLY.includes(agent.station)) return { allowed: true };
  const scope = projectId ? projects.filter((x) => x.id === projectId) : agent.projects === "all" ? projects : projects.filter((x) => (agent.projects as string[]).includes(x.id));
  const reg = scope.filter((x) => x.regulated);
  if (reg.length) return { allowed: false, rule: "POL-112", reason: `POL-112: no autonomous agents from Plan onward on regulated projects (${reg.map((x) => x.name).join(", ")}). Use act with gate or exclude those projects.` };
  return { allowed: true };
}
export const verdictDecision = (v: Verdict): Decision => ({ allowed: v.allowed, reason: v.reason ?? "", needs: "" });

/* ---------- the agent layer of the preview (legacy effectiveText, layer 3) ---------- */

export function agentLayer(a: { name: string; version: string }, d: Pick<Draft, "instructions" | "guardrails" | "overrides">, project: { id: string; name: string } | null): string {
  let t = `# 3 Agent: ${a.name} ${a.version}\n${d.instructions || "(none)"}`;
  const ov = project ? d.overrides?.[project.id] : undefined;
  if (ov && project) t += `\n\nOn ${project.name}:${ov.model ? ` model ${ov.model}.` : ""}${ov.autonomy ? ` autonomy ${ov.autonomy}.` : ""}${ov.budget ? ` budget $${ov.budget} per work order.` : ""}`;
  if (d.guardrails?.paths.length) t += `\n\nNever modify: ${d.guardrails.paths.join(", ")}.${d.guardrails.maxDiff ? ` Keep diffs under ${d.guardrails.maxDiff} lines.` : ""}`;
  return t;
}

/* ---------- audit history of one entity (factory-wide, so no project) ---------- */

export function EntityHistory({ type, id, limit = 40 }: { type: string; id: string; limit?: number }): ReactNode {
  const q = useAudit({ category: "agents", limit: 200 });
  const raw = q.data;
  const all: AuditEntry[] = Array.isArray(raw) ? raw : ((raw as { items?: AuditEntry[] } | undefined)?.items ?? []);
  const list = all.filter((e) => e.entity && e.entity.type === type && e.entity.id === id).slice(0, limit);
  if (!list.length) return <Empty title="No history yet" text="Changes to this item are written to the audit ledger and appear here." />;
  return (
    <ol className="history">
      {list.map((e) => (
        <li key={e.id}>
          <span className="mono muted">{fmt.iso(e.at)}</span>
          <Who id={e.actor} />
          <span className="mono">{e.action}</span>
          <span>{e.target}</span>
          {e.before != null || e.after != null ? (
            <span className="diff-ba mono small">
              <del>{String(e.before)}</del>{" → "}<ins>{String(e.after)}</ins>
            </span>
          ) : null}
          <span className={`outcome o-${e.outcome}`}>{e.outcome}</span>
        </li>
      ))}
    </ol>
  );
}
