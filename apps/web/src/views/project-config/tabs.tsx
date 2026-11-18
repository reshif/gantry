/**
 * Project config in the prototype's seven tabs: General, Stations and gates, Classes, Approvers, Members, Freezes, Danger zone.
 * Each tab is the prototype's markup (a card, usually a flush table) wired to the same commands as before. The richer editors that
 * the prototype does not draw (add or reorder a station, class dialog, the approver rule editor with drafts, on-call) open under the
 * table from an "Edit" button, so nothing was dropped: they live in flow.tsx, classes.tsx, approvers.tsx and overview.tsx.
 */
import { useState, type ReactNode } from "react";
import { fmt, flowOf, gateModeLock, type ApproverRule, type GateKind, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useFreezes, useMe, useRepos } from "../../api/queries";
import { hashFor } from "../../lib/router";
import { Btn, Chip, Field, Panel, Select, Toggle, Who } from "../../ui/primitives";
import { Input, TextArea } from "../../ui/inputs";
import { Card, Stats } from "../../ui/cr";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { makeStopActions } from "../../shell/stopActions";
import { NumInput, metricsOf, projectRoles, roleName, useRes } from "../projects/kit";
import { useSaveFromProject } from "../projects/templates";
import { ifMatchOf } from "../govern/data";
import { membersOf, type PcProps } from "./ctx";
import { KINDS } from "./flow";
import { stageName } from "../onboarding/kit";

export interface TabProps extends PcProps {
  /** The `edit` URL parameter: which advanced editor is open under the table ("" when none). */
  edit: string;
  setEdit: (v: string) => void;
  /** Opens another tab of this screen (General's "more settings" links). */
  goTab: (tab: string) => void;
  /** The advanced editor for this tab, rendered under the table while `edit` is set. */
  advanced: ReactNode;
}

const Editor = ({ open, label, onToggle, children }: { open: boolean; label: string; onToggle: () => void; children: ReactNode }) => (
  <>
    <div className="row" style={{ justifyContent: "flex-end" }}><Btn small kind="ghost" icon="tool" id="pcf-edit-toggle" label={open ? "Close editor" : label} onClick={onToggle} /></div>
    {open ? <section aria-label={label} className="stack">{children}</section> : null}
  </>
);

/* ------------------------------------------------------------------ General ---- */

export function GeneralTab({ p, s, set, goTab, people }: TabProps) {
  const ui = useUI();
  const d = useCan("project.config", { project: p.id });
  const td = useCan("template.edit");
  const saveAs = useSaveFromProject();
  const repos = useRepos(p.id).data;
  const m = metricsOf(p);
  const res = useRes();
  const desc = s.text.desc ?? p.desc ?? "";
  const overlay = s.text.overlay ?? p.overlay ?? "";
  const owners = people.filter((x) => x.status === "active");
  const clear = (k: string) => { const t = { ...s.text }; delete t[k]; set({ text: t }); };
  const saveDesc = async () => {
    if (desc.trim() === (p.desc ?? "")) return clear("desc");
    const r = await ops.setProject(p.id, "desc", desc.trim(), { ifMatch: p.version });
    res(r, "Saved description");
    clear("desc");
  };
  const repoChip = (r: Repo) => (r.freeze ? <Chip text="Frozen" cls="warn" /> : r.onboarding.stage === "ready" ? <Chip text="Ready" cls="ok" /> : <Chip text={stageName(r.onboarding.stage)} cls="info" />);
  return (
    <div className="grid g-main2">
      <div className="stack">
        <Card title="General" acts={<span className="hint">Changes save when you leave a field</span>}>
          <div className="stack">
            <Field label="Name" htmlFor="pcf-name" hint="Renaming is not available: the API has no rename for a project.">
              <Input id="pcf-name" value={p.name} readOnly />
            </Field>
            <Field label="Description" htmlFor="pcf-desc">
              <TextArea id="pcf-desc" rows={2} disabled={!d.allowed} value={desc} onChange={(e) => set({ text: { ...s.text, desc: e.target.value } })} onBlur={() => void saveDesc()} />
            </Field>
            <Field label="Owner" htmlFor="pcf-owner">
              <Select id="pcf-owner" disabled={!d.allowed} options={owners.map((x) => ({ value: x.id, label: x.name }))} value={p.owner} onChange={async (v) => { if (v !== p.owner) res(await ops.setProject(p.id, "owner", v, { ifMatch: p.version }), "Saved owner"); }} />
            </Field>
            <div className="row">
              <Toggle id="pcf-regulated" checked={!!p.regulated} decision={{ allowed: false, reason: "Not available: the API cannot change whether a project is regulated yet.", needs: "" }} label="Regulated project" />
              <span>Regulated project (caps autonomy at L2, adds security gate)</span>
            </div>
          </div>
        </Card>
        <Card title="Instructions overlay" hint="Added to every agent's instructions for this project, after the factory base and before per-repo guidelines.">
          <div className="stack">
            <TextArea id="pcf-overlay" mono rows={5} aria-label="Instructions overlay" disabled={!d.allowed} value={overlay} onChange={(e) => set({ text: { ...s.text, overlay: e.target.value } })} />
            <div className="row">
              <Btn kind="primary" small id="pcf-ov-save" guard={d} label="Save overlay" onClick={async () => {
                if (overlay === (p.overlay ?? "")) return void ui.toast("No changes to save.", "info");
                res(await ops.setProject(p.id, "overlay", overlay.trim(), { ifMatch: p.version }), "Saved overlay");
                clear("overlay");
              }} />
              {overlay !== (p.overlay ?? "") ? <Btn small kind="ghost" id="pcf-ov-discard" label="Discard" onClick={() => clear("overlay")} /> : null}
            </div>
          </div>
        </Card>
      </div>
      <div className="stack">
        <Stats items={[{ l: "On belt", v: m.wip + m.bays, tone: "info" }, { l: "Blocked", v: m.bad, tone: m.bad ? "bad" : "ok" }]} />
        <Card title="Repositories" flush acts={<a className="btn sm ghost" id="pcf-to-onb" href={hashFor("onboarding", null, p.id)}>Onboarding</a>}>
          {repos?.length ? <div className="list">{repos.map((r) => <div key={r.id} className="li"><span className="mono" style={{ flex: 1 }}>{r.name}</span>{repoChip(r)}</div>)}</div> : <p className="dim" style={{ padding: 16 }}>No repos yet. Connect one in Onboarding.</p>}
        </Card>
        <Card title="More settings" flush>
          <div className="list">
            {([["budget", "Budget", `$${p.budget.mtd} spent of $${p.budget.monthly} this month`], ["notifications", "Notifications", "Where this project's events go"], ["mcp", "MCP servers", "Tools its agents may use"], ["history", "History", "Every change to this project"]] as Array<[string, string, string]>).map(([id, t, sub]) => (
              <div key={id} className="li"><span className="main1"><span className="t1">{t}</span><span className="t2">{sub}</span></span><Btn small kind="ghost" id={`pcf-more-${id}`} label="Open" onClick={() => goTab(id)} /></div>
            ))}
            <div className="li"><span className="main1"><span className="t1">Save as template</span><span className="t2">Reuse this line for new projects</span></span><Btn small kind="ghost" icon="copy" id="pcf-save-tpl" guard={td} label="Save" onClick={() => saveAs(p)} /></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Stations and gates ---- */

export function StationsTab({ p, cat, edit, setEdit, advanced }: TabProps) {
  const res = useRes();
  const d = useCan("flow.edit", { project: p.id });
  const f = flowOf(cat, p);
  const locked = (id: string) => id === "intake" || id === "build";
  const gateOf = (stationId: string) => f.gates.find((x) => x.after === stationId);
  return (
    <div className="stack">
      <Card title="Stations and gates" flush hint="Build cannot be disabled">
        <DataTable<(typeof f.stations)[number]>
          id="pcf-stations"
          caption="Stations and gates"
          rows={f.stations}
          rowKey={(st) => st.id}
          columns={[
            { key: "name", label: "Station", render: (st) => <b>{st.name}</b> },
            { key: "agent", label: "Agent", render: (st) => <Who id={st.agent} /> },
            { key: "slots", label: "Slots", align: "end", render: (st) => <NumInput id={`pcf-sg-wip-${st.id}`} value={p.flow.stations[st.id]!.wip} min={1} max={30} locked={!d.allowed} label={`${st.name} slots`} onCommit={async (v) => res(await ops.setProject(p.id, `flow.stations.${st.id}.wip`, v, { ifMatch: p.version }), `Saved ${st.name} slots`)} /> },
            { key: "on", label: "Enabled", render: (st) => <Toggle id={`pcf-sg-on-${st.id}`} checked={p.flow.stations[st.id]!.enabled} decision={locked(st.id) ? { allowed: false, reason: `${st.name} cannot be disabled.`, needs: "" } : d} label={`${st.name} enabled`} onChange={async (v) => res(await ops.setProject(p.id, `flow.stations.${st.id}.enabled`, v, { ifMatch: p.version }), `${st.name}${v ? " enabled" : " disabled"}`)} /> },
            { key: "gate", label: "Gate after", render: (st) => { const g = gateOf(st.id); return g ? <><span className="mono">{g.label}</span> {g.name}</> : <span className="dim">—</span>; } },
            { key: "mode", label: "Gate mode", render: (st) => { const g = gateOf(st.id); return g ? <Select id={`pcf-sg-mode-${g.id}`} aria-label={`Mode ${g.label}`} disabled={!d.allowed || g.id === "G0G1"} options={KINDS.filter((o) => o.value === g.mode || !gateModeLock(g, o.value as GateKind, p))} value={g.mode} onChange={async (v) => res(await ops.setGateMode(p.id, g.id, v, { ifMatch: p.version }), "Saved")} /> : null; } },
          ]}
        />
      </Card>
      <Editor open={edit === "flow"} label="Edit stations, gates and routes" onToggle={() => setEdit(edit === "flow" ? "" : "flow")}>{advanced}</Editor>
    </div>
  );
}

/* ------------------------------------------------------------------ Classes ---- */

export function ClassesTable({ p, cat, edit, setEdit, advanced }: TabProps) {
  const res = useRes();
  const d = useCan("class.edit", { project: p.id });
  const f = flowOf(cat, p);
  const [sla, setSla] = useState<Record<string, string>>({});
  const stName = (id: string) => f.stations.find((x) => x.id === id)?.name ?? id;
  return (
    <div className="stack">
      <Card title="Work order classes" flush>
        <DataTable<(typeof p.flow.classes)[number]>
          id="pcf-classes"
          caption="Work order classes"
          rows={p.flow.classes}
          rowKey={(c) => c.id}
          columns={[
            { key: "name", label: "Class", render: (c) => <b>{c.name}</b> },
            { key: "pri", label: "Default priority", render: (c) => <span className="tag">{c.priority}</span> },
            { key: "sla", label: "SLA (h)", align: "end", render: (c) => (
              <Input id={`pcf-sla-${c.id}`} mono style={{ width: 72, textAlign: "right" }} inputMode="numeric" disabled={!d.allowed} aria-label={`SLA hours for ${c.name}`} value={sla[c.id] ?? String(c.slaH)}
                onChange={(e) => setSla({ ...sla, [c.id]: e.target.value })}
                onBlur={async () => { const n = parseInt(sla[c.id] ?? "", 10); const cur = sla[c.id]; setSla((x) => { const y = { ...x }; delete y[c.id]; return y; }); if (cur === undefined || !(n > 0) || n === c.slaH) return; res(await ops.updateClass(p.id, c.id, { slaH: n }, { ifMatch: p.version }), "Saved SLA"); }} />
            ) },
            { key: "skips", label: "Skips stations", render: (c) => (c.skips.length ? <>{c.skips.map((x) => <span key={x} className="tag">{stName(x)}</span>)}</> : <span className="dim">none</span>) },
            { key: "on", label: "Enabled", render: (c) => <Toggle id={`pcf-cx-en-${c.id}`} checked={c.enabled !== false} decision={d} label={`${c.name} enabled`} onChange={async (v) => res(await ops.updateClass(p.id, c.id, { enabled: v }, { ifMatch: p.version }), `${c.name}${v ? " enabled" : " disabled"}`)} /> },
          ]}
        />
      </Card>
      <Editor open={edit === "classes"} label="Edit classes" onToggle={() => setEdit(edit === "classes" ? "" : "classes")}>{advanced}</Editor>
    </div>
  );
}

/* ------------------------------------------------------------------ Approvers ---- */

export function ApproversTable({ p, cat, people, s, edit, setEdit, advanced }: TabProps) {
  const res = useRes();
  const d = useCan("approvers.edit", { project: p.id });
  const f = flowOf(cat, p);
  const who = (r: ApproverRule | undefined): string => (r ? [...r.roles.map((x) => roleName(cat, x)), ...r.people.map((x) => people.find((y) => y.id === x)?.name ?? x)].join(", ") || "—" : "—");
  const save = async (gid: string, patch: Partial<ApproverRule>, label: string) => {
    const cur = p.approvers[gid];
    if (!cur) return;
    res(await ops.setProject(p.id, `approvers.${gid}`, { ...cur, ...patch }, { ifMatch: p.version }), label);
  };
  return (
    <div className="stack">
      <Card title="Approvers per gate" flush>
        <DataTable<(typeof f.gates)[number]>
          id="pcf-approvers"
          caption="Approvers per gate"
          rows={f.gates}
          rowKey={(g) => g.id}
          columns={[
            { key: "gate", label: "Gate", render: (g) => <><b className="mono">{g.label}</b> {g.name}</> },
            { key: "who", label: "Who can approve", render: (g) => (g.mode === "auto" ? <span className="dim">no approvers (automatic)</span> : <>{who(p.approvers[g.id])}</>) },
            { key: "need", label: "Needed", align: "end", render: (g) => { const r = p.approvers[g.id]; return r && g.mode !== "auto" ? <Select id={`pcf-need-${g.id}`} style={{ width: 64 }} aria-label={`Approvers needed for ${g.label}`} disabled={!d.allowed} options={["1", "2"]} value={String(r.required)} onChange={(v) => void save(g.id, { required: Number(v) }, `Saved ${g.label}`)} /> : <span className="dim">—</span>; } },
            { key: "sod", label: "Separation of duties", render: (g) => { const r = p.approvers[g.id]; return r && g.mode !== "auto" ? <Toggle id={`pcf-sod-${g.id}`} checked={r.sod} decision={d} label={`Separation of duties at ${g.label}`} onChange={(v) => void save(g.id, { sod: v }, `Saved ${g.label}`)} /> : <span className="dim">—</span>; } },
            { key: "edit", label: "", align: "end", render: (g) => (g.mode === "auto" ? null : <Btn small kind="ghost" id={`pcf-ax-edit-${g.id}`} label="Edit rule" onClick={() => setEdit(g.id)} />) },
          ]}
        />
      </Card>
      <Editor open={!!edit && edit !== "closed"} label="Edit approver rules" onToggle={() => setEdit(edit ? "" : s.gate || "G5")}>{advanced}</Editor>
    </div>
  );
}

/* ------------------------------------------------------------------ Members ---- */

export function MembersTable({ p, cat, people }: TabProps) {
  const ui = useUI();
  const res = useRes();
  const d = useCan("project.members", { project: p.id });
  const mem = membersOf(people, p);
  const eligible = people.filter((x) => x.status === "active" && !x.roles.some((g) => g.scope === "factory") && !mem.some((m) => m.id === x.id));
  const roles = projectRoles(cat);
  const add = () => ui.open((close) => <AddMember p={p} eligible={eligible} roles={roles} close={close} />);
  const remove = async (id: string, name: string) => {
    const ok = await ui.confirm({ title: `Remove ${name}?`, body: `They lose access to ${p.name}. Work they requested stays.`, ok: "Remove", kind: "danger" });
    if (!ok) return;
    const x = people.find((y) => y.id === id);
    let last = { ok: true, msg: "Removed" };
    for (const role of x ? x.roles.filter((g) => g.scope === p.id).map((g) => g.role) : []) {
      last = await ops.setMemberRole(id, p.id, role, false);
      if (!last.ok) break;
    }
    res(last, "Removed");
  };
  return (
    <div className="stack">
      <Card title="Members" flush acts={<Btn small kind="primary" icon="plus" id="pcf-add-member" guard={d} label="Add member" onClick={add} />}>
        <DataTable<(typeof mem)[number]>
          id="pcf-members"
          caption="Members"
          rows={mem}
          rowKey={(x) => x.id}
          columns={[
            { key: "person", label: "Person", render: (x) => <a className="rl" href={hashFor("person", x.id)}>{x.name}</a> },
            { key: "title", label: "Title", render: (x) => <span className="muted">{x.title}</span> },
            { key: "role", label: "Role in project", render: (x) => <>{x.roles.filter((g) => g.scope === p.id).map((g) => <Chip key={g.role} text={roleName(cat, g.role)} cls="info" />)}</> },
            { key: "rm", label: "", align: "end", render: (x) => <Btn small kind="ghost" cls="danger" id={`pcf-rm-${x.id}`} label="Remove" guard={d} onClick={() => void remove(x.id, x.name)} /> },
          ]}
          empty={{ title: "No members yet", text: "Add someone to give them a role on this project." }}
        />
      </Card>
      <OnCallPanel p={p} people={people} canSet={d} />
    </div>
  );
}

function AddMember({ p, eligible, roles, close }: { p: PcProps["p"]; eligible: PcProps["people"]; roles: ReturnType<typeof projectRoles>; close: () => void }) {
  const res = useRes();
  const ui = useUI();
  const [who, setWho] = useState(eligible[0]?.id ?? "");
  const [role, setRole] = useState(roles.find((r) => r.id === "engineer")?.id ?? roles[0]?.id ?? "");
  return (
    <Dialog
      title={`Add member to ${p.name}`}
      onClose={close}
      body={
        <div className="form-grid">
          <Field label="Person" htmlFor="pcf-am-who"><Select id="pcf-am-who" options={eligible.length ? eligible.map((x) => ({ value: x.id, label: x.name })) : [{ value: "", label: "Everyone is already a member" }]} value={who} onChange={setWho} /></Field>
          <Field label="Role" htmlFor="pcf-am-role"><Select id="pcf-am-role" options={roles.map((r) => ({ value: r.id, label: r.name }))} value={role} onChange={setRole} /></Field>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: "Add", kind: "primary", submit: true, id: "pcf-am-add", onClick: async (c) => {
          if (!who) return void ui.toast("Pick a person.", "warn");
          const x = await ops.setMemberRole(who, p.id, role, true);
          res(x, `Added ${eligible.find((y) => y.id === who)?.name ?? "member"}`);
          if (x.ok) c();
        } },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ Freezes ---- */

export function FreezesTab({ p }: TabProps) {
  const ui = useUI();
  const res = useRes();
  const actor = useActors();
  const perm = useCan("policy.edit");
  const q = useFreezes();
  const reposQ = useRepos(p.id).data;
  const repos = reposQ ?? [];
  const ids = new Set(repos.map((r) => r.id));
  const all = Array.isArray(q.data) ? q.data : null;
  const mine = (all ?? []).filter((f) => f.repos === "all" || f.repos.some((r) => ids.has(r)));
  const now = Date.now();
  const names = (f: (typeof mine)[number]) => (f.repos === "all" ? "all repos" : f.repos.map((r) => repos.find((x) => x.id === r)?.name ?? r).join(", "));
  const add = () => ui.open((close) => <AddFreeze repos={repos} close={close} />);
  return (
    <Card title="Freezes and release windows" flush acts={<Btn small kind="primary" icon="plus" id="pcf-add-freeze" guard={perm} label="Add freeze" onClick={add} />}>
      {all === null ? (
        <p className="dim" style={{ padding: 16 }}>{q.isLoading ? "Loading freezes…" : "Not available: you may not read freezes, or they could not be loaded."}</p>
      ) : mine.length ? (
        <div className="list">
          {mine.sort((a, b) => a.from - b.from).map((f) => {
            const active = now >= f.from && now < f.to;
            const past = now >= f.to;
            return (
              <div key={f.id} className="li">
                <div className="main1"><span className="t1">{f.name}</span><span className="t2 mono">{`${fmt.stamp(f.from)} → ${fmt.stamp(f.to)} · ${names(f)} · set by ${actor(f.by).name}`}</span></div>
                <Chip text={past ? "Ended" : active ? "Active" : "Scheduled"} cls={active ? "warn" : "idle"} />
                {!past ? <Btn small kind="ghost" id={`pcf-fz-end-${f.id}`} label="Lift" guard={perm} onClick={async () => res(await ops.endFreeze(f.id, ifMatchOf(f)), "Freeze lifted")} /> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="dim" style={{ padding: 16 }}>No freezes on {p.name}.</p>
      )}
    </Card>
  );
}

function AddFreeze({ repos, close }: { repos: Repo[]; close: () => void }) {
  const res = useRes();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("all");
  const [days, setDays] = useState("1");
  const [err, setErr] = useState("");
  return (
    <Dialog
      title="Add freeze"
      onClose={close}
      body={
        <div className="form-grid">
          <Field label="Name" htmlFor="pcf-fz-name" error={err} required><Input id="pcf-fz-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Repositories" htmlFor="pcf-fz-repo"><Select id="pcf-fz-repo" options={[{ value: "all", label: "All repos of this project" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={repo} onChange={setRepo} /></Field>
          <Field label="Days" htmlFor="pcf-fz-days"><Select id="pcf-fz-days" options={["1", "3", "7", "14"]} value={days} onChange={setDays} /></Field>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: "Add freeze", kind: "primary", submit: true, id: "pcf-fz-add", onClick: async (c) => {
          if (name.trim().length < 3) return setErr("Name needs at least 3 characters.");
          const from = Date.now() + 864e5;
          const r = await ops.saveFreeze({ name: name.trim(), repos: repo === "all" ? repos.map((x) => x.id) : [repo], from, to: from + Number(days) * 864e5 });
          res(r, "Freeze scheduled");
          if (r.ok) c();
        } },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ Danger zone ---- */

export function DangerCard({ p }: TabProps) {
  const ui = useUI();
  const res = useRes();
  const me = useMe();
  const halt = useCan("line.halt", { project: p.id });
  const kd = useCan("kill.project", { project: p.id });
  const rd = useCan("restore.project", { project: p.id });
  const ad = useCan("project.archive", { project: p.id });
  const stop = me ? makeStopActions(ui, me) : null;
  const halted = !!p.halted;
  const killed = !!p.killed;
  const archived = p.status === "archived";
  const rows: Array<[string, string, ReactNode]> = archived ? [["Archived", "This project is read-only and refuses new work.", <Btn key="u" kind="danger" id="pcf-unarchive" guard={ad} label="Unarchive" onClick={async () => res(await ops.unarchiveProject(p.id, { ifMatch: p.version }), "Unarchived")} />]] : [
    ["Halt line", "Stops new work entering stations. In-flight runs finish.", <Btn key="h" kind="danger" id="pcf-halt" guard={halt} label={halted ? "Resume line" : "Halt line"} onClick={() => (halted ? void stop?.resume(p.id) : stop?.halt(p.id))} />],
    ["Emergency stop", "Stops all agents on this project immediately.", <Btn key="k" kind="danger" id={killed ? "pcf-restore" : "pcf-kill"} guard={killed ? rd : kd} label={killed ? "Restore project" : "Emergency stop…"} onClick={() => (killed ? stop?.restore("project", p.id) : stop?.kill("project", p.id))} />],
    ["Archive project", "Hides the project. History is kept for audit.", <Btn key="a" kind="danger" id="pcf-archive" guard={ad} label="Archive…" onClick={() => ui.typedConfirm({
      title: `Archive ${p.name}?`, sub: "It disappears from lists. History stays for audit. You can restore it from the audit ledger.", phrase: p.key, okLabel: "Archive", kind: "danger", guard: ad,
      body: <p className="small muted">Type the project key ({p.key}) to confirm.</p>,
      onOk: async () => { const r = await ops.archiveProject(p.id, p.name, { ifMatch: p.version }); res(r, "Archived"); return r.ok ? undefined : { ok: false, msg: r.msg }; },
    })} />],
  ];
  return (
    <Card title="Danger zone" flush>
      <div className="list">
        {rows.map(([t, sub, btn]) => (
          <div key={t} className="setrow"><div className="tx"><b>{t}</b><span>{sub}</span></div>{btn}</div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Who is on call for this project (owner decision 7). Factory Admins always are; the project's admins choose who else is.
 * Nobody can put themselves on call; the person on call can hand over to someone with a role here.
 */
export function OnCallPanel({ p, people, canSet }: { p: PcProps["p"]; people: PcProps["people"]; canSet: ReturnType<typeof useCan> }) {
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
