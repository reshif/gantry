/**
 * The onboarding session (spec 11.3): one conversation per repository for the whole lifecycle. Pure helpers the API and the web share: the lifecycle stepper,
 * the single "Next: <actor> — <what>" line, and the shape of the cards an agent or rule-based message carries.
 */
import type { RepoOnboarding } from "./types.js";

export const LIFECYCLE = ["Connected", "Assessed", "PR opened", "Checks", "Merged", "Verified", "Ready"] as const;
export type LifecycleStep = (typeof LIFECYCLE)[number];
export interface StepState { name: LifecycleStep; state: "done" | "current" | "todo" }

/** The stepper for a repo's onboarding document. A stage off the happy path (person, failed) keeps the step it stopped at as current. */
export function lifecycle(doc: Pick<RepoOnboarding, "stage" | "pr" | "findings" | "verification" | "exception">): StepState[] {
  const at = (() => {
    switch (doc.stage) {
      case "connected": return 0;
      case "assessed": return 1;
      case "pr_opened": return 2;
      case "pr_checks": return 3;
      case "pr_merged": return 4;
      case "verified": return 5;
      case "ready": return 7;
      default: return doc.pr ? (doc.pr.state === "merged" ? 4 : doc.pr.checks === "pending" ? 2 : 3) : doc.findings.length ? 1 : 0;
    }
  })();
  return LIFECYCLE.map((name, i) => ({ name, state: i < at ? "done" : i === at ? "current" : "todo" }));
}

export type Actor = "agent" | "you" | "gantry" | "github" | "reviewer" | "nobody";
export interface Next { actor: Actor; text: string }

/** The one line that says who acts next. `agent` is true when the Onboarding Agent can take turns (a usable model); `canMerge` whether the viewer may approve a merge. */
export function nextStep(doc: Pick<RepoOnboarding, "stage" | "pr" | "findings" | "busy" | "blocker" | "exception">, o: { agent: boolean; pendingProposal: boolean | "merge"; canMerge: boolean }): Next {
  const who: Actor = o.agent ? "agent" : "gantry";
  if (doc.busy === "assessing") return { actor: "gantry", text: "reading the repository and assessing it" };
  if (doc.busy === "opening_pr" || doc.busy === "updating_pr") return { actor: "gantry", text: "writing the approved files to a branch and opening the pull request" };
  if (doc.busy === "merging") return { actor: "github", text: "applying its own rules to the merge" };
  if (doc.busy === "verifying") return { actor: "gantry", text: "running the live readiness checks" };
  if (o.pendingProposal === "merge" && !o.canMerge) return { actor: "reviewer", text: "a person with the right to merge onboarding pull requests approves the proposed merge, or merges it on GitHub" };
  if (o.pendingProposal) return { actor: "you", text: "review the proposed changes and approve, ask for changes or discard" };
  switch (doc.stage) {
    case "connected": return { actor: "gantry", text: "assessing the repository" };
    case "assessed": return doc.findings.some((f) => !f.ok && f.fix) ? { actor: who, text: "propose the onboarding pull request for you to approve" } : { actor: "you", text: "ask for a verification: nothing is left for a pull request to add" };
    case "pr_opened": return { actor: "github", text: "running the checks on the pull request (Gantry posts here and notifies you when they finish)" };
    case "pr_checks":
      if (doc.pr?.checks === "red") return { actor: who, text: "explain the failing check and propose a fix for you to approve" };
      if (doc.pr?.checks === "none") return o.canMerge ? { actor: "you", text: "approve and merge the pull request (no CI reported: the repo will not reach Ready until CI exists)" } : { actor: "reviewer", text: "a person with the right to merge approves it; no CI reported, so Ready needs CI first" };
      return o.canMerge ? { actor: "you", text: "approve and merge the pull request" } : { actor: "reviewer", text: "a person with the right to merge onboarding pull requests approves it" };
    case "pr_merged": return { actor: "gantry", text: "verifying the repository live" };
    case "ready": return { actor: "nobody", text: "nothing: the repository is Ready for work orders" };
    case "failed": case "person": return { actor: "you", text: doc.blocker ? `resolve: ${doc.blocker}`.slice(0, 160) : "look at what stopped onboarding" };
    default: return { actor: "gantry", text: "continuing" };
  }
}

/** A file in a proposal: what it is, why, how big, and the added lines for the diff view. */
export interface ProposalFile { path: string; mode: "create" | "update"; finding: string; plus: number; minus: number; source: "observed" | "agent"; added: string[] }

/** A card on an assistant message. Cards are data the page renders; nothing in them runs. */
export type SessionCard =
  | { kind: "progress"; text: string; detail?: string }
  | { kind: "question"; id: string; question: string; options: string[]; answered?: string }
  | {
      kind: "proposal"; id: string; what: "open_pr" | "update_pr" | "merge"; title: string; summary: string; mode: "agent" | "rule-based";
      files: ProposalFile[]; runId: string; headSha?: string; prNumber?: number; status: "pending" | "approved" | "changes" | "discarded" | "superseded" | "failed"; decidedBy?: string; note?: string;
    };

export const SESSION_BUDGET_DEFAULT_USD = 1;
