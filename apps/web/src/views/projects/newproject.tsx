/** New project, as the Blueprint draws it: one dialog with five fields. The template carries the flow, gates, approvers and notification routes. */
import { useMemo } from "react";
import { useCommand } from "../../lib/useCommand";
import { useUI } from "../../ui/overlay-context";
import { commands } from "../../api/commands";
import { useMe, usePeople, useTemplates } from "../../api/queries";
import { getQueryClient, qk } from "../../api/keys";
import { FormDialog } from "./formdialog";
import type { PView } from "./kit";

export function NewProjectDialog({ projects, tplId, close }: { projects: PView[]; tplId?: string | undefined; close: () => void }) {
  const me = useMe();
  const tpls = useTemplates().data;
  const people = usePeople().data?.filter((p) => p.status === "active");
  const ui = useUI();
  const create = useCommand(commands.createProject, { ok: false, toastFail: false });
  const first = tpls?.find((t) => t.id === tplId)?.id ?? tpls?.[0]?.id ?? "";
  const values = useMemo(() => ({ name: "", key: "", desc: "", budget: "", template: first, owner: me?.person.id ?? "" }), [first, me?.person.id]);
  return (
    <FormDialog
      title="New project" submit="Create project" values={values} close={close}
      fields={[
        { k: "name", label: "Name", req: true, minLen: 3 },
        { k: "key", label: "Key (3 letters)", req: true, validate: (v) => (!/^[A-Z]{3}$/.test(String(v ?? "")) ? "Use exactly three capital letters." : projects.some((p) => p.key === v) ? "That key is taken." : "") },
        { k: "desc", label: "What does it build?" },
        { k: "budget", label: "Monthly budget (USD)", type: "number", min: 0, hint: "Leave empty or 0 for no cap." },
        { k: "template", label: "Template", type: "select", opts: (tpls ?? []).map((t) => [t.id, t.name]), hint: "Sets the flow, gates and approvers to start from." },
        { k: "owner", label: "Owner", type: "select", opts: (people ?? []).map((p) => [p.id, p.name]) },
      ]}
      onSubmit={async (v) => {
        const name = String(v.name).trim();
        const r = await create.run({ name, key: v.key, templateId: v.template, owner: v.owner, teams: [], desc: String(v.desc ?? "").trim() || null, budget: v.budget === "" || v.budget == null ? null : Number(v.budget) });
        if (!r || !r.ok) return r?.msg ?? "That did not work.";
        ui.toast(`${name} created`, "ok");
        void getQueryClient()?.refetchQueries({ queryKey: qk.me() });
        return undefined;
      }}
    />
  );
}
