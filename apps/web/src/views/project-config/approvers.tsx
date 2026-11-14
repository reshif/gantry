/** Project config: Approvers tab, rule editor and away dialog (legacy project-config.js approversTab, ruleEditor, awayDialog). */
import { useState } from "react";
import { DAY, fmt, flowOf, type ApproverCondition, type ApproverRule, type Catalog, type Person } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Dialog } from "../../ui/Overlay";
import { Btn, Field, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { GateDiamond, NumInput, classOf, gateState, projectRoles, roleName, useRes, type PView } from "../projects/kit";
import { membersOf, rolesIn, type PcProps } from "./ctx";
import { HistoryList } from "./history";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function isDirty(p: PView, drafts: Record<string, ApproverRule>, gid: string): boolean {
  return !!drafts[gid] && JSON.stringify(drafts[gid]) !== JSON.stringify(p.approvers[gid]);
}

function eligibleOf(p: PView, people: Person[], rule: ApproverRule): Person[] {
  return membersOf(people, p).filter((x) => {
    if (x.status !== "active") return false;
    const roles = rolesIn(x, p.id);
    return rule.people.includes(x.id) || rule.roles.some((r) => roles.includes(r));
  });
}

function AwayDialog({ p, cat, person, people, close }: { p: PView; cat: Catalog; person: Person; people: Person[]; close: () => void }) {
  const res = useRes();
  const d = useCan("approvers.edit", { project: p.id });
  const opts = membersOf(people, p).filter((x) => x.id !== person.id && x.status === "active");
  const [del, setDel] = useState(person.away?.delegate ?? opts[0]?.id ?? "");
  const [days, setDays] = useState("3");
  const [err, setErr] = useState("");
  return (
    <Dialog
      title={`${person.name} is away`} kicker={`Delegation · ${p.name}`} onClose={close} sub={`While away, the delegate may approve wherever ${person.name} could. Audited.`}
      actions={[{ label: "Cancel" }, {
        label: "Set delegation", kind: "primary", submit: true, id: "pcf-away-ok", guard: d,
        onClick: async () => {
          if (!del) return setErr("Pick a delegate.");
          const now = Date.now();
          const r = await ops.setAway(person.id, { from: now, to: now + parseInt(days, 10) * DAY, delegate: del }, p.id);
          res(r);
          if (r.ok) close();
          else setErr(r.msg);
        },
      }]}
      body={
        <div className="form-grid">
          <Field label="Delegate" htmlFor="pcf-away-del"><Select id="pcf-away-del" options={opts.map((x) => ({ value: x.id, label: `${x.name} · ${rolesIn(x, p.id).map((r) => roleName(cat, r)).join(", ")}` }))} value={del} onChange={setDel} /></Field>
          <Field label="Away for" htmlFor="pcf-away-days"><Select id="pcf-away-days" options={[{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }]} value={days} onChange={setDays} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
    />
  );
}

export function ApproversTab({ p, cat, people, s, set }: PcProps) {
  const d = useCan("approvers.edit", { project: p.id });
  const locked = !d.allowed;
  const fg = flowOf(cat, p).gates;
  const g = fg.find((x) => x.id === s.gate) ?? fg.find((x) => x.id === "G5") ?? fg[0];
  const actor = useActors();
  const name = (id: string) => actor(id).name.replace(" (agent)", "");
  if (!g) return null;
  return (
    <div className="pcf-stack">
      <LockNote decision={d} what="Approver rules" />
      <div className="pcf-ap">
        <Panel title="Gates" flush cls="pcf-ap-list">
          <ul className="pcf-gates" role="list">
            {fg.map((x) => {
              const r = p.approvers[x.id];
              const gs = gateState(p, x.id);
              const sum = x.mode === "auto" ? "Automatic checks" : x.id === "G0G1" ? "Submitter confirms" : r ? `${r.required} of ${r.roles.map((y) => roleName(cat, y)).concat(r.people.map(name)).join(", ") || "nobody"}${r.conditions.length ? ` · ${r.conditions.length} condition${r.conditions.length > 1 ? "s" : ""}` : ""}` : "No rule";
              return (
                <li key={x.id}>
                  <button type="button" id={`pcf-ap-g-${x.id}`} className={`pcf-gate-btn${x.id === g.id ? " is-sel" : ""}`} aria-current={x.id === g.id ? "true" : undefined} onClick={() => set({ gate: x.id })}>
                    <GateDiamond cat={cat} gateId={x.id} state={gs.state} count={gs.waiting || gs.failing} size="sm" />
                    <span className="pcf-gate-main">
                      <span>
                        <span className="mono">{x.label}</span>{` ${x.name}`}
                        {x.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
                        {isDirty(p, s.drafts, x.id) ? <span className="chip chip-warn">unsaved</span> : null}
                      </span>
                      <span className="muted small">{sum}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
        {g.mode === "auto" ? (
          <Panel title={`${g.label} ${g.name}`}>
            <div className="form-grid">
              <p>{g.purpose}</p>
              <p className="muted small">{`This gate is automatic in ${p.name}. It passes when its checks pass; nobody approves it. Change its mode on the Flow tab.`}</p>
              {g.checks.length ? <ul className="checklist">{g.checks.map((c) => <li key={c} className="ok">{c}</li>)}</ul> : <p className="muted small">No checks: it passes straight through.</p>}
            </div>
          </Panel>
        ) : (
          <RuleEditor key={`${p.id}:${g.id}`} p={p} cat={cat} people={people} gate={g} s={s} set={set} d={d} locked={locked} />
        )}
      </div>
    </div>
  );
}

function RuleEditor({ p, cat, people, gate: g, s, set, d, locked }: PcProps & { gate: ReturnType<typeof flowOf>["gates"][number]; d: ReturnType<typeof useCan>; locked: boolean }) {
  const ui = useUI();
  const res = useRes();
  const actor = useActors();
  const name = (id: string) => actor(id).name.replace(" (agent)", "");
  const gid = g.id;
  const saved = p.approvers[gid];
  const r: ApproverRule = s.drafts[gid] ?? clone(saved ?? { roles: [], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null });
  const dirty = isDirty(p, s.drafts, gid);
  const mem = membersOf(people, p);
  const elig = eligibleOf(p, people, r);
  const [err, setErr] = useState("");
  const [now] = useState(() => Date.now());
  const roles = projectRoles(cat);
  const upd = (fn: (x: ApproverRule) => void) => {
    const next = clone(r);
    fn(next);
    set({ drafts: { ...s.drafts, [gid]: next } });
  };
  const condText = (c: ApproverCondition): string => {
    const w = c.when.type === "class" ? (cat.classes.find((x) => x.id === c.when.value)?.name ?? c.when.value) : c.when.type === "path" ? `Changes under ${c.when.value}` : c.when.value === "high" ? "High-risk changes" : "Normal-risk changes";
    const needs = c.needs.roles.map((x) => roleName(cat, x)).concat(c.needs.people.map(name));
    return `${w} need${c.when.type === "class" ? "s" : ""} ${needs.join(" or ") || "an approver"}${c.needs.oncall ? " who is on call" : ""}`;
  };
  const addCond = (c: Omit<ApproverCondition, "id" | "text"> & { text?: string }) =>
    upd((x) => { const full = { ...c, id: `c${Date.now().toString(36)}${x.conditions.length}`, text: c.text ?? "" } as ApproverCondition; full.text = full.text || condText(full); x.conditions.push(full); });
  const people2 = people.filter((x) => x.status === "active");
  const save = async () => {
    if (gid !== "G0G1" && r.required < 1) return setErr("A human gate needs at least one approval.");
    if (!r.roles.length && !r.people.length) return setErr("Pick at least one role or named person.");
    if (r.required > elig.length) return setErr(`Needs ${r.required} approvals but only ${elig.length} eligible ${elig.length === 1 ? "person is" : "people are"} in ${p.name}.`);
    if (r.conditions.some((c) => !c.needs.roles.length && !c.needs.people.length)) return setErr("Every condition needs at least one role.");
    const prev = saved?.conditions ?? [];
    const out = clone(r);
    for (const c of out.conditions) {
      const o = prev.find((x) => x.id === c.id);
      const same = o && JSON.stringify(o.when) === JSON.stringify(c.when) && JSON.stringify(o.needs) === JSON.stringify(c.needs);
      if (!c.text || (o && !same)) c.text = condText(c);
    }
    const x = await ops.setProject(p.id, `approvers.${gid}`, out, { ifMatch: p.version });
    if (!x.ok) return setErr(x.msg);
    const next = { ...s.drafts };
    delete next[gid];
    set({ drafts: next });
    setErr("");
    ui.toast(`${g.label} approver rule saved.`, "ok");
  };
  const sc = s.scen;
  const paths = sc.path ? [sc.path] : [];
  const scConds = r.conditions.filter((c) => (c.when.type === "class" ? sc.cls === c.when.value : c.when.type === "risk" ? sc.risk === c.when.value : paths.some((x) => x.startsWith(c.when.value))));
  const away = elig.filter((x) => x.away && x.away.to > now);
  const classesOn = p.flow.classes.filter((c) => c.enabled !== false);
  const sodId = "pcf-ap-sod";
  return (
    <section className="panel pcf-rule" aria-label={`${g.label} approver rule`}>
      <div className="panel-head">
        <h2 className="panel-title"><span className="mono">{g.label}</span>{` ${g.name}`}</h2>
        {dirty ? <span className="chip chip-warn">Unsaved changes</span> : <span className="muted small mono">{`APR-${gid}`}</span>}
      </div>
      <div className="panel-body form-grid">
        <p className="small">{g.purpose}{r.note ? <span className="muted">{` ${r.note}`}</span> : null}</p>
        <fieldset className="pcf-fs">
          <legend className="sub-h">Who may approve</legend>
          <Field label={`Roles on ${p.name}`}>
            <div className="check-grid">
              {roles.map((ro) => {
                const id = `pcf-ap-role-${ro.id}`;
                return (
                  <label key={ro.id} className="check" htmlFor={id}>
                    <input type="checkbox" id={id} checked={r.roles.includes(ro.id)} disabled={locked} onChange={(e) => upd((x) => { x.roles = e.target.checked ? [...x.roles, ro.id] : x.roles.filter((y) => y !== ro.id); })} />
                    {ro.name}
                    {ro.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
                  </label>
                );
              })}
            </div>
          </Field>
          {mem.length ? (
            <Field label="Named people" hint="Named people may approve even without a listed role.">
              <div className="check-grid">
                {mem.map((x) => {
                  const id = `pcf-ap-person-${x.id}`;
                  return (
                    <label key={x.id} className="check" htmlFor={id}>
                      <input type="checkbox" id={id} checked={r.people.includes(x.id)} disabled={locked} onChange={(e) => upd((y) => { y.people = e.target.checked ? [...y.people, x.id] : y.people.filter((z) => z !== x.id); })} />
                      {x.name}
                    </label>
                  );
                })}
              </div>
            </Field>
          ) : null}
        </fieldset>
        <fieldset className="pcf-fs">
          <legend className="sub-h">How many</legend>
          <div className="pcf-nofm">
            <NumInput id="pcf-ap-required" value={r.required} min={1} max={9} locked={locked} label="Approvals required" onCommit={(v) => upd((x) => { x.required = v; })} />
            <span>{`of ${elig.length} eligible: `}</span>
            <span className="small">{elig.map((x) => x.name + (x.oncall ? " (on call)" : "") + (x.away && x.away.to > now ? " (away)" : "")).join(", ") || "nobody yet"}</span>
          </div>
          <div className="toggle-row">
            <label htmlFor={sodId}>Author cannot approve (separation of duties)</label>
            <Toggle id={sodId} checked={r.sod} decision={d} onChange={(v) => upd((x) => { x.sod = v; })} />
          </div>
        </fieldset>
        <fieldset className="pcf-fs">
          <legend className="sub-h">Conditions</legend>
          {r.conditions.length ? (
            <ol className="pcf-conds">
              {r.conditions.map((c, i) => {
                const idp = `pcf-ap-c${i}`;
                return (
                  <li key={c.id} className="pcf-cond">
                    <div className="pcf-cond-when">
                      <span className="kv-k">When</span>
                      <Select id={`${idp}-type`} aria-label="Condition type" disabled={locked} options={[{ value: "class", label: "Class is" }, { value: "path", label: "Path under" }, { value: "risk", label: "Risk is" }]} value={c.when.type}
                        onChange={(v) => upd((x) => { const y = x.conditions[i]!; y.when.type = v as ApproverCondition["when"]["type"]; y.when.value = v === "class" ? "hotfix" : v === "risk" ? "high" : "/payments"; y.text = condText(y); })} />
                      {c.when.type === "class" ? (
                        <Select id={`${idp}-val`} aria-label="Class" disabled={locked} options={classesOn.map((x) => ({ value: x.id, label: x.name }))} value={c.when.value} onChange={(v) => upd((x) => { const y = x.conditions[i]!; y.when.value = v; y.text = condText(y); })} />
                      ) : c.when.type === "risk" ? (
                        <Select id={`${idp}-val`} aria-label="Risk" disabled={locked} options={[{ value: "high", label: "High risk" }, { value: "normal", label: "Normal risk" }]} value={c.when.value} onChange={(v) => upd((x) => { const y = x.conditions[i]!; y.when.value = v; y.text = condText(y); })} />
                      ) : (
                        <input id={`${idp}-val`} className="input mono" defaultValue={c.when.value} disabled={locked} aria-label="Path prefix" placeholder="/payments" onBlur={(e) => { if (e.target.value.trim() !== c.when.value) upd((x) => { const y = x.conditions[i]!; y.when.value = e.target.value.trim() || "/"; y.text = condText(y); }); }} />
                      )}
                    </div>
                    <div className="pcf-cond-needs">
                      <span className="kv-k">Also needs</span>
                      {roles.filter((ro) => ro.id !== "viewer").map((ro) => {
                        const id = `${idp}-r-${ro.id}`;
                        return (
                          <label key={ro.id} className="check small" htmlFor={id}>
                            <input type="checkbox" id={id} checked={c.needs.roles.includes(ro.id)} disabled={locked} onChange={(e) => upd((x) => { const y = x.conditions[i]!; y.needs.roles = e.target.checked ? [...y.needs.roles, ro.id] : y.needs.roles.filter((z) => z !== ro.id); y.text = condText(y); })} />
                            {ro.name}
                          </label>
                        );
                      })}
                      <label className="check small" htmlFor={`${idp}-oncall`}>
                        <input type="checkbox" id={`${idp}-oncall`} checked={c.needs.oncall} disabled={locked} onChange={(e) => upd((x) => { const y = x.conditions[i]!; y.needs.oncall = e.target.checked; y.text = condText(y); })} />
                        who is on call
                      </label>
                    </div>
                    <div className="pcf-cond-foot">
                      <span className="small"><Icon name="chevron" />{` ${c.text || condText(c)}`}</span>
                      <Btn small kind="ghost" icon="x" id={`${idp}-del`} guard={d} label="Remove" onClick={() => upd((x) => { x.conditions.splice(i, 1); })} />
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted small">No conditions. Add one for classes, paths or risk that need extra approvers.</p>
          )}
          <div className="pcf-cond-add">
            <Btn small icon="plus" id="pcf-ap-add" guard={d} label="Add condition" onClick={() => addCond({ when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: false } })} />
            <Btn small kind="ghost" id="pcf-ap-add-hotfix" guard={d} label="Hotfix needs Release Manager + on-call" onClick={() => addCond({ when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: true } })} />
            <Btn small kind="ghost" id="pcf-ap-add-path" guard={d} label="Changes under /payments need Security" onClick={() => addCond({ when: { type: "path", value: "/payments" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "Changes under /payments need Security" })} />
          </div>
        </fieldset>
        <fieldset className="pcf-fs">
          <legend className="sub-h">Escalation and delegation</legend>
          <div className="form-row pcf-esc">
            <Field label="Escalate after (hours)" htmlFor="pcf-ap-esc" hint="0 means never.">
              <NumInput id="pcf-ap-esc" value={r.escalateH || 0} min={0} max={240} locked={locked} label="Escalate after hours" onCommit={(v) => upd((x) => { x.escalateH = v; })} />
            </Field>
            <Field label="Fallback approver" htmlFor="pcf-ap-fallback">
              <Select id="pcf-ap-fallback" disabled={locked} options={[{ value: "", label: `Project owner (${name(p.owner)})` }, ...people2.map((x) => ({ value: x.id, label: x.name }))]} value={r.fallback || ""} onChange={(v) => upd((x) => { x.fallback = v || null; })} />
            </Field>
          </div>
          <div className="pcf-deleg">
            <div className="small strong">Away and delegates</div>
            <ul className="plain-list">
              {elig.map((x) => {
                const isAway = !!x.away && x.away.to > now;
                return (
                  <li key={x.id} className="pcf-deleg-row">
                    <span>{x.name}</span>
                    <span className={`small ${isAway ? "warn-text" : "muted"}`}>{isAway ? `away until ${fmt.istDate(x.away!.to)}, ${name(x.away!.delegate ?? "")} approves instead` : "present"}</span>
                    <Btn small kind="ghost" id={`pcf-away-${x.id}`} guard={d} label={isAway ? "Change" : "Set away"} onClick={() => ui.open((close) => <AwayDialog p={p} cat={cat} person={x} people={people} close={close} />)} />
                    {isAway ? <Btn small kind="ghost" id={`pcf-away-clr-${x.id}`} guard={d} label="Clear" onClick={async () => res(await ops.setAway(x.id, null, p.id))} /> : null}
                  </li>
                );
              })}
            </ul>
            {away.length ? null : <p className="muted small">Nobody eligible is away.</p>}
          </div>
        </fieldset>
        <fieldset className="pcf-fs pcf-scen">
          <legend className="sub-h">Try a work order</legend>
          <div className="form-row">
            <Field label="Class" htmlFor="pcf-sc-cls"><Select id="pcf-sc-cls" options={classesOn.map((x) => ({ value: x.id, label: classOf(cat, p, x.id).name }))} value={sc.cls} onChange={(v) => set({ scen: { ...sc, cls: v } })} /></Field>
            <Field label="Risk" htmlFor="pcf-sc-risk"><Select id="pcf-sc-risk" options={["normal", "high"]} value={sc.risk} onChange={(v) => set({ scen: { ...sc, risk: v } })} /></Field>
            <Field label="Changed path" htmlFor="pcf-sc-path"><input id="pcf-sc-path" className="input mono" defaultValue={sc.path} placeholder="/payments/refunds" onBlur={(e) => set({ scen: { ...sc, path: e.target.value.trim() } })} /></Field>
          </div>
          <p className="small" aria-live="polite">
            {`${r.required} approval${r.required > 1 ? "s" : ""} from ${r.roles.map((x) => roleName(cat, x)).concat(r.people.map(name)).join(", ") || "nobody"}${r.sod ? ", not the author" : ""}${scConds.length ? `; plus: ${scConds.map(condText).join("; ")}` : "; no conditions apply"}.`}
          </p>
        </fieldset>
        <div className="form-err" role="alert">{err}</div>
        <div className="form-actions">
          <Btn kind="primary" icon="check" id="pcf-ap-save" guard={d} disabledReason={!locked && !dirty ? "No unsaved changes." : null} label={`Save ${g.label} rule`} onClick={() => void save()} />
          {dirty ? <Btn kind="ghost" id="pcf-ap-discard" label="Discard changes" onClick={() => { const next = { ...s.drafts }; delete next[gid]; set({ drafts: next }); setErr(""); }} /> : null}
        </div>
        <div className="sub-h">Rule history</div>
        <HistoryList type="gaterule" id={`${p.id}:${gid}`} project={p.id} limit={6} />
      </div>
    </section>
  );
}
