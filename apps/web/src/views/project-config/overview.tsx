/** Project config > Overview and Members: details (with the instructions overlay), summary, template, recent changes, notifications; members, roles, factory-wide roles and on call. */
import { useState } from "react";
import { isOnCall } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useMe, useRepos, useTemplates } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn, Chip, Field, Input, LockNote, Panel, Select, TextArea, Who } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { MiniBelt, metricsOf, projectRoles, roleName, useRes, useTeams } from "../projects/kit";
import { useSaveFromProject } from "../projects/templates";
import { Kv, ActBtn } from "../projects/proto";
import { nextVersion } from "../govern/data";
import { membersOf, rolesIn, type PcProps } from "./ctx";
import { HistoryList } from "./history";
import { NotificationsSummary } from "./misc";

/** A repository is part of the project once it is Ready. */
const isLive = (r: { onboarding: { stage: string } }): boolean => r.onboarding.stage === "ready";

export function OverviewProto({ p, cat, people }: PcProps) {
  const ui = useUI();
  const me = useMe();
  const res = useRes();
  const actor = useActors();
  const d = useCan("project.edit", { project: p.id });
  const cfg = useCan("project.config", { project: p.id });
  const td = useCan("template.edit");
  const saveAs = useSaveFromProject();
  const teams = useTeams();
  const tpls = useTemplates().data;
  const repos = useRepos(p.id).data?.filter(isLive);
  const [name, setName] = useState(p.name);
  const [desc, setDesc] = useState(p.desc ?? "");
  const [owner, setOwner] = useState(p.owner);
  const [overlay, setOverlay] = useState(p.overlay ?? "");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const owners = people.filter((x) => x.status === "active");
  const [adv, setAdv] = useState(false);
  const save = async () => {
    const nm = name.trim();
    if (!nm) { setErrs({ name: "Name is required." }); return; }
    if (nm.length < 3) { setErrs({ name: "Name needs at least 3 characters." }); return; }
    setErrs({});
    let ver = p.version;
    let ok = true;
    if (nm !== p.name) { const r = await ops.setProject(p.id, "name", nm, { ifMatch: ver }); if (!r.ok) { setErrs({ name: r.msg }); return; } ver = nextVersion(r, ver); }
    if (desc !== (p.desc ?? "")) { const r = res(await ops.setProject(p.id, "desc", desc.trim(), { ifMatch: ver })); ok = r.ok; if (r.ok) ver = nextVersion(r, ver); }
    if (ok && owner !== p.owner) { const r = res(await ops.setProject(p.id, "owner", owner, { ifMatch: ver })); ok = r.ok; if (r.ok) ver = nextVersion(r, ver); }
    if (ok && overlay !== (p.overlay ?? "")) { const r = res(await ops.setProject(p.id, "overlay", overlay.trim(), { ifMatch: ver })); ok = r.ok; }
    if (ok) ui.toast("Project saved", "ok");
  };
  const custom = [
    ...cat.stations.filter((x) => x.custom && p.flow.order.includes(x.id)).map((x) => `station ${x.name}`),
    ...cat.gates.filter((x) => x.custom && p.flow.gates[x.id] && !p.flow.gates[x.id]!.absent).map((x) => `gate ${x.label} ${x.name}`),
    ...cat.bays.filter((x) => x.custom && p.flow.bays.includes(x.id)).map((x) => `bay ${x.name}`),
    ...p.flow.classes.filter((x) => x.custom).map((x) => `class ${x.name}`),
  ];
  const gates = cat.gates.filter((g) => p.flow.gates[g.id] && !p.flow.gates[g.id]!.absent).length;
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Details">
          <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div>
              <LockNote decision={cfg} what="Project details" />
              <Field label={<>Name <span className="muted">(required)</span></>} error={errs.name}>
                <Input id="pcf-name" aria-required value={name} disabled={!cfg.allowed} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Description" htmlFor="pcf-desc"><TextArea id="pcf-desc" rows={2} value={desc} disabled={!cfg.allowed} onChange={(e) => setDesc(e.target.value)} /></Field>
              <Field label="Owner" htmlFor="pcf-owner" hint="The owner is the default fallback approver and gets budget alerts."><Select id="pcf-owner" disabled={!cfg.allowed} value={owner} onChange={setOwner} options={owners.map((x) => ({ value: x.id, label: x.name }))} /></Field>
              <Field label="Instructions overlay" htmlFor="pcf-overlay" hint="Added to every agent's instructions for this project, after the factory base and before per-repo guidelines.">
                <TextArea id="pcf-overlay" className="mono" rows={3} value={overlay} disabled={!cfg.allowed} onChange={(e) => setOverlay(e.target.value)} />
              </Field>
              <div><ActBtn kind="primary" type="submit" id="pcf-ov-save" label="Save" guard={d.allowed ? cfg : d} /></div>
            </div>
          </form>
        </Panel>
        <Panel title="Summary" tools={<Btn small icon="copy" id="pcf-save-tpl" guard={td} label="Save as template" onClick={() => saveAs(p)} />}>
          <Kv rows={[
            ["Key", p.key],
            ["Template", tpls?.find((t) => t.id === p.template)?.name ?? p.template],
            ["Teams", p.teams.map((t) => teams.find((x) => x.id === t)?.name ?? t).join(", ") || "—"],
            ["Regulated", p.regulated ? "Yes, capped at L2" : "No"],
            ["Repos", repos ? String(repos.length) : "—"],
          ]} />
          <span className="sr">{actor(p.owner).name}</span>
        </Panel>
      </div>
      <div className="cols">
        <Panel title="Recent changes" id="pcf-recent" tools={canSeeRoute("audit", me) ? <a className="btn btn-ghost btn-sm" id="pcf-to-audit" href={`#/audit?project=${encodeURIComponent(p.id)}`}>Full history</a> : null}>
          <HistoryList type="project" id={p.id} project={p.id} limit={8} />
        </Panel>
        <NotificationsSummary p={p} />
      </div>
      <Panel title="Advanced" id="pcf-adv" tools={<Btn small kind="ghost" icon={adv ? "down" : "chevron"} id="pcf-adv-toggle" label={adv ? "Hide" : "Show"} aria={`${adv ? "Hide" : "Show"} the flow summary`} aria-expanded={adv} aria-controls="pcf-flow-sum" onClick={() => setAdv((v) => !v)} />}>
        {adv ? (
          <div className="stack" id="pcf-flow-sum">
            <div className="pcf-belt-row"><MiniBelt cat={cat} project={p} counts={metricsOf(p).byPosition} /></div>
            <p className="small">
              {`${p.flow.order.length} stations, ${gates} gates, ${p.flow.bays.length} bays, ${p.flow.classes.length} work classes. `}
              {custom.length ? <span><span className="hm-lbl">Custom </span>{`${custom.join(", ")}.`}</span> : <span className="muted">No custom entries.</span>}
            </p>
          </div>
        ) : <p className="small muted">The flow at a glance: stations, gates, bays and work classes, with the belt.</p>}
      </Panel>
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
  const memCols: Array<Col<(typeof mem)[number]>> = [
    { key: "who", label: "Person", render: (x) => <div><Who id={x.id} /><div className="muted small">{x.title}</div></div> },
    { key: "roles", label: `Roles on ${p.name}`, render: (x) => (
      <div className="pcf-role-chips">
        {x.roles.filter((g) => g.scope === p.id).map((g) => (
          <span key={g.role} className="pcf-role">
            {roleName(cat, g.role)}
            <Btn small kind="ghost" icon="x" cls="pcf-role-x" id={`pcf-rm-${x.id}-${g.role}`} aria={`Remove ${roleName(cat, g.role)} from ${x.name}`} guard={d} onClick={async () => res(await ops.setMemberRole(x.id, p.id, g.role, false))} />
          </span>
        ))}
      </div>
    ) },
    { key: "else", label: "Elsewhere", render: (x) => { const e = x.roles.filter((g) => g.scope !== p.id && g.scope !== "factory"); return <span className="small">{e.length ? e.map((g) => <div key={g.role + g.scope}>{`${roleName(cat, g.role)} on ${g.scope}`}</div>) : <span className="muted">only here</span>}</span>; } },
    { key: "st", label: "Status", render: (x) => (
      <span className="small">
        {isOnCall({ projects: [p] }, x, p.id) ? <span className="chip chip-accent">on call</span> : null}
        {x.away && x.away.to > now ? <span className="chip chip-warn">{`away, delegate ${actor(x.away.delegate).name}`}</span> : null}
        {x.status !== "active" ? <Chip text="invited" /> : null}
      </span>
    ) },
  ];
  return (
    <div className="pcf-stack">
      <Panel title={`Members of ${p.name}`} flush>
        <div>
          <LockNote decision={d} what="Project membership" />
          <p className="small muted pcf-pad">{`Roles here apply only to ${p.name}. The same person can hold different roles in other projects.`}</p>
          <DataTable id="pcf-mem-table" caption={`Members of ${p.name}`} columns={memCols} rows={mem} rowKey={(x) => x.id} empty={{ title: "No members yet", text: "Grant a role below to add someone." }} />
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
      <OnCallPanel p={p} people={people} canSet={d} />
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

/**
 * Who is on call for this project (owner decision 7). Factory Admins always are; the project's admins choose who else is.
 * Nobody can put themselves on call; the person on call can hand over to someone with a role here.
 */
function OnCallPanel({ p, people, canSet }: { p: PcProps["p"]; people: PcProps["people"]; canSet: ReturnType<typeof useCan> }) {
  const res = useRes();
  const me = useMe();
  const list = Array.isArray(p.oncall) ? p.oncall : [];
  const v = (p as { version?: number }).version;
  const isFA = (x: (typeof people)[number]) => x.roles.some((g) => g.role === "factory_admin" && g.scope === "factory");
  const pool = people.filter((x) => x.status === "active" && !isFA(x) && x.roles.some((g) => g.scope === p.id || g.scope === "factory"));
  const addable = pool.filter((x) => !list.includes(x.id));
  const [pick, setPick] = useState("");
  const [to, setTo] = useState("");
  const mine = !!me && list.includes(me.person.id);
  const handTo = pool.filter((x) => x.id !== me?.person.id);
  const admins = people.filter((x) => x.status === "active" && isFA(x));
  const save = (next: string[]) => ops.setProjectOncall(p.id, next, { ifMatch: v }).then((r) => res(r));
  return (
    <Panel title="On call">
      <div className="form-grid" id="pcf-oncall">
        <p className="small muted">{`On-call rules on ${p.name} (on-call policies, and approver conditions such as hotfix sign-off) apply only to the people on call here. Nobody can put themselves on call.`}</p>
        {list.length ? (
          <ul className="plain-list" id="pcf-oncall-list">
            {list.map((id) => (
              <li key={id} className="row gap-sm">
                <Who id={id} />
                <Btn small kind="ghost" icon="x" id={`pcf-oncall-rm-${id}`} aria={`Take ${people.find((x) => x.id === id)?.name ?? id} off call`} guard={canSet} onClick={() => void save(list.filter((x) => x !== id))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted" id="pcf-oncall-none">Nobody besides the Factory Admins is on call for {p.name}.</p>
        )}
        <p className="small muted">{`Always on call: ${admins.map((x) => x.name).join(", ") || "no Factory Admin"} (Factory Admin).`}</p>
        <div className="filters">
          <Field label="Put on call" htmlFor="pcf-oncall-pick">
            <Select id="pcf-oncall-pick" disabled={!canSet.allowed || !addable.length} options={addable.length ? addable.map((x) => ({ value: x.id, label: x.name })) : [{ value: "", label: "Everyone with a role is on call" }]} value={pick || addable[0]?.id || ""} onChange={setPick} />
          </Field>
          <Btn small icon="plus" id="pcf-oncall-add" guard={canSet} disabledReason={addable.length ? null : "Everyone with a role here is already on call."} label="Add" onClick={() => void save([...list, pick || addable[0]!.id])} />
        </div>
        {mine ? (
          <div className="filters" id="pcf-oncall-handover">
            <Field label="Hand over to" htmlFor="pcf-oncall-to">
              <Select id="pcf-oncall-to" options={handTo.map((x) => ({ value: x.id, label: x.name }))} value={to || handTo[0]?.id || ""} onChange={setTo} />
            </Field>
            <Btn small icon="swap" id="pcf-oncall-hand" disabledReason={handTo.length ? null : "Nobody else holds a role here."} label="Hand over" onClick={async () => res(await ops.handOverOncall(p.id, to || handTo[0]!.id, { ifMatch: v }))} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
