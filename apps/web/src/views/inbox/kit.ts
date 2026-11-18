/** Shared by the Inbox and Home: the typed list of what waits for a person, and the wording of each row. */
import { useMemo, type ReactNode } from "react";
import { gatePendingTitle } from "@gantry/domain";
import type { Approval, AttentionItem, Conversation, HomeFull } from "../home/data";

export type Item =
  | { kind: "gate"; group: "gate"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "onboarding"; group: "onboarding"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "question"; group: "questions"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "stuck"; group: "stuck"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "other"; group: "other"; key: string; project: string; projectName: string; waitMs: number; x: AttentionItem };

/** Attention items that are decisions for this person, rather than health to look at: a restore, and proposals on the governance pages. */
const DECISION_ROUTES = new Set(["trust", "learning", "mcp", "api", "integrations"]);
const isDecision = (x: AttentionItem): boolean => !!x.restore || DECISION_ROUTES.has(x.act.route);

export function useItems(home: HomeFull | undefined, names: Map<string, string>): Item[] {
  return useMemo(() => {
    const s = home?.sections;
    if (!s) return [];
    const out: Item[] = [];
    const projectNames = new Map(names);
    for (const a of s.waiting?.approvals ?? []) if (a.project && a.projectName) projectNames.set(a.project, a.projectName);
    for (const a of s.waiting?.approvals ?? []) {
      const base = { project: a.project, projectName: a.projectName, waitMs: a.waitMs ?? 0 };
      out.push(a.repo ? { kind: "onboarding", group: "onboarding", key: `onb-${a.repo}-${a.note ? "n" : "m"}`, ...base, a } : { kind: "gate", group: "gate", key: `gate-${a.wo}-${a.gate}`, ...base, a });
    }
    for (const c of s.waiting?.conversations ?? []) {
      const projectName = projectNames.get(c.project) ?? "";
      // The brief gate is a gate decision whatever line the conversation last said (the classifier's line is not a question): it is listed with the gate approvals.
      if (c.gate) {
        if (out.some((i) => i.kind === "gate" && i.a.wo === c.wo && i.a.gate === c.gate!.id)) continue;
        const a: Approval = { wo: c.wo, title: c.title, gate: c.gate.id, gateLabel: c.gate.label, gateName: c.gate.name, project: c.project, projectName };
        out.push({ kind: "gate", group: "gate", key: `gate-${c.wo}-${c.gate.id}`, project: c.project, projectName, waitMs: 0, a });
        continue;
      }
      if (c.stuck) { out.push({ kind: "stuck", group: "stuck", key: `stuck-${c.wo}`, project: c.project, projectName, waitMs: 0, c }); continue; }
      out.push({ kind: "question", group: "questions", key: `q-${c.wo}`, project: c.project, projectName, waitMs: 0, c });
    }
    for (const x of s.attention ?? []) if (isDecision(x)) out.push({ kind: "other", group: "other", key: x.id, project: x.act.project ?? "factory", projectName: x.where, waitMs: 0, x });
    return out.sort((p, q) => q.waitMs - p.waitMs);
  }, [home, names]);
}


/** A gate approval as an item (Home lists them without going through the inbox merge). */
export const gateItem = (a: Approval): Extract<Item, { kind: "gate" }> => ({ kind: "gate", group: "gate", key: `gate-${a.wo}-${a.gate}`, project: a.project, projectName: a.projectName, waitMs: a.waitMs ?? 0, a });

/** The inbox type of an item: the prototype's Gate, Trust, Learning, MCP, Trigger, Onboarding (a restore keeps its own name). */
export function typeOf(it: Item): string {
  if (it.kind === "gate") return "gate";
  if (it.kind === "onboarding") return "onboarding";
  if (it.kind === "other") {
    if (it.x.restore) return "restore";
    const r = it.x.act.route;
    return r === "trust" ? "trust" : r === "learning" ? "learning" : r === "mcp" ? "mcp" : "trigger";
  }
  return "question";
}
export const TYPE_LABEL: Record<string, string> = { gate: "Gate", trust: "Trust", learning: "Learning", mcp: "MCP", trigger: "Trigger", onboarding: "Onboarding", restore: "Restore" };

export const titleOf = (it: Item): { title: ReactNode; sub: ReactNode; type: string; tone: string } => {
  const type = TYPE_LABEL[typeOf(it)] ?? "";
  if (it.kind === "gate") {
    const a = it.a;
    return { title: `${gatePendingTitle({ id: a.gate ?? "", name: a.gateName ?? "gate", label: a.gateLabel ?? a.gate ?? "" })} for ${a.wo}`, sub: `${a.wo} · ${a.title ?? ""}`, type, tone: "warn" };
  }
  if (it.kind === "onboarding") {
    const a = it.a;
    return { title: a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding pull request ${a.repoName}#${a.pr}`, sub: a.note ?? "Checks are green. Sensitive files need an explicit tick in the session.", type, tone: "agent" };
  }
  if (it.kind === "other") return { title: it.x.title, sub: it.x.sub, type, tone: "agent" };
  return { title: "", sub: "", type: "", tone: "idle" };
};

/** The prototype's "ago": one unit, rounded (just now, 14m ago, 6h ago, 3d ago). `ms` is how long ago it was. */
export function agoShort(ms: number): string {
  const sec = Math.max(0, ms / 1000);
  if (sec < 60) return "just now";
  const m = sec / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}
