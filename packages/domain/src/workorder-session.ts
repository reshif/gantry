/**
 * The work-order session (spec 8.4, 11.3): one agent conversation per work order, for its whole life. The current station's agent talks; Gantry observes facts and
 * enforces rails; a person approves cards. This file holds the shapes the API and the page share and the pure rails around an agent-authored brief: what the agent may
 * propose is not dictated here, only what a proposal must look like to be shown at all. Nothing in it writes anything.
 */
import type { Brief } from "./types.js";
import { isBriefScaffold } from "./flow.js";

/** The brief fields an agent authors. Route, children and the class stay Gantry's (the class changes only through a reclassify proposal). */
export interface BriefDraft {
  goal: string;
  scopeIn: string[];
  scopeOut: string[];
  ac: string[];
  risks: string[];
  open: string[];
  decisions: string[];
  estimate: string;
}

export interface BriefChange { field: keyof BriefDraft; label: string; before: string[]; after: string[]; added: string[]; removed: string[]; /** Open questions the proposal answers (shown as resolved, not as removals). */ resolved?: string[] }

export type WoCard =
  | { kind: "progress"; text: string; detail?: string }
  | { kind: "question"; id: string; question: string; options: string[]; answered?: string }
  | {
      kind: "proposal"; id: string; what: "brief" | "reclassify" | "decline"; title: string; summary: string; mode: "agent" | "rule-based";
      status: "pending" | "approved" | "changes" | "discarded" | "superseded" | "failed"; decidedBy?: string; note?: string;
      /** Brief: what the agent proposes, and what changes against the brief as it stands (the fingerprint of that brief is checked again on approval). */
      brief?: BriefDraft; changes?: BriefChange[]; base?: string;
      /** The class the agent read the request as, with its confidence and why (informational on a brief proposal; the target on a reclassify proposal). */
      cls?: { id: string; name: string; confidence?: number; rationale?: string };
      route?: string[];
      /** Reclassify and decline: the reason that will be audited. */
      reason?: string;
    };

export const BRIEF_LABELS: Record<keyof BriefDraft, string> = { goal: "Goal", scopeIn: "In scope", scopeOut: "Out of scope", ac: "Acceptance criteria", risks: "Risks", open: "Open questions", decisions: "Decisions", estimate: "Estimate" };

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s.trim().slice(0, n) : "");
const list = (v: unknown, max: number, n = 300): string[] => (Array.isArray(v) ? v.map((x) => clip(x, n)).filter(Boolean).slice(0, max) : []);

/** The rails on an agent-authored brief: a real goal, at least one testable acceptance criterion, bounded lists. Returns every reason when refused. */
export function resolveBriefDraft(raw: unknown): { ok: true; draft: BriefDraft } | { ok: false; reasons: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const draft: BriefDraft = {
    goal: clip(r.goal, 600), scopeIn: list(r.scopeIn, 12), scopeOut: list(r.scopeOut, 12), ac: list(r.ac, 12, 400), risks: list(r.risks, 8), open: list(r.open, 6), decisions: list(r.decisions, 8), estimate: clip(r.estimate, 80),
  };
  const reasons: string[] = [];
  if (draft.goal.length < 10) reasons.push("The goal needs at least a full sentence.");
  if (!draft.ac.length) reasons.push("Give at least one acceptance criterion a reviewer could check.");
  if (!draft.scopeIn.length) reasons.push("Say what is in scope.");
  if (/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(JSON.stringify(draft))) reasons.push("The brief appears to contain a credential. Never put secrets in a brief.");
  return reasons.length ? { ok: false, reasons } : { ok: true, draft };
}

const asList = (b: Partial<Brief> | null | undefined, f: keyof BriefDraft): string[] => {
  const v = b?.[f as keyof Brief];
  return Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
};

/** Field by field: what the proposal adds and removes against the brief as it stands. Only fields that differ are listed. */
export function briefDiff(current: Partial<Brief> | null | undefined, next: BriefDraft): BriefChange[] {
  return (Object.keys(BRIEF_LABELS) as Array<keyof BriefDraft>).flatMap((f) => {
    const before = asList(current, f);
    const after = Array.isArray(next[f]) ? (next[f] as string[]) : next[f] ? [next[f] as string] : [];
    const added = after.filter((x) => !before.includes(x));
    const gone = before.filter((x) => !after.includes(x));
    // An open question that disappears was answered, not deleted; a seeded placeholder that disappears was never a person's words.
    const resolved = f === "open" ? gone : [];
    const removed = f === "open" ? [] : gone.filter((x) => !isBriefScaffold(x));
    return added.length || removed.length || resolved.length ? [{ field: f, label: BRIEF_LABELS[f], before, after, added, removed, ...(resolved.length ? { resolved } : {}) }] : [];
  });
}

/** The fingerprint of the brief a proposal was drawn against: approval is refused when the brief moved since. */
export function briefBase(b: Partial<Brief> | null | undefined): string {
  const s = JSON.stringify([b?.goal ?? "", b?.scopeIn ?? [], b?.scopeOut ?? [], b?.ac ?? [], b?.risks ?? [], b?.open ?? [], b?.decisions ?? [], b?.estimate ?? ""]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Merges an approved draft over the brief; route and children stay as the flow computed them. */
export const applyBriefDraft = (current: Partial<Brief> | null | undefined, d: BriefDraft): Brief => ({
  route: [], children: [], ...(current ?? {}), goal: d.goal, scopeIn: d.scopeIn, scopeOut: d.scopeOut, ac: d.ac, risks: d.risks, open: d.open, decisions: d.decisions, estimate: d.estimate,
}) as Brief;

export const WO_AGENT_LABEL = "Rule-based (no agent)";
