import { useState } from "react";
import { DAYS, type Action, type Freeze, type Policy, type Project, type Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { DataTable } from "../../ui/DataTable";
import { Btn, Empty, Field, LockNote, Segmented, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ifMatchOf, useOutcome, usePolicyWording, versionOf } from "../govern/data";

/** Policies the engine owns: only enabling or disabling is allowed (matches the server's FIXED_POLICIES). */
export const SPECIAL: Record<string, string> = {
  "POL-110": "Freeze rules come from the freeze list; only enable or disable this policy.",
  "POL-112": "Agent autonomy rule; only enable or disable this policy.",
};

type Draft = Omit<Policy, "when"> & { when: { days: number[]; from: string; to: string }; custom?: boolean };

const draftOf = (existing: Policy | null): Draft => {
  if (existing) {
    const d = JSON.parse(JSON.stringify(existing)) as Draft & { when: Draft["when"] | null };
    if (!d.when) d.when = { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" };
    d.where = d.where ?? {};
    return d as Draft;
  }
  return { id: "NEW", name: "", effect: "allow", enabled: true, roles: ["release_manager"], actions: ["release"], where: { projects: [] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false, extend: false, custom: true };
};

function Checks({ prefix, items, list, onChange }: { prefix: string; items: Array<{ value: string; label: string }>; list: string[]; onChange: (v: string, on: boolean) => void }) {
  return (
    <div className="check-grid">
      {items.map((it) => (
        <label key={it.value} className="check" htmlFor={prefix + it.value}>
          <input type="checkbox" id={prefix + it.value} value={it.value} checked={list.includes(it.value)} onChange={(e) => onChange(it.value, e.target.checked)} />
          {it.label}
        </label>
      ))}
    </div>
  );
}

const toggle = (arr: string[], v: string, on: boolean): string[] => (on ? (arr.includes(v) ? arr : [...arr, v]) : arr.filter((x) => x !== v));

export function PolicyForm({ existing, perm, roles, actions, projects, policies, matrix, registerSubmit, close }: {
  existing: Policy | null; perm: Decision; roles: Role[]; actions: Action[]; projects: Project[]; policies: Policy[]; matrix: Record<string, Record<string, boolean>>;
  registerSubmit: (fn: () => void) => void; close: () => void;
}) {
  const outcome = useOutcome();
  const wording = usePolicyWording();
  const [d, setD] = useState<Draft>(() => draftOf(existing));
  const [err, setErr] = useState("");
  const upd = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const groups = [...new Set(actions.map((a) => a.group))];
  const projectIds = d.where.projects ?? [];
  const preview = (() => {
    try {
      return wording.sentence(d as unknown as Policy);
    } catch {
      return "";
    }
  })();
  const firsts = d.extend ? [] : d.actions.filter((a) => !policies.some((q) => q.id !== existing?.id && q.enabled && q.effect === "allow" && !q.extend && q.actions.includes(a)));

  registerSubmit(() => {
    void (async () => {
      const name = d.name.trim();
      if (!name) return setErr("Name the policy.");
      if (!d.actions.length) return setErr("Pick at least one action.");
      if (!d.roles.length) return setErr("Pick at least one role.");
      if (!d.when.days.length) return setErr("Pick at least one day.");
      if (d.when.to !== "24:00" && d.when.from >= d.when.to) return setErr("'To' must be after 'From'.");
      const { id: _id, custom: _c, ...rest } = d as Draft & { version?: number };
      const version = versionOf(existing);
      const r = outcome(await ops.savePolicy(existing?.id ?? null, { ...rest, name }, version !== undefined ? { ifMatch: version } : undefined));
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });

  const setDay = (i: number, on: boolean) => upd({ when: { ...d.when, days: (on ? [...d.when.days, i] : d.when.days.filter((x) => x !== i)).sort() } });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Policies" />
      <Field label="Name" htmlFor="acc-pd-name"><input id="acc-pd-name" className="input" value={d.name} placeholder="Weekend hotfix window" onChange={(e) => upd({ name: e.target.value })} /></Field>
      <div className="field">
        <div className="field-label">Kind</div>
        <Segmented name="acc-pd-mode" label="Policy kind" value={d.extend ? "extend" : "narrow"} onChange={(v) => upd({ extend: v === "extend" })} items={[{ id: "narrow", label: "Narrow: only inside this window" }, { id: "extend", label: "Extend: add the right here" }]} />
      </div>
      <div className="field">
        <div className="field-label">What (actions)</div>
        <div className="acc-acts">
          {groups.map((g) => (
            <fieldset key={g} className="acc-fs">
              <legend>{g}</legend>
              <Checks prefix="acc-pd-a-" items={actions.filter((a) => a.group === g).map((a) => ({ value: a.id, label: a.name }))} list={d.actions} onChange={(v, on) => upd({ actions: toggle(d.actions, v, on) })} />
            </fieldset>
          ))}
        </div>
      </div>
      <div className="field">
        <div className="field-label">Who (roles)</div>
        <Checks prefix="acc-pd-r-" items={roles.map((r) => ({ value: r.id, label: r.name + (r.custom ? " (custom)" : "") }))} list={d.roles} onChange={(v, on) => upd({ roles: toggle(d.roles, v, on) })} />
      </div>
      <div className="field">
        <div className="field-label">Where (projects; none ticked means every project)</div>
        <Checks prefix="acc-pd-p-" items={projects.map((p) => ({ value: p.id, label: p.name }))} list={projectIds} onChange={(v, on) => upd({ where: { ...d.where, projects: toggle(projectIds, v, on) } })} />
        <div className="field-hint">For one repo use a freeze; for paths such as /payments use approver conditions in Project config.</div>
      </div>
      <div className="field">
        <div className="field-label">When (IST)</div>
        <div className="check-grid days">
          {DAYS.map((dn, i) => (
            <label key={dn} className="check" htmlFor={`acc-pd-d-${i}`}>
              <input type="checkbox" id={`acc-pd-d-${i}`} value={String(i)} checked={d.when.days.includes(i)} onChange={(e) => setDay(i, e.target.checked)} />
              {dn}
            </label>
          ))}
        </div>
      </div>
      <div className="form-row">
        <Field label="From" htmlFor="acc-pd-from"><input id="acc-pd-from" className="input mono" type="time" value={d.when.from} onChange={(e) => upd({ when: { ...d.when, from: e.target.value } })} /></Field>
        <Field label="To (00:00 means end of day)" htmlFor="acc-pd-to"><input id="acc-pd-to" className="input mono" type="time" value={d.when.to === "24:00" ? "00:00" : d.when.to} onChange={(e) => upd({ when: { ...d.when, to: e.target.value === "00:00" ? "24:00" : e.target.value } })} /></Field>
        <div className="field">
          <div className="field-label">On call</div>
          <label className="check" htmlFor="acc-pd-oncall"><input type="checkbox" id="acc-pd-oncall" checked={d.oncallOnly} onChange={(e) => upd({ oncallOnly: e.target.checked })} />Only while on call</label>
        </div>
      </div>
      <div className="callout"><div className="kicker">Reads as</div><p className="acc-preview">{preview}</p></div>
      <div className="callout callout-warn acc-warn" role="status" hidden={!firsts.length}>
        {firsts.map((a) => {
          const losers = roles.filter((r) => matrix[r.id]?.[a] && !d.roles.includes(r.id)).map((r) => r.name);
          return (
            <p key={a}>
              <Icon name="alert" />{` This is the first narrowing policy for '${(actions.find((x) => x.id === a)?.name ?? a).toLowerCase()}'. Once saved, only the roles, projects and hours here allow it${losers.length ? `; ${losers.join(", ")} lose it everywhere else.` : "."}`}
            </p>
          );
        })}
      </div>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function usePolicyDialog(args: { perm: Decision; roles: Role[]; actions: Action[]; projects: Project[]; policies: Policy[]; matrix: Record<string, Record<string, boolean>> }) {
  const ui = useUI();
  return (existing: Policy | null) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: existing ? `Edit ${existing.id}` : "Add a policy", kicker: "Access · scoped policy", wide: true,
      sub: "Narrowing policies restrict an action to the roles, projects and hours listed: once one exists for an action, that action needs a matching policy. Extending policies add a right the role matrix does not grant.",
      body: (close) => <PolicyForm {...args} existing={existing} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: existing ? "Save policy" : "Add policy", kind: "primary", submit: true, id: "acc-pd-save", guard: args.perm, onClick: () => submit() }],
    });
  };
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue–Thu 10:00–16:00": days as a range when they run on, the hours as given, "always" for no window (as the prototype words it). */
function whenText(p: Policy, freezes: Freeze[] = []): string {
  if (p.effect === "deny" && p.where.freeze) {
    // The freeze policy reads as the freeze window itself ("Dec 20 – Jan 5"), from the freeze list; the next whole-factory freeze that has not ended.
    const f = freezes.filter((x) => x.repos === "all" && x.to > Date.now()).sort((a, b) => a.from - b.from)[0];
    return f ? `${shortDate(f.from)} – ${shortDate(f.to)}` : "while a freeze is active";
  }
  const w = p.when;
  let text = "always";
  if (w) {
    const d = [...w.days].sort((a, b) => a - b);
    const run = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
    const days = d.length === 7 ? "" : run ? `${DAY[d[0]!]}–${DAY[d[d.length - 1]!]}` : d.map((x) => DAY[x]).join(", ");
    const hours = w.from === "00:00" && w.to === "24:00" ? "" : `${w.from}–${w.to}`;
    text = [days, hours].filter(Boolean).join(" ") || "always";
  }
  return p.oncallOnly && text !== "always" ? `${text}, on call` : text;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (ms: number): string => { const d = new Date(ms + 330 * 60000); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
/** The projects a policy covers, by id, or "all". */
const scopeText = (p: Policy): string => (p.where.freeze || !p.where.projects?.length ? "all" : p.where.projects.join(", "));

/** The Policies card body: Policy (name + id), Roles, Scope, When, Effect and an On switch, as in the prototype. The policy name opens the editor. */
export function PolicyCards({ policies, hl, roles, onEdit, freezes = [] }: { policies: Policy[]; hl: string | null; roles: Role[]; onEdit: (p: Policy) => void; freezes?: Freeze[] }) {
  const ui = useUI();
  const outcome = useOutcome();
  const perm = useCan("policy.edit");
  const list = [...policies].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!list.length) return <Empty id="acc-policies-empty" title="No policies yet" text="Roles alone decide who can do what. Add a policy to narrow a right to certain hours or projects, or to extend it, for example while on call." />;
  const roleText = (p: Policy): string => (p.roles[0] === "*" || (roles.length > 1 && roles.every((r) => p.roles.includes(r.id))) ? "all" : p.roles[0] === "agents" ? "Agents" : p.roles.map((id) => roles.find((r) => r.id === id)?.name ?? id).join(", "));
  const anyCustom = list.some((p) => (p as Policy & { custom?: boolean }).custom);
  return (
    <DataTable
      id="acc-policies"
      caption="Policies"
      rows={list}
      rowKey={(p) => p.id}
      rowId={(p) => `acc-pol-${p.id}`}
      columns={[
        { key: "policy", label: "Policy", render: (p) => <><a className="rl" href="#edit" id={`acc-pol-edit-${p.id}`} onClick={(e) => { e.preventDefault(); if (SPECIAL[p.id]) ui.toast(SPECIAL[p.id]!, "info"); else onEdit(p); }}><b>{p.name}</b></a>{hl === p.id ? <span className="chip accent plain"> deciding rule</span> : null}<span className="mono dim" style={{ display: "block", fontSize: 11 }}>{p.id}</span></> },
        { key: "roles", label: "Roles", render: (p) => roleText(p) },
        { key: "scope", label: "Scope", render: (p) => scopeText(p) },
        { key: "when", label: "When", render: (p) => <span className="mono" title={p.oncallOnly ? "Only while on call" : undefined}>{whenText(p, freezes)}</span> },
        { key: "effect", label: "Effect", render: (p) => <span className={`chip ${p.effect === "deny" ? "bad" : "ok"}`}>{p.effect}</span> },
        { key: "on", label: "On", render: (p) => <Toggle id={`acc-pol-on-${p.id}`} checked={p.enabled} decision={perm} label={p.name} onChange={async (v) => void outcome(await ops.setPolicyEnabled(p.id, v, ifMatchOf(p)), `${v ? "Enabled" : "Disabled"} ${p.name}`)} /> },
        ...(anyCustom ? [{ key: "acts", label: "", align: "end" as const, render: (p: Policy) => ((p as Policy & { custom?: boolean }).custom ? <Btn label="Delete" small kind="ghost" id={`acc-pol-del-${p.id}`} guard={perm} onClick={async () => void outcome(await ops.deletePolicy(p.id, ifMatchOf(p)))} /> : null) }] : []),
      ]}
    />
  );
}
