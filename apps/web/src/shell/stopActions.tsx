/** Halt, resume, kill and restore from the palette, Home and Project config: they open the shared dialogs of StopDialogs. */
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import type { UIApi } from "../ui/overlay-context";
import { Suspense } from "react";
import { lazyRetry } from "../lib/errors/lazyRetry";

// The dialogs load when first opened: they are not needed for the first paint.
const HaltDialog = lazyRetry(() => import("./StopDialogs").then((m) => ({ default: m.HaltDialog })));
const KillDialog = lazyRetry(() => import("./StopDialogs").then((m) => ({ default: m.KillDialog })));
const RestoreDialog = lazyRetry(() => import("./StopDialogs").then((m) => ({ default: m.RestoreDialog })));

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
    halt: (projectId) => void ui.open((close) => <Suspense fallback={null}><HaltDialog scope="project" id={projectId} projectId={projectId} onClose={close} /></Suspense>),
    resume: async (projectId) => { const r = await ops.resumeProject(projectId); if (r.ok) ui.toast(`Done: resume. ${r.msg}`, "ok"); else done(r); },
    haltRepo: (repoId, projectId) => void ui.open((close) => <Suspense fallback={null}><HaltDialog scope="repo" id={repoId} projectId={projectId} onClose={close} /></Suspense>),
    resumeRepo: async (repoId) => done(await ops.resumeRepo(repoId)),
    kill: (scope, id) => void ui.open((close) => <Suspense fallback={null}><KillDialog scope={scope} id={id} onClose={close} /></Suspense>),
    restore: (scope, id) => void ui.open((close) => <Suspense fallback={null}><RestoreDialog scope={scope} id={id} onClose={close} /></Suspense>),
  };
}
