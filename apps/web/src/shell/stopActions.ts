/** Halt, resume, kill and restore from the palette, built on the shared dialog primitives and ops. */
import { ops, type StopScope } from "../api/ops";
import type { Me } from "../api/types";
import type { UIApi } from "../ui/overlay-context";

export interface StopActions {
  halt(projectId: string): void;
  resume(projectId: string): Promise<void>;
  kill(scope: "factory" | "project", projectId: string | null): void;
  restore(scope: "factory" | "project", projectId: string | null): void;
}

export function makeStopActions(ui: UIApi, me: Me): StopActions {
  const name = (id: string | null) => me.projects.find((p) => p.id === id)?.name ?? id ?? "";
  return {
    halt: (projectId) =>
      ui.reasonDialog({
        title: `Halt ${name(projectId)}`,
        kicker: "Andon",
        sub: "New work stops entering stations; running agents finish their step. Resume when it is safe.",
        ok: "Halt project",
        kind: "danger",
        onOk: async (reason) => {
          const r = await ops.haltProject(projectId, reason);
          ui.toast(r.msg, r.ok ? "ok" : "error");
          return r.ok ? undefined : { ok: false, msg: r.msg };
        },
      }),
    resume: async (projectId) => {
      const r = await ops.resumeProject(projectId);
      ui.toast(r.msg, r.ok ? "ok" : "error");
    },
    kill: (scope, projectId) => {
      const label = scope === "factory" ? "the whole factory" : name(projectId);
      const phrase = scope === "factory" ? "KILL FACTORY" : name(projectId);
      ui.reasonDialog({
        title: `Kill ${label}`,
        kicker: `Kill switch · ${scope}`,
        sub: "A kill is a hard stop. Agents stop, coding slots are freed, and new submissions are refused until someone restores it.",
        label: "Reason (required)",
        placeholder: "What is happening? This is posted to the notification routes.",
        ok: "Continue",
        kind: "danger",
        onOk: (reason) => {
          ui.typedConfirm({
            title: `Confirm kill: ${label}`,
            kicker: `Kill switch · ${scope}`,
            phrase,
            okLabel: `Kill ${scope}`,
            onOk: async (typed) => {
              const r = await ops.kill(scope as StopScope, projectId, { reason, mode: "hold", confirmText: typed });
              ui.toast(r.msg, r.ok ? "ok" : "error");
              return r.ok ? undefined : { ok: false, msg: r.msg };
            },
          });
        },
      });
    },
    restore: (scope, projectId) =>
      ui.reasonDialog({
        title: `Restore ${scope === "factory" ? "the factory" : name(projectId)}`,
        kicker: `Restore · ${scope}`,
        sub: "Held work resumes. A factory restore may need a second approver.",
        ok: "Restore",
        onOk: async (reason) => {
          const r = await ops.restore(scope, projectId, reason);
          ui.toast(r.msg, r.ok ? "ok" : "error");
          return r.ok ? undefined : { ok: false, msg: r.msg };
        },
      }),
  };
}
