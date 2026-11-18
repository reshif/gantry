/**
 * New project, the prototype's small dialog: Name, Key (three capitals), Owner, Template. The server fills in approvers, notifications and the
 * flow from the template; "More options" opens the full wizard (owning teams, budget, repos, approver and notification presets).
 * After the create it toasts "Created <name>" and opens the new project's configuration.
 */
import { useState } from "react";
import { getQueryClient, qk } from "../../api/keys";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useMe, usePeople, useTemplates } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Field, Select } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { goProject, type PView } from "./kit";

const idFor = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function NewProjectDialog({ projects, close, more }: { projects: PView[]; close: () => void; more: () => void }) {
  const ui = useUI();
  const me = useMe();
  const people = usePeople().data ?? [];
  const tpls = useTemplates().data ?? [];
  const d = useCan("project.create");
  const active = people.filter((x) => x.status === "active");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [owner, setOwner] = useState(me?.person.id ?? "");
  const [tpl, setTpl] = useState("");
  const [err, setErr] = useState<{ name?: string; key?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const tplId = tpl || tpls[0]?.id || "";

  const submit = async () => {
    if (busy) return;
    const e: typeof err = {};
    if (!name.trim()) e.name = "Name is required.";
    else if (name.trim().length < 3) e.name = "Name needs at least 3 characters.";
    else if (projects.some((p) => p.id === idFor(name))) e.name = `A project called ${name.trim()} already exists.`;
    if (!key) e.key = "Key is required.";
    else if (!/^[A-Z]{3}$/.test(key)) e.key = "Exactly three capital letters.";
    setErr(e);
    if (e.name || e.key) return;
    setBusy(true);
    const person = people.find((x) => x.id === owner);
    const r = await ops.createProject({ name: name.trim(), key, templateId: tplId, owner, teams: person?.teams ?? [], desc: null, budget: 1000 });
    setBusy(false);
    if (!r.ok) return setErr({ form: r.msg });
    const project = (r as unknown as { project: { id: string } }).project;
    ui.toast(`Created ${name.trim()}`, "ok");
    close();
    // the shell keeps the stored project to one in `me`: wait until `me` lists the new project before opening it
    await getQueryClient()?.refetchQueries({ queryKey: qk.me() });
    goProject(project.id, "project-config");
  };

  return (
    <Dialog
      title="New project"
      sub="A project groups repos, people and a line configuration."
      dirty={!!(name || key)}
      onClose={close}
      body={
        <div className="form-grid">
          <Field label="Name" htmlFor="prj-nd-name" required error={err.name}>
            <input id="prj-nd-name" className="input" value={name} placeholder="e.g. Loyalty" autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Key" htmlFor="prj-nd-key" required error={err.key}>
            <input id="prj-nd-key" className="input mono" value={key} maxLength={3} placeholder="LOY" autoComplete="off" onChange={(e) => setKey(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Owner" htmlFor="prj-nd-owner">
            <Select id="prj-nd-owner" options={active.map((x) => ({ value: x.id, label: x.name }))} value={owner} onChange={setOwner} />
          </Field>
          <Field label="Template" htmlFor="prj-nd-tpl">
            <Select id="prj-nd-tpl" options={tpls.map((t) => ({ value: t.id, label: t.name }))} value={tplId} onChange={setTpl} />
          </Field>
          {err.form ? <div className="form-err" role="alert">{err.form}</div> : null}
        </div>
      }
      actions={[
        { label: "Cancel", id: "prj-nd-cancel" },
        { label: "More options", id: "prj-nd-more", onClick: (ask) => { ask(); more(); } },
        { label: busy ? "Creating…" : "Create project", kind: "primary", submit: true, id: "prj-nd-create", guard: d.pending ? null : d, onClick: () => void submit() },
      ]}
    />
  );
}
