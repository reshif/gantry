/**
 * Project config in the Blueprint's seven tabs: Overview, Flow, Approvers, MCP, Budget, Repos, Line control.
 * The richer editors that were tabs before (members, work classes, notifications, history, the full rule editor, route matrix, spend breakdown,
 * instructions overlay and templates) stay one click away as secondary pages (`?tab=members` ...), linked from the tab they belong to.
 */
import { useState } from "react";
import { flowOf, gateLock, gateModeLock, type GateKind } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useMcpServers, useMe, useRepos, useTemplates } from "../../api/queries";
import { hashFor } from "../../lib/router";
import { makeStopActions } from "../../shell/stopActions";
import { Chip, Empty, Field, Input, LockNote, Meter, Panel, Select, Toggle } from "../../ui/primitives";
import { isStepUp } from "../../ui/stepup";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { Async } from "../../ui/async";
import { FormDialog } from "../projects/formdialog";
import { NumInput, roleName, useRes, useTeams } from "../projects/kit";
import { ActBtn, Kv, LOCK, ToggleRow } from "../projects/proto";
import { ProtoList } from "../projects/protolist";
import { nextVersion } from "../govern/data";
import type { PcProps } from "./ctx";

/** A repository is part of the project once it is Ready; the ones still being onboarded are in Onboarding. */
const isLive = (r: { onboarding: { stage: string } }): boolean => r.onboarding.stage === "ready";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const KINDS = ["human", "auto", "mixed"];

export function OverviewProto({ p, people }: PcProps) {
  const ui = useUI();
  const res = useRes();
  const actor = useActors();
  const d = useCan("project.edit", { project: p.id });
  const cfg = useCan("project.config", { project: p.id });
  const teams = useTeams();
  const tpls = useTemplates().data;
  const repos = useRepos(p.id).data?.filter(isLive);
  const [name, setName] = useState(p.name);
  const [desc, setDesc] = useState(p.desc ?? "");
  const [owner, setOwner] = useState(p.owner);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const owners = people.filter((x) => x.status === "active");
  const save = async () => {
    const nm = name.trim();
    if (!nm) { setErrs({ name: "Name is required." }); return; }
    if (nm.length < 3) { setErrs({ name: "Name needs at least 3 characters." }); return; }
    setErrs({});
    let ver = p.version;
    let ok = true;
    if (nm !== p.name) { const r = await ops.setProject(p.id, "name", nm, { ifMatch: ver }); if (!r.ok) { setErrs({ name: r.msg }); return; } ver = nextVersion(r, ver); }
    if (desc !== (p.desc ?? "")) { const r = res(await ops.setProject(p.id, "desc", desc.trim(), { ifMatch: ver })); ok = r.ok; if (r.ok) ver = nextVersion(r, ver); }
    if (ok && owner !== p.owner) { const r = res(await ops.setProject(p.id, "owner", owner, { ifMatch: ver })); ok = r.ok; }
    if (ok) ui.toast("Project saved", "ok");
  };
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Details">
          <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div>
              <Field label={<>Name <span className="muted">(required)</span></>} error={errs.name}>
                <Input id="pcf-name" aria-required value={name} disabled={!cfg.allowed} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Description"><Input id="pcf-desc" value={desc} disabled={!cfg.allowed} onChange={(e) => setDesc(e.target.value)} /></Field>
              <Field label="Owner"><Select id="pcf-owner" disabled={!cfg.allowed} value={owner} onChange={setOwner} options={owners.map((x) => ({ value: x.id, label: x.name }))} /></Field>
              <div><ActBtn kind="primary" type="submit" id="pcf-ov-save" label="Save" guard={d.allowed ? cfg : d} /></div>
            </div>
          </form>
        </Panel>
        <Panel title="Summary">
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
    </div>
  );
}

/** The prototype lets a locked control be tried and answers with a toast; a locked Toggle would look washed out, so the reason is spoken on the attempt instead. */
function useRefuse() {
  const ui = useUI();
  return (reason: string) => ui.toast(reason, "error");
}

export function FlowProto({ p, cat }: PcProps) {
  const res = useRes();
  const ui = useUI();
  const refuse = useRefuse();
  const d = useCan("project.config", { project: p.id });
  const f = flowOf(cat, p);
  // every gate the project's flow lists, including one that is absent (the Compliance sign-off gate shows as off)
  const gates = cat.gates.filter((g) => p.flow.gates[g.id]);
  const rowStyle = { padding: "8px 0", borderBottom: "1px dotted var(--line)", flexWrap: "nowrap" } as const;
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Stations">
          <div>
            {f.stations.map((st) => {
              const cfg = p.flow.stations[st.id] ?? { enabled: false, wip: 5 };
              return (
                <div key={st.id} className="row" style={rowStyle}>
                  <span className="mono small" style={{ width: 34, color: "var(--accent)" }}>{st.no}</span>
                  <span>{st.name}</span>
                  <span className="row small" style={{ flexWrap: "nowrap" }}>WIP <span style={{ width: 64, display: "inline-block" }}><NumInput id={`pcf-wip-${st.id}`} value={cfg.wip} min={1} max={20} limit={30} minMsg="WIP limit must be at least 1" locked={false} label={`${st.name} WIP limit`} onCommit={async (v) => (d.allowed ? res(await ops.setProject(p.id, `flow.stations.${st.id}.wip`, v, { ifMatch: p.version }), `${st.name} WIP ${v}`) : refuse(LOCK))} /></span></span>
                  <Toggle id={`pcf-st-${st.id}`} checked={st.id === "intake" ? true : cfg.enabled} decision={null} label={`${st.name} enabled`}
                    onChange={async (v) => {
                      if (!d.allowed) return refuse(LOCK);
                      if (st.id === "intake") return refuse("Intake is always on: every work order starts there.");
                      res(await ops.setProject(p.id, `flow.stations.${st.id}.enabled`, v, { ifMatch: p.version }), `${st.name}${v ? " on" : " off"}`);
                    }} />
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel title="Gates">
          <div>
            {gates.map((g) => {
              const gc = p.flow.gates[g.id]!;
              const on = gc.enabled ?? false;
              const mode = (f.gates.find((x) => x.id === g.id)?.mode ?? gc.mode ?? "human") as GateKind;
              const lock = gateLock(g, p);
              return (
                <div key={g.id} className="row" style={rowStyle}>
                  <span className="mono small" style={{ width: 52, color: "var(--accent)" }}>{g.label}</span>
                  <span>{g.name}</span>
                  <Select id={`pcf-gmode-${g.id}`} aria-label={`${g.name} mode`} style={{ width: 110 }} options={KINDS} value={mode}
                    onChange={async (v) => {
                      if (!d.allowed) return refuse(LOCK);
                      const why = gateModeLock(g, v as GateKind, p);
                      if (why) return refuse(why);
                      res(await ops.setGateMode(p.id, g.id, v, { ifMatch: p.version }), `${g.label} → ${v}`);
                    }} />
                  <Toggle id={`pcf-gate-${g.id}`} checked={on} decision={null} label={`${g.name} enabled`}
                    onChange={async (v) => {
                      if (!d.allowed) return refuse(LOCK);
                      if (lock.locked) return refuse(lock.reason);
                      if (!v && g.id !== "G1f") {
                        const ok = await ui.confirm({ title: `Turn off ${g.name}?`, kicker: `Flow · ${p.name}`, ok: "Turn off", body: `${g.name} (${g.label}) is skipped for new work orders. Work orders already in flight keep the flow they started with. This needs a recent sign-in and is audited.` });
                        if (!ok) return;
                      }
                      res(await ops.setProject(p.id, `flow.gates.${g.id}.enabled`, v, { ifMatch: p.version }), `${g.label}${v ? " on" : " off"}`);
                    }} />
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}

export function ApproversProto({ p, cat }: PcProps) {
  const ui = useUI();
  const d = useCan("flow.edit", { project: p.id });
  const rows = Object.entries(p.approvers).map(([g, a]) => ({ g, ...a }));
  const name = (id: string) => cat.gates.find((x) => x.id === id)?.name ?? id;
  const edit = (x: (typeof rows)[number]) => ui.open((close) => (
    <FormDialog
      title={`Approvers for ${x.g}`} submit="Save" close={close}
      values={{ required: x.required, escalateH: x.escalateH ?? "", sod: x.sod }}
      fields={[
        { k: "required", label: "Approvals needed", type: "number", min: 0, req: true },
        { k: "escalateH", label: "Escalate after (hours)", type: "number", min: 1, hint: "Reminds the next role up." },
        { k: "sod", label: "Submitter cannot approve their own work", type: "switch" },
      ]}
      onSubmit={async (v) => {
        const { g: _g, ...rule } = x; void _g;
        const next = { ...clone(rule), required: Number(v.required), sod: !!v.sod, ...(v.escalateH === "" ? {} : { escalateH: Number(v.escalateH) }) };
        const r = await ops.setProject(p.id, `approvers.${x.g}`, next, { ifMatch: p.version });
        if (!r.ok) return r.msg;
        ui.toast("Approvers saved", "ok");
        return undefined;
      }}
    />
  ));
  return (
    <div className="stack">
      <Panel title="Who may approve each gate" flush>
        <ProtoList
          id="pcf-appr" noun="gate" search={false} rows={rows} rowKey={(x) => x.g}
          cols={[
            { key: "g", label: "Gate", render: (x) => <div><b className="mono">{x.g}</b><span className="sub">{name(x.g)}</span></div> },
            { key: "r", label: "Roles", render: (x) => <div className="row">{x.roles.length ? x.roles.map((y) => <Chip key={y} text={roleName(cat, y)} cls="plain" />) : <Chip text="automatic" cls="info" />}</div> },
            { key: "n", label: "Needed", align: "end", render: (x) => String(x.required) },
            { key: "s", label: "Separation", render: (x) => (x.sod ? <Chip text="SoD" cls="ok" /> : "—") },
            { key: "e", label: "Escalate", align: "end", render: (x) => (x.escalateH ? `${x.escalateH} h` : "—") },
            { key: "a", label: "", align: "end", render: (x) => <ActBtn small id={`pcf-ap-edit-${x.g}`} label="Edit" guard={d} onClick={() => edit(x)} /> },
          ]}
        />
      </Panel>
    </div>
  );
}

export function McpProto({ p }: PcProps) {
  const res = useRes();
  const ui = useUI();
  const d = useCan("project.config", { project: p.id });
  const q = useMcpServers();
  return (
    <Panel title="MCP servers attached">
      <LockNote decision={d} what="MCP servers for this project" />
      <Async query={q} what="MCP servers" id="pcf-mcp" empty={<Empty id="pcf-mcp-empty" title="No MCP servers yet" text="A Factory Admin adds MCP servers; then they can be enabled here." />}>
        {(servers) => (
          <div>
            {servers.map((s) => {
              const on = p.mcp.includes(s.id);
              const scopeOk = s.projects === "all" || s.projects.includes(p.id);
              return <ToggleRow key={s.id} id={`pcf-mcp-${s.id}`} label={s.name} hint={s.url} checked={on} decision={d} onChange={async (v) => (v && !scopeOk ? ui.toast(`${s.name} is not scoped to ${p.name}. Change its scope in MCP servers first.`, "error") : res(await ops.setProject(p.id, "mcp", v ? [...p.mcp, s.id] : p.mcp.filter((x) => x !== s.id), { ifMatch: p.version }), `${s.name}${v ? " attached" : " detached"}`))} />;
            })}
          </div>
        )}
      </Async>
    </Panel>
  );
}

export function BudgetProto({ p }: PcProps) {
  const ui = useUI();
  const res = useRes();
  const d = useCan("project.config", { project: p.id });
  const b = p.budget;
  const [monthly, setMonthly] = useState(String(b.monthly));
  const [alert, setAlert] = useState(String(Math.round(b.alertAt * 100)));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const ratio = b.monthly ? b.mtd / b.monthly : 0;
  const save = async () => {
    const e: Record<string, string> = {};
    if (!monthly.trim()) e.monthly = "Monthly budget ($) is required."; else if (Number(monthly) < 100) e.monthly = "Must be at least 100.";
    if (!alert.trim()) e.alert = "Alert at (% used) is required."; else if (Number(alert) > 100) e.alert = "Cannot exceed 100."; else if (Number(alert) < 10) e.alert = "Must be at least 10.";
    setErrs(e);
    if (Object.keys(e).length) { setTimeout(() => document.querySelector<HTMLElement>("#pcf-budget [aria-invalid=true]")?.focus(), 30); return; }
    let ver = b && p.version;
    let ok = true;
    if (Number(monthly) !== b.monthly) { const r = res(await ops.setProject(p.id, "budget.monthly", Number(monthly), { ifMatch: ver })); ok = r.ok; if (r.ok) ver = nextVersion(r, ver); }
    if (ok && Number(alert) / 100 !== b.alertAt) ok = res(await ops.setProject(p.id, "budget.alertAt", Number(alert) / 100, { ifMatch: ver })).ok;
    if (ok) ui.toast("Budget saved", "ok");
  };
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Spend">
          <div className="stack">
            <div className="stat"><div className="micro">Month to date</div><div className="v">{fmt.money0(b.mtd)}</div><div className="s">{`of ${fmt.money0(b.monthly)}`}</div></div>
            <Meter value={b.mtd} max={b.monthly} label="Budget used" warnAt={b.alertAt} />
            <span className="sr">{fmt.pct(ratio)}</span>
          </div>
        </Panel>
        <Panel title="Limits">
          <form id="pcf-budget" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div>
              <LockNote decision={d} what="Budget" />
              <Field label={<>Monthly budget ($) <span className="muted">(required)</span></>} error={errs.monthly}><Input id="pcf-bud-monthly" type="number" min={100} value={monthly} disabled={!d.allowed} onChange={(e) => setMonthly(e.target.value)} /></Field>
              <Field label={<>Alert at (% used) <span className="muted">(required)</span></>} error={errs.alert}><Input id="pcf-bud-alert" type="number" min={10} value={alert} disabled={!d.allowed} onChange={(e) => setAlert(e.target.value)} /></Field>
              <div><ActBtn kind="primary" type="submit" id="pcf-bud-save" label="Save budget" guard={d} /></div>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}

export function ReposProto({ p }: PcProps) {
  const q = useRepos(p.id);
  return (
    <Panel title="Repositories" flush>
      <Async query={q} what="repos" id="pcf-repos" empty={<Empty id="pcf-repos-empty" title="No repos yet" text="Connect a repo in Onboarding. It must be Ready before work orders can target it." />}>
        {(repos) => (
          <ul className="list">
            {repos.filter(isLive).map((x) => (
              <li key={x.id}>
                <a className="pri grow" href={hashFor("dossier", x.id, p.id)}>{x.name}</a>
                <Chip text={x.lang} cls="plain" />
                {x.halted ? <Chip text="halted" cls="warn" /> : <Chip text="active" cls="ok" />}
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Panel>
  );
}

export function LineProto({ p }: PcProps) {
  const ui = useUI();
  const me = useMe();
  const hd = useCan("halt.project", { project: p.id });
  const kd = useCan("kill.project", { project: p.id });
  const rd = useCan("restore.project", { project: p.id });
  const stop = me ? makeStopActions(ui, me) : null;
  // the prototype's dialog: type the project key only. The server wants a reason for the audit trail, so it is written for the person.
  // the prototype toggles the halt at once with a toast; the audit reason is written for the person
  const halt = async () => {
    const r = await ops.haltProject(p.id, `Halted from Project config (${p.name}).`);
    ui.toast(r.ok ? `${p.name} halted` : r.msg, r.ok ? "warn" : "error");
  };
  const kill = () => ui.open((close) => (
    <FormDialog
      title={`Kill ${p.name}`} submit="Kill project" danger close={close} intro="All running work stops now."
      values={{ c: "" }}
      fields={[
        { k: "c", label: `Type the project key (${p.key})`, req: true, validate: (v) => (v !== p.key ? `Type ${p.key} exactly.` : "") },
      ]}
      onSubmit={async () => {
        const r = await ops.kill("project", p.id, { reason: `Killed from Project config; ${p.key} typed to confirm.`, mode: "hold", confirmText: p.name });
        if (!r.ok) {
          if (isStepUp(r)) { close(); stop?.kill("project", p.id); return undefined; } // the shell's kill dialog carries the sign-in re-check
          return r.msg;
        }
        ui.toast(`${p.name} killed`, "error");
        return undefined;
      }}
    />
  ));
  return (
    <Panel title="Halt and stop">
      <div className="stack">
        <p>Halting lets running agents finish their current step. A kill stops them now.</p>
        <div className="row">
          {p.halted ? <ActBtn icon="pause" id="pcf-resume" label="Resume project" guard={hd} onClick={() => void stop?.resume(p.id)} /> : <ActBtn icon="pause" id="pcf-halt" label="Halt project" guard={hd} onClick={() => void halt()} />}
          {p.killed ? <ActBtn kind="primary" icon="power" id="pcf-restore" label="Restore project" guard={rd} onClick={() => stop?.restore("project", p.id)} /> : <ActBtn kind="danger" icon="stop" id="pcf-kill" label="Kill project" guard={kd} onClick={kill} />}
        </div>
      </div>
    </Panel>
  );
}
