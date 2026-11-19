/** What is waiting for this person, as one typed list built from `home.sections` (the API decides what each person sees). Home and Inbox both read it, so their counts agree. */
import { useMemo } from "react";
import type { Approval, AttentionItem, Conversation, HomeFull } from "../home/data";

export type Group = "gate" | "onboarding" | "questions" | "stuck" | "other";
export type Item =
  | { kind: "gate"; group: "gate"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "onboarding"; group: "onboarding"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "question"; group: "questions"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "stuck"; group: "stuck"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "other"; group: "other"; key: string; project: string; projectName: string; waitMs: number; x: AttentionItem };

/** Attention items that are decisions for this person, rather than health to look at: a restore, and proposals on the governance pages. */
const DECISION_ROUTES = new Set(["trust", "learning", "mcp", "api", "integrations"]);
export const isDecision = (x: AttentionItem): boolean => !!x.restore || DECISION_ROUTES.has(x.act.route);

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
    return out;
  }, [home, names]);
}

