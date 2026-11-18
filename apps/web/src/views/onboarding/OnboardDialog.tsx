/** "Onboard a repository": pick a repository that is waiting and the project it joins; the assessment starts at once. */
import { useMemo } from "react";
import type { Project } from "@gantry/domain";
import { commands } from "../../api/commands";
import { useUI } from "../../ui/overlay-context";
import { useCommand } from "../../lib/useCommand";
import { navigate } from "../../lib/router";
import { FormDialog } from "../projects/formdialog";
import type { OnbRow } from "./proto";

export function OnboardDialog({ rows, projects, project, pick, close }: { rows: OnbRow[]; projects: Project[]; project: Project; pick?: OnbRow | undefined; close: () => void }) {
  const ui = useUI();
  const connect = useCommand(commands.connectRepo, { ok: false, toastFail: false });
  const assess = useCommand(commands.rerunAssessment, { ok: false, toastFail: false });
  const waiting = rows.filter((r) => r.stage === 0);
  const values = useMemo(() => ({ repo: pick?.id ?? waiting[0]?.id ?? "", project: project.id }), [pick?.id, waiting[0]?.id, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog
      title={`Onboard ${pick ? pick.name : "a repository"}`} submit="Start assessment" values={values} close={close}
      intro="The Onboarding agent reads the repository (read-only) and lists what blocks agents from working on it."
      fields={[
        { k: "repo", label: "Repository", type: "select", req: true, opts: waiting.map((r) => [r.id, r.name]), validate: (v) => (!v ? "No repositories are waiting. Connect a source in Integrations." : "") },
        { k: "project", label: "Project", type: "select", opts: projects.map((p) => [p.id, p.name]) },
      ]}
      onSubmit={async (v) => {
        const row = waiting.find((r) => r.id === v.repo);
        if (!row) return "That repository is not waiting.";
        const target = projects.find((p) => p.id === v.project) ?? project;
        if (row.repo) {
          const r = await assess.run(row.repo.id);
          if (!r?.ok) return r?.msg ?? "That did not work.";
          ui.toast("Assessment started", "ok");
          navigate("onboarding", row.repo.id, target.id);
          return undefined;
        }
        const r = await connect.run(target.id, row.name, target.teams[0] ?? null);
        if (!r?.ok) return r?.msg ?? "That did not work.";
        ui.toast("Assessment started", "ok");
        const repo = "repo" in r ? (r as { repo?: { id: string } }).repo : undefined;
        if (repo) navigate("onboarding", repo.id, target.id);
        return undefined;
      }}
    />
  );
}
