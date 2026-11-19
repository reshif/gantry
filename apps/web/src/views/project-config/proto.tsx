/**
 * Project config, tab by tab. Overview and Members live in overview.tsx; Flow in flow-line.tsx; the rule editor in approvers.tsx.
 * Here: the gate table (Approvers), MCP, Budget, Repos and Line control. Eight tabs, no menu: each old secondary page is a section of its tab
 * and an old `?tab=` bookmark lands on it (see LEGACY_TABS in ctx.ts). Every change goes through the typed commands, which call the API.
 */
import { gateLabelOf } from "../../lib/gate-label";
import { useEffect, useState } from "react";
import { fmt } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useMcpServers, useMe, useRepos } from "../../api/queries";
import { hashFor } from "../../lib/router";
import { makeStopActions } from "../../shell/stopActions";
import { Chip, Empty, Field, Input, LockNote, Meter, Panel } from "../../ui/primitives";
import { isStepUp } from "../../ui/stepup";
import { useUI } from "../../ui/overlay-context";
import { Async } from "../../ui/async";
import { FormDialog } from "../projects/formdialog";
import { roleName, useRes } from "../projects/kit";
import { ActBtn, ToggleRow } from "../projects/proto";
import { ProtoList } from "../projects/protolist";
import { nextVersion } from "../govern/data";
import { useQueryParam } from "../projects/urlState";
import type { PcProps } from "./ctx";
import { AwayPanel, RulePanel, isDirty } from "./approvers";
import { ArchivePanel, SpendBreakdown } from "./misc";
import { FlowLine } from "./flow-line";

/** A repository is part of the project once it is Ready; the ones still being onboarded are in Onboarding. */
const isLive = (r: { onboarding: { stage: string } }): boolean => r.onboarding.stage === "ready";

export function FlowProto(props: PcProps) {
  return <FlowLine {...props} />;
}

export function ApproversProto(props: PcProps) {
  const { p, cat, s } = props;
  const d = useCan("approvers.edit", { project: p.id });
  const [rule, setRule] = useQueryParam("rule");
  const rows = Object.entries(p.approvers).map(([g, a]) => ({ g, ...a }));
  const name = (id: string) => cat.gates.find((x) => x.id === id)?.name ?? id;
  useEffect(() => { if (rule) document.getElementById("pcf-rule")?.scrollIntoView?.({ block: "nearest" }); }, [rule]);
  return (
    <div className="stack">
      <LockNote decision={d} what="Approver rules" />
      <Panel title="Who may approve each gate" flush>
        <ProtoList
          id="pcf-appr" noun="gate" search={false} rows={rows} rowKey={(x) => x.g}
          cols={[
            { key: "g", label: "Gate", render: (x) => <div><b className="mono">{gateLabelOf(null, x.g)}</b><span className="sub">{name(x.g)}</span>{isDirty(p, s.drafts, x.g) ? <span className="chip chip-warn">unsaved</span> : null}</div> },
            { key: "r", label: "Roles", render: (x) => <div className="row">{x.roles.length ? x.roles.map((y) => <Chip key={y} text={roleName(cat, y)} cls="plain" />) : <Chip text="automatic" cls="info" />}</div> },
            { key: "n", label: "Needed", align: "end", render: (x) => String(x.required) },
            { key: "s", label: "Separation", render: (x) => (x.sod ? <Chip text="SoD" cls="ok" /> : "—") },
            { key: "e", label: "Escalate", align: "end", render: (x) => (x.escalateH ? `${x.escalateH} h` : "—") },
            { key: "a", label: "", align: "end", render: (x) => <ActBtn small id={`pcf-ap-edit-${x.g}`} label={rule === x.g ? "Editing" : "Edit"} aria={`Edit the rule for ${gateLabelOf(null, x.g)} ${name(x.g)}`} guard={d} onClick={() => setRule(x.g)} /> },
          ]}
        />
      </Panel>
      <AwayPanel p={p} cat={cat} people={props.people} />
      {rule ? <RulePanel {...props} gid={rule} onClose={() => setRule(null)} /> : <p className="small muted">Edit a gate to set its roles, named people, approvals needed, per-class counts, conditions, escalation, fallback, separation of duties, and to test a scenario.</p>}
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
              return <ToggleRow key={s.id} id={`pcf-mcp-${s.id}`} label={s.name} hint={<><span className="mono">{s.url}</span>{" "}<Chip text={s.health} cls={s.health === "healthy" ? "ok" : "warn"} /> <Chip text={s.sensitivity} cls="plain" /></>} checked={on} decision={d} onChange={async (v) => (v && !scopeOk ? ui.toast(`${s.name} is not scoped to ${p.name}. Change its scope in MCP servers first.`, "error") : res(await ops.setProject(p.id, "mcp", v ? [...p.mcp, s.id] : p.mcp.filter((x) => x !== s.id), { ifMatch: p.version }), `${s.name}${v ? " attached" : " detached"}`))} />;
            })}
          </div>
        )}
      </Async>
    </Panel>
  );
}

export function BudgetProto({ p, cat }: PcProps) {
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
    if (!monthly.trim()) e.monthly = "Monthly budget ($) is required."; else if (!Number.isFinite(Number(monthly)) || Number(monthly) < 0) e.monthly = "Must be 0 or more."; else if (Number(monthly) > 10_000_000) e.monthly = "Cannot exceed 10,000,000.";
    if (!alert.trim()) e.alert = "Alert at (% used) is required."; else if (Number(alert) > 100) e.alert = "Cannot exceed 100."; else if (Number(alert) < 5) e.alert = "Must be at least 5.";
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
              <Field label={<>Monthly budget ($) <span className="muted">(required)</span></>} error={errs.monthly}><Input id="pcf-bud-monthly" type="number" min={0} max={10000000} step="any" value={monthly} disabled={!d.allowed} onChange={(e) => setMonthly(e.target.value)} /></Field>
              <Field label={<>Alert at (% used) <span className="muted">(required)</span></>} error={errs.alert}><Input id="pcf-bud-alert" type="number" min={5} step="any" value={alert} disabled={!d.allowed} onChange={(e) => setAlert(e.target.value)} /></Field>
              <div><ActBtn kind="primary" type="submit" id="pcf-bud-save" label="Save budget" guard={d} /></div>
            </div>
          </form>
        </Panel>
      </div>
      <SpendBreakdown p={p} cat={cat} />
    </div>
  );
}

export function ReposProto({ p }: PcProps) {
  const q = useRepos(p.id);
  return (
    <div className="stack">
      <Panel title="Ready repositories" id="pcf-ready" flush>
        <Async query={q} what="repos" id="pcf-repos" empty={<Empty id="pcf-repos-empty" title="No repos yet" text="Connect a repo in Onboarding. It must be Ready before work orders can target it." />}>
          {(repos) => (repos.some(isLive) ? (
            <ul className="list">
              {repos.filter(isLive).map((x) => (
                <li key={x.id}>
                  <a className="pri grow" href={hashFor("dossier", x.id, p.id)}>{x.name}</a>
                  <Chip text={x.lang} cls="plain" />
                  {x.halted ? <Chip text="halted" cls="warn" /> : <Chip text="active" cls="ok" />}
                </li>
              ))}
            </ul>
          ) : <Empty id="pcf-repos-none" title="No ready repos" text="Work orders can target a repo once it is Ready." />)}
        </Async>
      </Panel>
      <Panel title="Still onboarding" id="pcf-onb" flush>
        <Async query={q} what="repos" id="pcf-onb-q">
          {(repos) => {
            const pending = repos.filter((r) => !isLive(r));
            return pending.length ? (
              <ul className="list" id="pcf-onb-list">
                {pending.map((x) => {
                  const st = x.onboarding.stage;
                  return (
                    <li key={x.id}>
                      <a className="pri grow" href={hashFor("onboarding", x.id, p.id)}>{x.name}</a>
                      <Chip text={st === "person" ? "Needs a person" : st.replace("_", " ")} cls={st === "failed" || st === "person" ? "warn" : "plain"} />
                    </li>
                  );
                })}
              </ul>
            ) : <Empty id="pcf-onb-none" title="Nothing onboarding" text="Repos that are being assessed or set up appear here, with a link to their Onboarding session." />;
          }}
        </Async>
      </Panel>
    </div>
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
    <div className="stack">
    <Panel title="Halt and stop">
      <div className="stack">
        <p>Halting lets running agents finish their current step. A kill stops them now.</p>
        <div className="row">
          {p.halted ? <ActBtn icon="pause" id="pcf-resume" label="Resume project" guard={hd} onClick={() => void stop?.resume(p.id)} /> : <ActBtn icon="pause" id="pcf-halt" label="Halt project" guard={hd} onClick={() => void halt()} />}
          {p.killed ? <ActBtn kind="primary" icon="power" id="pcf-restore" label="Restore project" guard={rd} onClick={() => stop?.restore("project", p.id)} /> : <ActBtn kind="danger" icon="stop" id="pcf-kill" label="Kill project" guard={kd} onClick={kill} />}
        </div>
      </div>
    </Panel>
    <ArchivePanel p={p} />
    </div>
  );
}
