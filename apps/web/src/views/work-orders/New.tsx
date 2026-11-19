/**
 * The New work order dialog (legacy traveler.js newWODialog) and the reason a submit is blocked (legacy submitGuard).
 * The submit button is guarded by the server's decision for this person and by the stop and onboarding state; one click makes one
 * work order (the request carries an Idempotency-Key that is kept for retries of the same dialog).
 */
import { Suspense, lazy, useEffect, useRef } from "react";
import { ONBOARD_STAGES, type Project, type Repo } from "@gantry/domain";
import type { Me } from "../../api/types";
import { useMe } from "../../api/queries";
import { useUI } from "../../ui/overlay-context";
import { registerCommand } from "../../lib/commands";

// The dialog (and the classification card it opens) load when first opened, not with the shell.
const NewWorkOrderDialog = lazy(() => import("./NewDialog").then((m) => ({ default: m.NewWorkOrderDialog })));

const STAGE_NAMES: Record<string, string> = { ...Object.fromEntries(ONBOARD_STAGES.map((s) => [s.id, s.name])), failed: "Failed", person: "Needs a person" };
export const ready = (r: Repo): boolean => r.onboarding.stage === "ready" || !!r.onboarding.exception;

/** Why submissions are refused for a project (and repo), or null. Mirrors the server's own checks, which decide in the end. */
export function submitBlock(me: Me, project: Pick<Project, "id" | "name" | "status" | "killed">, repos: Repo[], repoId: string | null): { reason: string; onboarding: boolean } | null {
  const f = me.factory.killed;
  if (f) return { reason: `Submissions are refused. The factory is killed: ${f.reason}.`, onboarding: false };
  if (project.killed) return { reason: `Submissions are refused. ${project.name} is killed: ${project.killed.reason}.`, onboarding: false };
  if (project.status === "archived") return { reason: `Submissions are refused. ${project.name} is archived.`, onboarding: false };
  if (!repoId) return repos.length ? { reason: `Pick a repo in ${project.name}.`, onboarding: false } : { reason: `No repos in ${project.name} yet. Connect one and finish onboarding first.`, onboarding: true };
  const r = repos.find((x) => x.id === repoId);
  if (!r) return { reason: `Pick a repo in ${project.name}.`, onboarding: false };
  if (!ready(r)) return { reason: `${r.name} is not ready: onboarding is at '${STAGE_NAMES[r.onboarding.stage] ?? r.onboarding.stage}'. Finish onboarding first.`, onboarding: true };
  return null;
}

/** Whether any repo of the project can take work now: the reason the New work order button is locked, or null. */
export function projectSubmitBlock(me: Me, project: Pick<Project, "id" | "name" | "status" | "killed">, repos: Repo[]): string | null {
  const stop = submitBlock(me, project, repos, repos.find(ready)?.id ?? null);
  if (!stop) return null;
  if (!stop.onboarding) return stop.reason.replace(/^Submissions are refused\. /, "");
  return `No repo in ${project.name} is Ready yet. Finish onboarding first`;
}

export interface NewWoPreset {
  project?: string;
  repo?: string;
  title?: string;
  description?: string;
  source?: string;
}

/** Opens the New work order dialog. */
export function useNewWorkOrder(): (preset?: NewWoPreset) => void {
  const ui = useUI();
  const me = useMe();
  return (preset = {}) => {
    if (!me?.projects.some((p) => p.status !== "archived")) {
      ui.toast("You have no projects to submit work to.", "warn");
      return;
    }
    ui.open((close) => <Suspense fallback={null}><NewWorkOrderDialog preset={preset} onClose={close} /></Suspense>);
  };
}

/** Makes "Submit a work order" available in the palette and on Home: registered once for the signed-in shell. */
export function useRegisterNewWorkOrder(): void {
  const open = useNewWorkOrder();
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => registerCommand("newWorkOrder", () => ref.current()), []);
}
