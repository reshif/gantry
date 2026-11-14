/** Project config: Overview and Members & roles tabs (legacy project-config.js overview, membersTab). */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useRepos } from "../../api/queries";
import { navigate } from "../../lib/router";
import { Btn, Chip, Empty, Field, LockNote, Panel, Select, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { MiniBelt, metricsOf, projectRoles, roleName, useRes, useTeams } from "../projects/kit";
import { useSaveFromProject } from "../projects/templates";
import { useTemplates } from "../../api/queries";
import { membersOf, rolesIn, type PcProps } from "./ctx";
import { nextVersion } from "../govern/data";

export function OverviewTab({ p, cat, people, s, set }: PcProps) {
  const res = useRes();
  const actor = useActors();
  const d = useCan("project.config", { project: p.id });
  const td = useCan("template.edit");
  const teams = useTeams();
  const tpls = useTemplates().data ?? [];
  const repos = useRepos(p.id).data ?? [];
  const saveAs = useSaveFromProject();
  const locked = !d.allowed;
  const desc = s.text.desc ?? p.desc ?? "";
  const overlay = s.text.overlay ?? p.overlay ?? "";
  const dirty = desc !== (p.desc ?? "") || overlay !== (p.overlay ?? "");
  const owners = people.filter((x) => x.status === "active");
  const tpl = tpls.find((t) => t.id === p.template);
  const m = metricsOf(p);
  const customSt = cat.stations.filter((x) => x.custom && p.flow.order.includes(x.id));
  const customG = cat.gates.filter((x) => x.custom && p.flow.gates[x.id] && !p.flow.gates[x.id]!.absent);
  const customB = cat.bays.filter((x) => x.custom && p.flow.bays.includes(x.id));
  const customC = p.flow.classes.filter((x) => x.custom);
  const custom = [...customSt.map((x) => `station ${x.name}`), ...customG.map((x) => `gate ${x.label} ${x.name}`), ...customB.map((x) => `bay ${x.name}`), ...customC.map((x) => `class ${x.name}`)];
  const ui = useUI();
  const stations = p.flow.order.length;
  const gates = cat.gates.filter((g) => p.flow.gates[g.id] && !p.flow.gates[g.id]!.absent).length;
  void m;
  return (
    <div className="two-col">
      <Panel title="About this project">
        <div className="form-grid">
          <LockNote decision={d} what="Project details" />
          <Field label="Description" htmlFor="pcf-desc">
            <textarea id="pcf-desc" className="input" rows={2} disabled={locked} value={desc} onChange={(e) => set({ text: { ...s.text, desc: e.target.value } })} />
          </Field>
          <Field label="Instructions overlay" htmlFor="pcf-overlay" hint="Added to every agent's instructions for this project, after the factory base and before per-repo guidelines.">
            <textarea id="pcf-overlay" className="input mono" rows={5} disabled={locked} value={overlay} onChange={(e) => set({ text: { ...s.text, overlay: e.target.value } })} />
          </Field>
          <div className="form-actions">
            <Btn kind="primary" id="pcf-ov-save" guard={d} label="Save details" onClick={async () => {
              if (!dirty) return void ui.toast("No changes to save.", "info");
              let ok = true;
              let ver = p.version;
              if (desc !== (p.desc ?? "")) {
                const x = await ops.setProject(p.id, "desc", desc.trim(), { ifMatch: ver });
                ok = res(x, "Description saved.").ok;
                // the description save bumped the project version; the next save must carry the new one
                if (x.ok) ver = nextVersion(x, ver);
              }
              if (ok && overlay !== (p.overlay ?? "")) res(await ops.setProject(p.id, "overlay", overlay.trim(), { ifMatch: ver }), "Instructions overlay saved.");
              set({ text: {} });
            }} />
            {dirty ? <Btn kind="ghost" id="pcf-ov-discard" label="Discard" onClick={() => set({ text: {} })} /> : null}
          </div>
        </div>
      </Panel>
      <div className="pcf-stack">
        <Panel title="Facts">
          <div className="form-grid">
            <dl className="titleblock pcf-facts">
              <div><dt>Key</dt><dd className="mono">{p.key}</dd></div>
              <div><dt>Status</dt><dd>{p.status}</dd></div>
              <div><dt>Template</dt><dd>{tpl ? tpl.name : p.template}</dd></div>
              <div><dt>Regulated</dt><dd>{p.regulated ? "yes" : "no"}</dd></div>
              <div><dt>Teams</dt><dd>{p.teams.map((t) => teams.find((x) => x.id === t)?.name ?? t).join(", ") || "none"}</dd></div>
              <div><dt>Created</dt><dd>{fmt.istDate(p.created)}</dd></div>
            </dl>
            <Field label="Owner" htmlFor="pcf-owner" hint="The owner is the default fallback approver and gets budget alerts.">
              <Select id="pcf-owner" disabled={locked} options={owners.map((x) => ({ value: x.id, label: `${x.name} · ${x.title}` }))} value={p.owner} onChange={async (v) => res(await ops.setProject(p.id, "owner", v, { ifMatch: p.version }), `Owner is now ${actor(v).name.replace(" (agent)", "")}.`)} />
            </Field>
            <div className="pcf-belt-row"><MiniBelt cat={cat} project={p} counts={metricsOf(p).byPosition} /></div>
            <p className="small" id="pcf-flow-sum">
              {`${stations} stations, ${gates} gates, ${p.flow.bays.length} bays, ${p.flow.classes.length} work classes. `}
              {custom.length ? <span><span className="kv-k">Custom </span>{`${custom.join(", ")}.`}</span> : <span className="muted">No custom entries.</span>}
            </p>
          </div>
        </Panel>
        <Panel title="Repos" tools={<Btn small kind="ghost" id="pcf-to-onb" label="Onboarding" onClick={() => navigate("onboarding")} />}>
          {repos.length ? (
            <ul className="plain-list pcf-repos">
              {repos.map((r) => {
                const st = r.onboarding?.stage ?? "connected";
                return (
                  <li key={r.id}>
                    <span className="mono">{r.name}</span>
                    <span className={`pcf-stage pcf-stage-${st}`}>
                      <Icon name={st === "ready" ? "st-done" : st === "failed" || st === "person" ? "alert" : "rocket"} />
                      {st === "ready" ? "Ready" : st === "person" ? "Needs a person" : st.replace("_", " ")}
                    </span>
                    {r.halted ? <Chip text="halted" cls="chip-block" /> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="No repos yet" text="Connect a repo in Onboarding. It must be Ready before work orders can target it." />
          )}
        </Panel>
        <Panel title="Reuse">
          <div className="form-grid">
            <p className="small muted">Save this project's stations, gates, bays, slots and class routes as a template for new projects, custom entries included.</p>
            <div><Btn icon="copy" id="pcf-save-tpl" guard={td} label="Save as template" onClick={() => saveAs(p)} /></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

export function MembersTab({ p, cat, people, s, set }: PcProps) {
  const res = useRes();
  const ui = useUI();
  const d = useCan("project.members", { project: p.id });
  const mem = membersOf(people, p);
  const factory = people.filter((x) => x.roles.some((g) => g.scope === "factory"));
  const eligible = people.filter((x) => x.status === "active" && !x.roles.some((g) => g.scope === "factory"));
  const person = s.add.person || eligible[0]?.id || "";
  const [now] = useState(() => Date.now());
  const pRoles = projectRoles(cat);
  const actor = useActors();
  return (
    <div className="pcf-stack">
      <Panel title={`Members of ${p.name}`} flush>
        <div>
          <LockNote decision={d} what="Project membership" />
          <p className="small muted pcf-pad">{`Roles here apply only to ${p.name}. The same person can hold different roles in other projects.`}</p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Person</th><th>{`Roles on ${p.name}`}</th><th>Elsewhere</th><th>Status</th></tr></thead>
              <tbody>
                {mem.map((x) => {
                  const here = x.roles.filter((g) => g.scope === p.id);
                  const elsewhere = x.roles.filter((g) => g.scope !== p.id && g.scope !== "factory");
                  return (
                    <tr key={x.id}>
                      <td><Who id={x.id} /><div className="muted small">{x.title}</div></td>
                      <td>
                        <div className="pcf-role-chips">
                          {here.map((g) => (
                            <span key={g.role} className="pcf-role">
                              {roleName(cat, g.role)}
                              <Btn small kind="ghost" icon="x" cls="pcf-role-x" id={`pcf-rm-${x.id}-${g.role}`} aria={`Remove ${roleName(cat, g.role)} from ${x.name}`} guard={d} onClick={async () => res(await ops.setMemberRole(x.id, p.id, g.role, false))} />
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="small">{elsewhere.length ? elsewhere.map((g) => <div key={g.role + g.scope}>{`${roleName(cat, g.role)} on ${g.scope}`}</div>) : <span className="muted">only here</span>}</td>
                      <td className="small">
                        {x.oncall ? <span className="chip chip-accent">on call</span> : null}
                        {x.away && x.away.to > now ? <span className="chip chip-warn">{`away, delegate ${actor(x.away.delegate).name}`}</span> : null}
                        {x.status !== "active" ? <Chip text="invited" /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
      <Panel title="Grant a role">
        <div className="inline-form pcf-add">
          <Field label="Person" htmlFor="pcf-add-person"><Select id="pcf-add-person" disabled={!d.allowed} options={eligible.map((x) => ({ value: x.id, label: x.name }))} value={person} onChange={(v) => set({ add: { ...s.add, person: v } })} /></Field>
          <Field label={`Role on ${p.name}`} htmlFor="pcf-add-role"><Select id="pcf-add-role" disabled={!d.allowed} options={pRoles.map((r) => ({ value: r.id, label: r.name }))} value={s.add.role} onChange={(v) => set({ add: { ...s.add, role: v } })} /></Field>
          <Btn kind="primary" icon="plus" id="pcf-add-go" guard={d} label="Grant role" onClick={async () => {
            const x = people.find((y) => y.id === person);
            if (x && rolesIn(x, p.id).includes(s.add.role)) return void ui.toast(`${x.name} already holds ${roleName(cat, s.add.role)} on ${p.name}.`, "warn");
            res(await ops.setMemberRole(person, p.id, s.add.role, true));
          }} />
        </div>
      </Panel>
      <Panel title="Factory-wide roles">
        <ul className="plain-list">
          {factory.map((x) => (
            <li key={x.id}>
              <Who id={x.id} />
              <span className="muted small">{` · ${x.roles.filter((g) => g.scope === "factory").map((g) => roleName(cat, g.role)).join(", ")} (all projects, managed in People)`}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
