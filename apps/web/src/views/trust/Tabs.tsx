/** Proposals, demotions and policy tabs (legacy proposalsTab, demotionsTab, policyTab). */
import { useState } from "react";
import { fmt, type Project, type TrustCeiling, type TrustProposal, type WorkOrder } from "@gantry/domain";
import { useCan, useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import { useWorkOrders } from "../../api/queries";
import { Btn, Chip, Empty, Field, LockNote, Panel, Segmented, Select, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { useOutcome } from "../govern/data";
import { LevelChip, ProposalButtons, cellLabel, type LadderProps } from "./Ladder";
import { code, lv, pct, rerender, trustFocus, trustUi, type CellOut } from "./kit";

/* ---------------- proposals ---------------- */

const STATUS_CHIP: Record<string, string> = { accepted: "ok", approved: "ok", declined: "plain", withdrawn: "plain" };

export function ProposalsTab({ p, cells, proposals }: { p: LadderProps; cells: CellOut[]; proposals: TrustProposal[] }) {
  const who = useActors();
  const byId = new Map(cells.map((c) => [c.id, c]));
  const all = proposals.filter((x) => byId.has(x.cell)).slice().reverse();
  const pending = all.filter((x) => x.status === "pending");
  const decided = all.filter((x) => x.status !== "pending");
  const projName = (id: string): string => p.projects.find((x) => x.id === id)?.name ?? id;
  return (
    <div className="tr-props stack">
      <Panel title="Promotion proposals" flush>
        {pending.length ? (
          <ul className="list tr-prop-list">
            {pending.map((x) => {
              const cell = byId.get(x.cell)!;
              return (
                <li key={x.id} id={`tr-prop-${x.id}`} className={trustUi.hiProposal === x.id ? "is-hi" : undefined}>
                  <div className="grow">
                    <div className="row"><b>{p.agentName(cell.agent)}</b><LevelChip level={x.from} /><Icon name="right" /><LevelChip level={x.to} /><span className="small muted">{`${p.clsName(cell.cls)} · ${projName(cell.project)}`}</span></div>
                    <div className="small">{x.evidence.note || ""}</div>
                    <div className="small muted">{`${x.evidence.cleanRuns} clean runs · eval ${pct(x.evidence.evalScore)} · saves ~${x.savedPerWeek || 0} approvals a week`}</div>
                    {!cell.meets.ok && cell.meets.next === x.to && cell.meets.missing.length ? <div className="small warn-text">{`Since proposed: ${cell.meets.missing.join(", ")}.`}</div> : null}
                  </div>
                  <ProposalButtons prop={x} cell={cell} p={p} />
                </li>
              );
            })}
          </ul>
        ) : <Empty id="tr-props-empty" title="No proposals pending" text="An agent is proposed when it meets the criteria for the next level." />}
      </Panel>
      {decided.length ? (
        <Panel title="Decided" flush>
          <ul className="list">
            {decided.map((x) => {
              const cell = byId.get(x.cell)!;
              return (
                <li key={x.id} id={`tr-prop-${x.id}`}>
                  <div className="grow">{`${p.agentName(cell.agent)} L${x.from} → L${x.to}`}</div>
                  <Chip text={x.status} cls={STATUS_CHIP[x.status] ?? "plain"} />
                  <span className="small muted">{`${x.by ? who(x.by).name : ""}${x.decidedAt ? ` · ${fmt.ago(x.decidedAt, Date.now())}` : ""}${x.reason ? ` · ${x.reason}` : ""}`}</span>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/* ---------------- demotions ---------------- */

function OutcomeDialog({ cells, projects, onDone }: { cells: CellOut[]; projects: Project[]; onDone: () => void }) {
  const out = useOutcome();
  const projectIds = [...new Set(cells.map((c) => c.project))];
  const [project, setProject] = useState(trustUi.project && projectIds.includes(trustUi.project) ? trustUi.project : projectIds[0] ?? "");
  const q = useWorkOrders(project, { state: "done", limit: 60 });
  const list = ((q.data ? (Array.isArray(q.data) ? q.data : q.data.items) : []) as WorkOrder[]).filter((w) => w.state === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const [wo, setWo] = useState("");
  const [kind, setKind] = useState("incident");
  const [att, setAtt] = useState("agent");
  const [station, setStation] = useState("spec");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const perm = useCan("outcome.record", { project });
  const pick = wo || list[0]?.id || "";
  const w = list.find((x) => x.id === pick);
  const hit = w ? cells.filter((c) => c.project === w.project && c.cls === w.cls && c.level >= 2 && (att === "agent")) : [];
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Post-release outcomes" />
      <Field label="Project" htmlFor="tr-out-project"><Select id="tr-out-project" value={project} options={projectIds.map((id) => ({ value: id, label: projects.find((x) => x.id === id)?.name ?? id }))} onChange={(v) => { setProject(v); setWo(""); }} /></Field>
      {list.length ? (
        <>
          <Field label="Shipped work order" htmlFor="tr-out-wo"><Select id="tr-out-wo" value={pick} options={list.map((x) => ({ value: x.id, label: `${x.id} · ${x.cls} · ${x.title.slice(0, 50)}` }))} onChange={setWo} /></Field>
          <div className="form-row">
            <Field label="Kind" htmlFor="tr-out-kind"><Select id="tr-out-kind" value={kind} options={[{ value: "incident", label: "Incident" }, { value: "revert", label: "Revert" }, { value: "followup", label: "Follow-up (a record only)" }]} onChange={setKind} /></Field>
            <Field label="Attributed to" htmlFor="tr-out-att"><Select id="tr-out-att" value={att} options={[{ value: "agent", label: "The agent" }, { value: "spec", label: "The spec" }, { value: "environment", label: "The environment" }, { value: "unrelated", label: "Unrelated" }]} onChange={setAtt} /></Field>
          </div>
          {att === "agent" ? <Field label="At the work of" htmlFor="tr-out-station" hint="The station whose agent is at fault."><Select id="tr-out-station" value={station} options={["intake", "research", "spec", "design", "plan", "build", "verify", "review", "close"].map((s) => ({ value: s, label: s }))} onChange={setStation} /></Field> : null}
          <Field label="What happened" htmlFor="tr-out-text"><textarea id="tr-out-text" className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <p className="small" id="tr-out-impact">{kind !== "followup" && att === "agent" ? (hit.length ? `Would drop ${hit.length} cell${hit.length === 1 ? "" : "s"} for this class to L1 if they are at that agent: ${hit.map((c) => `${c.agent} ${code(c.level)}`).join(", ")}.` : "No cell for this class is at L2 or above, so nothing drops.") : "Nothing drops: only a revert or incident attributed to the agent lowers a cell."}</p>
        </>
      ) : <Empty title="No shipped work you can act on" text="Pick a project with shipped work. You need 'Record post-release outcomes' there." />}
      <div className="form-err" role="alert">{err}</div>
      <div className="dlg-actions-inline">
        <Btn label="Record outcome" kind="danger" id="tr-out-ok" guard={!list.length ? { allowed: false, needs: "", reason: "No shipped work order to use." } : perm}
          onClick={() => { void ops.recordOutcome(pick, { kind, text, attribution: att === "agent" ? { station } : att }).then((r) => { if (!r.ok) { setErr(r.msg); return; } out(r); trustUi.demoFilter = "all"; onDone(); }); }} />
      </div>
    </div>
  );
}

export function DemotionsTab({ cells, projects, p }: { cells: CellOut[]; projects: Project[]; p: LadderProps }) {
  const ui_ = useUI();
  const list: Array<{ cell: CellOut; e: CellOut["history"][number] }> = [];
  for (const c of cells) for (const e of c.history || []) if (e.kind === "demote" || (e.kind === "grant" && e.from != null && e.to < e.from)) list.push({ cell: c, e });
  list.sort((a, b) => b.e.at - a.e.at);
  const types: Record<string, string> = { all: "All", revert: "Revert", incident: "Incident", guardrail: "Guardrail", security: "Security finding", failures: "Failures", manual: "By a person" };
  const typeOf = (d: (typeof list)[number]): string => (d.e.cause ? d.e.cause.type : d.e.by === "system" ? "system" : "manual");
  const shown = list.filter((d) => trustUi.demoFilter === "all" || typeOf(d) === trustUi.demoFilter);
  const projectIds = [...new Set(cells.map((c) => c.project))];
  const perms = useCanMany(projectIds.map((id) => ({ action: "outcome.record", project: id })));
  const anyOutcome = perms.some((x) => x.allowed);
  const dec: Decision | null = anyOutcome ? null : perms[0] ?? null;
  return (
    <div className="tr-demos">
      <Panel title="Demotions" flush tools={<Btn label="Record a post-release outcome" small icon="alert" id="tr-rec-outcome" guard={dec} onClick={() => ui_.dialog({ title: "Record a post-release outcome", kicker: "Trust · outcomes", sub: "Recorded on the shipped work order with your name and what it is attributed to. An attributed revert or incident lowers the agent's cells for that class and project to L1 at once. Audited.", wide: true, body: (close) => <OutcomeDialog cells={cells} projects={projects} onDone={close} />, actions: [{ label: "Close" }] })} />}>
        <div style={{ padding: "10px 14px 0" }}>
          <Segmented name="tr-demof" items={Object.keys(types).map((k) => ({ id: k, label: types[k]! }))} value={trustUi.demoFilter} onChange={(v) => { trustUi.demoFilter = v; rerender(); }} label="Filter demotions by cause" />
          <p className="small muted">Automatic rules: a revert or incident attributed to the agent drops its cells for that class and project to L1; a guardrail breach or security finding does the same; two failures in the last ten reviewed runs drop a cell one level. Nothing outside these rules lowers a cell except a person.</p>
        </div>
        {shown.length ? (
          <ul className="list" id="tr-demo-table">
            {shown.map((d) => (
              <li key={`${d.cell.id}@${d.e.at}`}>
                <div className="grow">
                  <button type="button" className="linkish strong" id={`tr-demo-${d.cell.id.replace(/\W/g, "-")}-${d.e.at}`} title={cellLabel(d.cell, p)} onClick={() => trustFocus({ cell: d.cell.id }, cells, [])}>{d.cell.id}</button>
                  <div className="small muted">{d.e.reason}</div>
                </div>
                <Chip text={`L${d.e.from ?? 0} → L${d.e.to}`} cls="bad" />
                <span className="small muted">{fmt.ago(d.e.at, Date.now())}</span>
              </li>
            ))}
          </ul>
        ) : <Empty title="No demotions" text="Cells are demoted by people or by an incident." />}
      </Panel>
    </div>
  );
}

/* ---------------- policy: switch, ceilings, criteria, sampling ---------------- */

function CeilingDialog({ c, p, projects, onDone }: { c: (TrustCeiling & { version?: number }) | null; p: LadderProps; projects: Project[]; onDone: () => void }) {
  const out = useOutcome();
  const perm = useCan("trust.criteria");
  const [text, setText] = useState(c?.text ?? "");
  const [reg, setReg] = useState(!!c?.when.regulated);
  const [cls, setCls] = useState(c?.when.cls ?? "");
  const [proj, setProj] = useState(c?.when.project ?? "");
  const [gate, setGate] = useState(c?.when.gate ?? "");
  const [max, setMax] = useState(String(c?.max ?? 2));
  const [err, setErr] = useState("");
  const off = !perm.allowed;
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Ceilings" />
      <Field label="Rule in words" htmlFor="tr-cd-text"><input id="tr-cd-text" className="input" placeholder="e.g. Data Platform hotfixes stay at L1" value={text} disabled={off} onChange={(e) => setText(e.target.value)} /></Field>
      <label className="check" htmlFor="tr-cd-reg"><input type="checkbox" id="tr-cd-reg" checked={reg} disabled={off} onChange={(e) => setReg(e.target.checked)} />Only regulated projects</label>
      <div className="form-row">
        <Field label="Class" htmlFor="tr-cd-cls"><Select id="tr-cd-cls" value={cls} disabled={off} options={[{ value: "", label: "Any class" }, ...p.cat.classes.map((x) => ({ value: x.id, label: x.name }))]} onChange={setCls} /></Field>
        <Field label="Project" htmlFor="tr-cd-proj"><Select id="tr-cd-proj" value={proj} disabled={off} options={[{ value: "", label: "Any project" }, ...projects.filter((x) => x.status !== "archived").map((x) => ({ value: x.id, label: x.name }))]} onChange={setProj} /></Field>
      </div>
      <div className="form-row">
        <Field label="Gate" htmlFor="tr-cd-gate"><Select id="tr-cd-gate" value={gate} disabled={off} options={[{ value: "", label: "Any gate" }, ...p.cat.gates.filter((g) => g.id !== "G0G1").map((g) => ({ value: g.id, label: `${g.label} ${g.name}` }))]} onChange={setGate} /></Field>
        <Field label="Maximum level" htmlFor="tr-cd-max"><Select id="tr-cd-max" value={max} disabled={off} options={[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: `${code(n)} ${lv(n).name}` }))} onChange={setMax} /></Field>
      </div>
      <div className="form-err" role="alert">{err}</div>
      <div className="dlg-actions-inline">
        <Btn label="Save ceiling" kind="primary" id="tr-cd-ok" guard={perm} onClick={() => {
          const when: Record<string, unknown> = {};
          if (reg) when.regulated = true;
          if (cls) when.cls = cls;
          if (proj) when.project = proj;
          if (gate) when.gate = gate;
          void ops.saveCeiling({ ...(c ? { id: c.id } : {}), text, when, max: Number(max), enabled: c ? c.enabled !== false : true }, { ifMatch: c?.version ?? 0 }).then((r) => { if (!r.ok) { setErr(r.msg); return; } out(r); onDone(); });
        }} />
      </div>
    </div>
  );
}

function CriteriaRow({ level, p }: { level: number; p: LadderProps & { criteriaVersion: number } }) {
  const out = useOutcome();
  const perm = useCan("trust.criteria");
  const c = p.criteria[String(level)]!;
  const [d, setD] = useState<Record<string, number>>({});
  const inp = (k: "cleanRuns" | "evalMin" | "reworkMax" | "incidentsMax" | "windowD", pctMode = false) => (
    <input id={`tr-crit-${level}-${k}`} className="input mono tr-num" type="number" min="0" step="1" value={String(k in d ? (pctMode ? Math.round(d[k]! * 100) : d[k]) : pctMode ? Math.round(c[k] * 100) : c[k])} disabled={!perm.allowed} aria-label={`${code(level)} ${k}`}
      onChange={(e) => setD((x) => ({ ...x, [k]: pctMode ? Number(e.target.value) / 100 : Number(e.target.value) }))} />
  );
  return (
    <tr>
      <th scope="row"><LevelChip level={level} /></th>
      <td>{inp("cleanRuns")}</td><td>{inp("evalMin", true)}</td><td>{inp("reworkMax", true)}</td><td>{inp("windowD")}</td><td>{inp("incidentsMax")}</td>
      <td><Btn label={`Save ${code(level)}`} small id={`tr-crit-save-${level}`} guard={perm} onClick={() => {
        if (!Object.keys(d).length) { out({ ok: true, msg: "Nothing changed.", status: 200 } as never, "Nothing changed."); return; }
        void ops.setTrustCriteria(level, d, { ifMatch: p.criteriaVersion }).then((r) => { out(r); if (r.ok) setD({}); });
      }} /></td>
    </tr>
  );
}

export function PolicyTab({ p, projects }: { p: LadderProps & { criteriaVersion: number }; cells: CellOut[]; projects: Project[] }) {
  const ui_ = useUI();
  const out = useOutcome();
  const perm = useCan("trust.criteria");
  const [sr, setSr] = useState<string | null>(null);
  const ceilings = ((p as unknown as { ceilings?: Array<TrustCeiling & { version?: number }> }).ceilings ?? []);
  const openCeiling = (c: (TrustCeiling & { version?: number }) | null) => ui_.dialog({ title: c ? `Edit ${c.id}` : "Add ceiling", kicker: "Trust · policy", sub: "Cells that match every condition you set are capped at the maximum. Saved and audited.", body: (close) => <CeilingDialog c={c} p={p} projects={projects} onDone={close} />, actions: [{ label: "Close" }] });
  const toggleSwitch = () => {
    if (p.switchOn) {
      ui_.confirm({ title: "Turn trust levels above L1 off?", body: "Every gate waits for a person again. Recorded levels stay as they are.", ok: "Turn off", kind: "danger" }).then((yes) => { if (yes) void ops.setTrustSwitch(false).then((r) => out(r)); });
    } else {
      ui_.reasonDialog({ title: "Turn trust levels above L1 on", kicker: "Trust · policy", sub: "Cells at L2 and L3 will pass gates without a person (L2 reviews a sample; L3 still reviews a random sample of at least 1 in 10). Risk-tagged changes, work with text from outside the organisation, the merge and release always need a person. Audited.", label: "Reason (required)", ok: "Turn on", min: 4, guard: perm, onOk: async (t) => out(await ops.setTrustSwitch(true, t)) });
    }
  };
  const levels = Object.keys(p.criteria).map(Number).sort((a, b) => a - b);
  return (
    <div className="tr-policy stack">
      <LockNote decision={perm} what="Trust policy" />
      <div className="cols">
        <Panel title="Criteria for each level" flush>
          <p className="small muted" style={{ padding: "10px 14px 0" }}>{`What a cell must show before the system proposes the level. Eval min and rework max are percentages. A change publishes version ${p.criteriaVersion + 1}; earlier versions stay on record.`}</p>
          <div className="tw">
            <table className="tbl tr-crit-t">
              <thead><tr>{["Level", "Clean runs", "Eval min", "Rework max", "Window (d)", "Incidents max", ""].map((x, i) => <th key={i} scope="col">{x}</th>)}</tr></thead>
              <tbody>{levels.map((L) => <CriteriaRow key={`${L}-${p.criteriaVersion}`} level={L} p={p} />)}</tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Ceilings" tools={<Btn label="Add ceiling" small icon="plus" id="tr-ceil-add" guard={perm} onClick={() => openCeiling(null)} />}>
          <div id="tr-ceilings">
            {ceilings.map((c) => (
              <div key={c.id} className={`row tr-ceil-row${c.enabled === false ? " is-off" : ""}`} style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
                <span><span>{c.text}</span><span className="sub muted small" style={{ display: "block" }}>{`Max level L${c.max}`}</span></span>
                <span className="row">
                  <Btn label="Edit" small kind="ghost" id={`tr-ceil-edit-${c.id}`} aria={`Edit ${c.id}`} guard={perm} onClick={() => openCeiling(c)} />
                  <Btn label="Remove" small kind="ghost" id={`tr-ceil-rm-${c.id}`} aria={`Remove ${c.id}`} guard={perm} onClick={() => ui_.reasonDialog({ title: `Remove ${c.id}`, sub: `${c.text}. Cells it capped may run at their granted level again.`, label: "Reason", ok: "Remove", kind: "danger", min: 4, guard: perm, onOk: async () => out(await ops.removeCeiling(c.id, { ifMatch: c.version ?? 0 })) })} />
                  <Toggle id={`tr-ceil-on-${c.id}`} checked={c.enabled !== false} decision={perm} label={`Enforce ${c.id}`} onChange={(v) => { void ops.saveCeiling({ ...c, enabled: v }, { ifMatch: c.version ?? 0 }).then((r) => out(r)); }} />
                </span>
              </div>
            ))}
            {!ceilings.length ? <p className="small muted">No ceilings. Every cell can run at the level it was granted.</p> : null}
          </div>
        </Panel>
      </div>
      <div className="cols">
        <Panel title="Levels above L1">
          <div className="tr-switch">
            <Toggle id="tr-switch" checked={p.switchOn} decision={perm} label="Trust levels above L1" onChange={toggleSwitch} />
            <div>
              <strong>{p.switchOn ? "On" : "Off (the default in a new install)"}</strong>
              <p className="small muted">L0 and L1 are always enforced: a person decides every gate. L2 and L3 are built but stay switched off until there is enough evidence. While off, a cell's recorded level above L1 does nothing, no promotion is proposed and a level above L1 cannot be granted. L4 cannot be granted in this version.</p>
            </div>
          </div>
        </Panel>
        <Panel title="L2 spot checks">
          <div className="tr-sample">
            <label htmlFor="tr-sample" className="small">A person reviews one in</label>
            <input id="tr-sample" className="input mono tr-num" type="number" min="2" max="50" value={sr ?? String(p.sampleRate)} disabled={!perm.allowed} aria-label="Spot-check one in" onChange={(e) => setSr(e.target.value)} />
            <span className="small">gate decisions at L2. The pick is a random draw made after the run finishes, and recorded. At L3 at least one in ten is still reviewed.</span>
            <Btn label="Save" small id="tr-sample-save" guard={perm} onClick={() => { void ops.setSampleRate(Number(sr ?? p.sampleRate), { ifMatch: p.criteriaVersion }).then((r) => { out(r); if (r.ok) setSr(null); }); }} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
