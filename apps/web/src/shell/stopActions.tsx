/** Halt, resume, kill and restore from the palette, Home and Project config: they open the shared dialogs of StopDialogs. */
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import type { UIApi } from "../ui/overlay-context";
import { HaltDialog, KillDialog, RestoreDialog } from "./StopDialogs";

export interface StopActions {
  halt(projectId: string): void;
  resume(projectId: string): Promise<void>;
  haltRepo(repoId: string, projectId: string): void;
  resumeRepo(repoId: string): Promise<void>;
  kill(scope: "factory" | "project" | "workorder", id: string | null): void;
  restore(scope: "factory" | "project" | "workorder", id: string | null): void;
}

export function makeStopActions(ui: UIApi, _me: Me): StopActions {
  const done = (r: { ok: boolean; msg: string }) => ui.toast(r.msg, r.ok ? "ok" : "error");
  return {
    halt: (projectId) => void ui.open((close) => <HaltDialog scope="project" id={projectId} projectId={projectId} onClose={close} />),
    resume: async (projectId) => done(await ops.resumeProject(projectId)),
    haltRepo: (repoId, projectId) => void ui.open((close) => <HaltDialog scope="repo" id={repoId} projectId={projectId} onClose={close} />),
    resumeRepo: async (repoId) => done(await ops.resumeRepo(repoId)),
    kill: (scope, id) => void ui.open((close) => <KillDialog scope={scope} id={id} onClose={close} />),
    restore: (scope, id) => void ui.open((close) => <RestoreDialog scope={scope} id={id} onClose={close} />),
  };
}
