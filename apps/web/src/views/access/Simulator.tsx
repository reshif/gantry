import { useState } from "react";
import type { Person, Project, Repo, Action } from "@gantry/domain";
import { Btn, Field, Panel, Select } from "../../ui/primitives";
import { useQS } from "../govern/kit";

export interface Sim {
  person: string;
  action: string;
  project: string;
  repo: string;
  date: string;
  time: string;
}

export const nowIst = () => {
  const d = new Date(Date.now() + 330 * 60000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};

interface Verdict { ok: boolean; text: string }

/** The prototype's check, evaluated here from the role matrix and the person's roles: no server round-trip, always a callout. */
export function evaluate(p: Person, action: string, project: string, projectName: string, matrix: Record<string, Record<string, boolean>>): Verdict {
  const ok = p.status === "active" && p.roles.some((x) => (x.scope === "factory" || x.scope === project) && !!matrix[x.role]?.[action]);
  if (ok) return { ok, text: `${p.name} holds a role that grants ${action}.` };
  if (p.status !== "active") return { ok, text: `${p.name} is ${p.status}.` };
  return { ok, text: `None of ${p.name}'s roles grant ${action} in ${projectName}.` };
}

export function Simulator({ people, projects, actions, matrix, defaults }: { people: Person[]; projects: Project[]; repos?: Repo[]; actions: Action[]; matrix: Record<string, Record<string, boolean>>; defaults: Sim }) {
  const [person, setPerson] = useQS("acc.person", defaults.person);
  const [action, setAction] = useQS("acc.action", defaults.action);
  const [project, setProject] = useQS("acc.project", defaults.project);
  const [out, setOut] = useState<Verdict | null>(null);

  const check = () => {
    const p = people.find((x) => x.id === person);
    if (!p) return;
    setOut(evaluate(p, action, project, projects.find((x) => x.id === project)?.name ?? project, matrix));
  };

  return (
    <Panel title="Can this person do this?">
      <form id="acc-sim-form" onSubmit={(e) => { e.preventDefault(); check(); }}>
        <div className="cols w3">
          <Field label="Person" htmlFor="acc-sim-person"><Select id="acc-sim-person" value={person} onChange={setPerson} options={people.map((p) => ({ value: p.id, label: p.name }))} /></Field>
          <Field label="Action" htmlFor="acc-sim-action"><Select id="acc-sim-action" value={action} onChange={setAction} options={actions.map((a) => ({ value: a.id, label: a.name }))} /></Field>
          <Field label="Project" htmlFor="acc-sim-project"><Select id="acc-sim-project" value={project} onChange={setProject} options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Field>
        </div>
        <Btn label="Check" kind="primary" type="submit" id="acc-sim-run" />
      </form>
      <div style={{ marginTop: 12 }} aria-live="polite">
        {out ? (
          <div id="acc-sim-result" className={`callout ${out.ok ? "ok" : "bad"}`}>
            <b>{out.ok ? "Allowed" : "Denied"}</b>
            {out.text}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
