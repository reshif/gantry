/** Proposals, demotions and policy tabs (legacy proposalsTab, demotionsTab, policyTab). */
import { useState } from "react";
import { fmt, type Catalog, type Project, type TrustCeiling, type TrustProposal, type WorkOrder } from "@gantry/domain";
import { useCan, useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import { useWorkOrders } from "../../api/queries";
import { openRecordRoute } from "../../lib/router";
import { Btn, Empty, Field, LockNote, Panel, Segmented, Select, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { useOutcome } from "../govern/data";
import { DataTable } from "../projects/kit";
import { ProposalButtons, cellLabel, type LadderProps } from "./Ladder";
import { KV, LevelTag, MIN_RUNS, code, gateForAgent, lv, pct, rerender, trustFocus, trustUi, type CellOut } from "./kit";

/* ---------------- proposals ---------------- */

export function ProposalsTab({ p, cells, proposals }: { p: LadderProps; cells: CellOut[]; proposals: TrustProposal[] }) {
  const vis = new Set(cells.map((c) => c.id));
  const all = proposals.filter((x) => vis.has(x.cell)).slice().reverse();
  const pending = all.filter((x) => x.status === "pending");
  const list = trustUi.propFilter === "pending" ? pending : all;
  return (
    <div className="tr-props">
      <div className="toolbar">
        <Segmented name="tr-propf" items={[{ id: "pending", label: `Pending (${pending.length})` }, { id: "all", label: `All (${all.length})` }]} value={trustUi.propFilter} onChange={(v) => { trustUi.propFilter = v; rerender(); }} label="Show proposals" />
        <span className="small muted">The system proposes a promotion when a cell meets the criteria for its next level, and only while levels above L1 are on. A permitted person approves or declines; both need a reason.</span>
      </div>
      {list.length ? <ul className="tr-prop-list">{list.map((x) => <PropCard key={x.id} prop={x} cell={cells.find((c) => c.id === x.cell)!} p={p} cells={cells} proposals={proposals} />)}</ul>
        : <div className="empty empty-state" id="tr-props-empty"><div className="empty-icon" aria-hidden="true"><Icon name="trust" /></div><div className="empty-title">{trustUi.propFilter === "pending" ? "No promotions waiting" : "No proposals yet"}</div><p>Proposals appear when a cell's clean streak, eval score and incident record meet the next level's criteria.</p></div>}
    </div>
  );
}

function PropCard({ prop, cell, p, cells, proposals }: { prop: TrustProposal; cell: CellOut; p: LadderProps; cells: CellOut[]; proposals: TrustProposal[] }) {
  const who = useActors();
  if (!cell) return null;
  const m = cell.meets;
  const ev = cell.evidence;
  const st = ({ pending: "Pending", accepted: "Approved", declined: "Declined", withdrawn: "Withdrawn" } as Record<string, string>)[prop.status] ?? prop.status;
  return (
    <li className={`panel tr-prop is-${prop.status}${trustUi.hiProposal === prop.id ? " is-hi" : ""}`} id={`tr-prop-${prop.id}`}>
      <div className="tr-prop-top">
        <span className="mono strong">{prop.id}</span><span className={`chip tr-pst tr-pst-${prop.status}`}>{st}</span>
        <button type="button" className="linkish strong" id={`tr-prop-cell-${prop.id}`} onClick={() => trustFocus({ cell: cell.id }, cells, proposals)}>{cellLabel(cell, p)}</button>
        <span className="tr-prop-move"><LevelTag level={prop.from} /><span aria-hidden="true"> → </span><span className="sr-only"> to </span><LevelTag level={prop.to} /></span>
        <span className="small muted">{`proposed ${fmt.ago(prop.at, Date.now())}`}</span>
      </div>
      <dl className="tr-kv tr-prop-kv">
        <KV k="Clean streak" v={<span className="mono">{prop.evidence.cleanRuns}</span>} />
        <KV k="Finished on record" v={<span className="mono">{ev.runs}</span>} extra={ev.runs < MIN_RUNS ? <span className="small muted"> small sample</span> : null} />
        <KV k="Eval score" v={<span className="mono">{pct(prop.evidence.evalScore)}</span>} />
        <KV k="Saves" v={<span className="mono">{`${prop.savedPerWeek || 0} approvals / week`}</span>} />
        <KV k="Ceiling" v={<span className={`mono${prop.to > cell.ceiling.max ? " neg" : ""}`}>{`≤ ${code(cell.ceiling.max)}`}</span>} extra={prop.to > cell.ceiling.max ? <span className="small neg"> blocks this promotion</span> : null} />
      </dl>
      <p className="small">{prop.evidence.note || ""}{prop.status === "pending" && !m.ok && m.next === prop.to ? <span className="warn-text">{` Since proposed: ${m.missing.join(", ")}.`}</span> : null}</p>
      {prop.status === "pending" ? <div className="tr-prop-acts"><ProposalButtons prop={prop} cell={cell} p={p} /></div>
        : <p className="small muted">{`${st}${prop.by ? ` by ${who(prop.by).name}` : ""}${prop.decidedAt ? ` ${fmt.ago(prop.decidedAt, Date.now())}` : ""}${prop.reason ? `: ${prop.reason}` : ""}`}</p>}
    </li>
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
  const who = useActors();
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
      <div className="toolbar">
        <Segmented name="tr-demof" items={Object.keys(types).map((k) => ({ id: k, label: types[k]! }))} value={trustUi.demoFilter} onChange={(v) => { trustUi.demoFilter = v; rerender(); }} label="Filter demotions by cause" />
        <Btn label="Record a post-release outcome" icon="alert" id="tr-rec-outcome" guard={dec} onClick={() => ui_.dialog({ title: "Record a post-release outcome", kicker: "Trust · outcomes", sub: "Recorded on the shipped work order with your name and what it is attributed to. An attributed revert or incident lowers the agent's cells for that class and project to L1 at once. Audited.", wide: true, body: (close) => <OutcomeDialog cells={cells} projects={projects} onDone={close} />, actions: [{ label: "Close" }] })} />
      </div>
      <p className="small muted">Automatic rules: a revert or incident attributed to the agent drops its cells for that class and project to L1; a guardrail breach or security finding does the same; two failures in the last ten reviewed runs drop a cell one level. Nothing outside these rules lowers a cell except a person.</p>
      <DataTable id="tr-demo-table" caption="Trust demotions" rows={shown} rowKey={(d) => `${d.cell.id}@${d.e.at}`} empty={{ title: "No demotions", text: "Cells drop a level automatically after an attributed revert or incident, a guardrail breach or a security finding." }}
        columns={[
          { key: "at", label: "When", render: (d) => <span className="mono small">{fmt.stamp(d.e.at)}</span> },
          { key: "cell", label: "Cell", render: (d) => <button type="button" className="linkish" id={`tr-demo-${d.cell.id.replace(/\W/g, "-")}-${d.e.at}`} onClick={() => trustFocus({ cell: d.cell.id }, cells, [])}>{cellLabel(d.cell, p)}</button> },
          { key: "move", label: "Change", render: (d) => <span className="mono">{`${code(d.e.from ?? 0)} ▼ ${code(d.e.to)}`}</span> },
          { key: "cause", label: "Cause", render: (d) => { const t = typeOf(d); return <span className={`tr-cause tr-cause-${t}`}><Icon name={t === "guardrail" || t === "security" ? "shield" : t === "manual" ? "human" : "alert"} />{types[t] ?? t}{d.e.cause && d.e.cause.wo ? <span>{" "}<button type="button" className="chip entity-chip" onClick={() => openRecordRoute(d.e.cause!.wo!)}>{d.e.cause.wo}</button></span> : null}</span>; } },
          { key: "reason", label: "Reason", render: (d) => <span className="small">{d.e.reason}</span> },
          { key: "by", label: "By", hideSmall: true, render: (d) => <span className="small">{who(d.e.by).name}</span> },
        ]} />
    </div>
  );
}

/* ---------------- policy: switch, ceilings, criteria, sampling ---------------- */

const whenText = (w: TrustCeiling["when"], p: LadderProps, cat: Catalog): string => {
  const parts: string[] = [];
  if (w.regulated) parts.push("regulated projects");
  if (w.cls) parts.push(p.clsName(w.cls));
  if (w.project) parts.push(p.projects.find((x) => x.id === w.project)?.name ?? w.project);
  if (w.gate) parts.push(`gate ${cat.gates.find((g) => g.id === w.gate)?.label ?? w.gate}`);
  return parts.join(" · ") || "everywhere";
};

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
      <th scope="row"><LevelTag level={level} /></th>
      <td>{inp("cleanRuns")}</td><td>{inp("evalMin", true)}</td><td>{inp("reworkMax", true)}</td><td>{inp("incidentsMax")}</td><td>{inp("windowD")}</td>
      <td><Btn label={`Save ${code(level)}`} small id={`tr-crit-save-${level}`} guard={perm} onClick={() => {
        if (!Object.keys(d).length) { out({ ok: true, msg: "Nothing changed.", status: 200 } as never, "Nothing changed."); return; }
        void ops.setTrustCriteria(level, d, { ifMatch: p.criteriaVersion }).then((r) => { out(r); if (r.ok) setD({}); });
      }} /></td>
    </tr>
  );
}

export function PolicyTab({ p, cells, projects }: { p: LadderProps & { criteriaVersion: number }; cells: CellOut[]; projects: Project[] }) {
  const ui_ = useUI();
  const out = useOutcome();
  const perm = useCan("trust.criteria");
  const [sr, setSr] = useState<string | null>(null);
  const ceilings = (p as unknown as { ceilings: Array<TrustCeiling & { version?: number }> }).ceilings;
  const reach = (c: TrustCeiling): number => cells.filter((x) => {
    const pr = projects.find((y) => y.id === x.project);
    if (c.when.regulated && !(pr && pr.regulated)) return false;
    if (c.when.cls && c.when.cls !== x.cls) return false;
    if (c.when.project && c.when.project !== x.project) return false;
    if (c.when.gate) { const g = gateForAgent(p.cat, x.agent); if (!g || g.id !== c.when.gate) return false; }
    return true;
  }).length;
  const openCeiling = (c: (TrustCeiling & { version?: number }) | null) => ui_.dialog({ title: c ? `Edit ${c.id}` : "Add ceiling", kicker: "Trust · policy", sub: "Cells that match every condition you set are capped at the maximum. Saved and audited.", body: (close) => <CeilingDialog c={c} p={p} projects={projects} onDone={close} />, actions: [{ label: "Close" }] });
  const toggleSwitch = () => {
    if (p.switchOn) {
      ui_.confirm({ title: "Turn trust levels above L1 off?", body: "Every gate waits for a person again. Recorded levels stay as they are.", ok: "Turn off", kind: "danger" }).then((yes) => { if (yes) void ops.setTrustSwitch(false).then((r) => out(r)); });
    } else {
      ui_.reasonDialog({ title: "Turn trust levels above L1 on", kicker: "Trust · policy", sub: "Cells at L2 and L3 will pass gates without a person (L2 reviews a sample; L3 still reviews a random sample of at least 1 in 10). Risk-tagged changes, work with text from outside the organisation, the merge and release always need a person. Audited.", label: "Reason (required)", ok: "Turn on", min: 4, guard: perm, onOk: async (t) => out(await ops.setTrustSwitch(true, t)) });
    }
  };
  return (
    <div className="tr-policy">
      <LockNote decision={perm} what="Trust policy" />
      <Panel title="Levels above L1">
        <div className="tr-switch">
          <Toggle id="tr-switch" checked={p.switchOn} decision={perm} label="Trust levels above L1" onChange={toggleSwitch} />
          <div>
            <strong>{p.switchOn ? "On" : "Off (the default in a new install)"}</strong>
            <p className="small muted">L0 and L1 are always enforced: a person decides every gate. L2 and L3 are built but stay switched off until there is enough evidence. While off, a cell's recorded level above L1 does nothing, no promotion is proposed and a level above L1 cannot be granted. L4 cannot be granted in this version.</p>
          </div>
        </div>
      </Panel>
      <Panel title="Ceilings" tools={<Btn label="Add ceiling" small icon="plus" id="tr-ceil-add" guard={perm} onClick={() => openCeiling(null)} />}>
        <div>
          <p className="small muted">A ceiling caps the level a cell can run at, whatever was granted. The lowest matching ceiling wins.</p>
          <div className="table-scroll">
            <table className="table table-compact tr-ceil">
              <thead><tr>{["Id", "Rule", "Applies when", "Maximum", "Reach", "On", ""].map((x, i) => <th key={i} scope="col">{x}</th>)}</tr></thead>
              <tbody>
                {ceilings.map((c) => (
                  <tr key={c.id} className={c.enabled === false ? "is-off" : ""}>
                    <td className="mono">{c.id}</td><td>{c.text}</td><td className="small">{whenText(c.when, p, p.cat)}</td><td><LevelTag level={c.max} /></td><td className="small">{`${reach(c)} cells`}</td>
                    <td><Toggle id={`tr-ceil-on-${c.id}`} checked={c.enabled !== false} decision={perm} label={`Enforce ${c.id}`} onChange={(v) => { void ops.saveCeiling({ ...c, enabled: v }, { ifMatch: c.version ?? 0 }).then((r) => out(r)); }} /></td>
                    <td className="tr-acts">
                      <Btn label="Edit" small id={`tr-ceil-edit-${c.id}`} guard={perm} onClick={() => openCeiling(c)} />
                      <Btn label="Remove" small kind="ghost" id={`tr-ceil-rm-${c.id}`} guard={perm} onClick={() => ui_.reasonDialog({ title: `Remove ${c.id}`, sub: `${c.text}. Cells it capped may run at their granted level again.`, label: "Reason", ok: "Remove", kind: "danger", min: 4, guard: perm, onOk: async () => out(await ops.removeCeiling(c.id, { ifMatch: c.version ?? 0 })) })} />
                    </td>
                  </tr>
                ))}
                {!ceilings.length ? <tr><td colSpan={7} className="muted small">No ceilings. Every cell can run at the level it was granted.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
      <div className="two-col">
        <Panel title="Promotion criteria">
          <div>
            <p className="small muted">{`What a cell must show before the system proposes the level. Eval minimum and rework maximum are percentages. Counted from reviewed runs since the cell's last change. A change publishes version ${p.criteriaVersion + 1}; earlier versions stay on record.`}</p>
            <div className="table-scroll">
              <table className="table table-compact tr-crit-t">
                <thead><tr>{["Level", "Clean runs", "Eval min %", "Rework max %", "Incidents max", "Window (days)", ""].map((x, i) => <th key={i} scope="col">{x}</th>)}</tr></thead>
                <tbody>{[2, 3, 4].map((L) => <CriteriaRow key={`${L}-${p.criteriaVersion}`} level={L} p={p} />)}</tbody>
              </table>
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
