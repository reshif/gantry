/** The Blueprint's five onboarding stages mapped from the real seven (connected, assessed, PR opened, PR checks, merged, verified, ready). */
import { isStopped, needsMerge, stageIndex, type RepoV } from "./kit";

export const PSTAGES = ["Connect", "Assess", "Pull request", "Merge", "Ready"] as const;

/** 0 Connect, 1 Assess, 2 Pull request, 3 Merge, 4 Ready. A stopped repo stays where it stopped. */
export function protoStage(r: RepoV): number {
  if (r.onboarding.stage === "ready") return 4;
  const i = stageIndex(r);
  if (i <= 1) return i;
  if (i === 2) return 2;
  if (i === 3) return needsMerge(r) ? 3 : 2;
  return i >= 6 ? 4 : 3;
}
export const stoppedLabel = (r: RepoV): string | null => (isStopped(r) ? (r.onboarding.stage === "person" ? "Needs a person" : "Failed") : null);

/** A repo the GitHub App can see that is not connected yet is "Connect": the Blueprint's stage 0. */
export interface OnbRow {
  id: string;
  name: string;
  lang: string;
  stage: number;
  gaps: number | null;
  repo: RepoV | null;
}
