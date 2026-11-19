import { useState } from "react";
import { DAYS, type Action, type Person, type Policy, type Project, type Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useAccessMatrix } from "../../api/queries";
import { Btn, Chip, Field, FilterBar, LockNote, SearchBox, Segmented, Toggle, type Decision } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";
import { RELEASE_MANAGER } from "../../lib/roles";
import { CountClear, setQS, useQS } from "../govern/kit";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ifMatchOf, lockd, useOutcome, usePolicyWording, versionOf } from "../govern/data";

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
  return { id: "NEW", name: "", effect: "allow", enabled: true, roles: [RELEASE_MANAGER], actions: ["release"], where: { projects: [] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false, extend: false, custom: true };
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

export function PolicyTable({ policies, people, onEdit, onSimulate }: { policies: Policy[]; people: Person[]; onEdit: (p: Policy | null) => void; onSimulate: (p: Policy, who: Person | undefined) => void }) {
  const outcome = useOutcome();
  const perm = useCan("policy.edit");
  const ui = useUI();
  const wording = usePolicyWording();
  const roleList = useAccessMatrix().data?.roles ?? [];
  const roleName = (id: string) => roleList.find((x) => x.id === id)?.name ?? id;
  const [q, setQ] = useQS("acc.pq");
  const s = q.trim().toLowerCase();
  const list = [...policies].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((p) => !s || p.name.toLowerCase().includes(s));
  const clear = () => setQS({ "acc.pq": "" });
  return (
    <div>
      <FilterBar label="Filter policies" count={<CountClear n={list.length} of={policies.length} noun="policy" many="policies" active={!!q} onClear={clear} />}>
        <SearchBox id="acc-pol-q" value={q} onChange={setQ} placeholder={"Search\u2026"} label="Search policy" />
      </FilterBar>
      <DataTable<Policy>
        id="acc-policies"
        caption="Conditional policies"
        rows={list}
        rowKey={(p) => p.id}
        rowId={(p) => `acc-pol-${p.id}`}
        empty={policies.length ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="acc-pol-clear" onClick={clear} /> } : { title: "No policies yet", text: "Roles alone decide who can do what. Add a policy to narrow a right to certain hours or projects, or to extend it." }}
        columns={[
          { key: "n", label: "Policy", render: (p) => {
            const proj = p.where.projects?.[0] ?? "";
            const who = people.find((x) => x.status === "active" && x.roles.some((g) => p.roles.includes(g.role) && (g.scope === "factory" || g.scope === proj || !p.where.projects?.length)));
            const custom = (p as Policy & { custom?: boolean }).custom;
            return (
              // Static in the prototype: no visible control. Policy administration stays on the cell's context menu (right click).
              <div onContextMenu={(e) => { e.preventDefault(); ui.menu(e.currentTarget, p.name, [
                { label: "Edit policy", icon: "page", guard: !perm.allowed ? perm : SPECIAL[p.id] ? lockd(SPECIAL[p.id]!) : null, onClick: () => onEdit(p) },
                { label: "Simulate", icon: "play", onClick: () => onSimulate(p, who) },
                ...(custom ? [{ label: "Delete policy", icon: "x", kind: "danger", guard: perm, onClick: () => void ouDelete(p) }] : []),
                { sep: true },
                { label: "Add policy", icon: "plus", guard: perm, onClick: () => onEdit(null) },
              ]); }}>
                <b>{p.name}</b><span className="sub">{`${p.effect} ${p.actions.join(", ")} for ${p.roles.length ? p.roles.map(roleName).join(", ") : "everyone"}`}</span>
              </div>
            );
          } },
          { key: "w", label: "Where", render: (p) => (p.where.projects?.length ? wording.where(p) : "Everywhere") },
          { key: "t", label: "When", render: (p) => (p.when ? `${p.when.from}\u2013${p.when.to}, days ${p.when.days.join("")}` : "Always") },
          { key: "e", label: "Effect", render: (p) => <Chip text={p.effect} cls={p.effect === "allow" ? "ok" : "bad"} /> },
          { key: "on", label: "On", render: (p) => <Toggle id={`acc-pol-on-${p.id}`} checked={p.enabled} decision={perm} label="Enabled" onChange={async (v) => void outcome(await ops.setPolicyEnabled(p.id, v, ifMatchOf(p)), `${p.name} ${v ? "on" : "off"}`)} /> },
        ]}
      />
    </div>
  );
  async function ouDelete(p: Policy) {
    outcome(await ops.deletePolicy(p.id, ifMatchOf(p)));
  }
}
