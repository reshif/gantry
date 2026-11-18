/** Proposals, demotions and policy tabs (legacy proposalsTab, demotionsTab, policyTab). */
import { useState, type CSSProperties } from "react";
import { fmt, type Project, type TrustCeiling, type TrustProposal, type WorkOrder } from "@gantry/domain";
import { useCan, useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import { useWorkOrders } from "../../api/queries";
import { openRecordRoute } from "../../lib/router";
import { Btn, Chip, Empty, Field, LockNote, Segmented, Select, Toggle, type Decision } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { useOutcome } from "../govern/data";
import { DataTable } from "../projects/kit";
import { DataTable as CrTable } from "../../ui/DataTable";
import { ProposalButtons, cellLabel, type LadderProps } from "./Ladder";
import { code, rerender, trustFocus, trustUi, type CellOut } from "./kit";

/* ---------------- proposals ---------------- */

/** The prototype's proposals card: a flush list of two-line rows, in the order the server gives them, Approve and Decline on a pending one and a chip on a decided one. */
export function ProposalsTab({ p, cells, proposals }: { p: LadderProps; cells: CellOut[]; proposals: TrustProposal[] }) {
  const who = useActors();
  const vis = new Set(cells.map((c) => c.id));
  const list = proposals.filter((x) => vis.has(x.cell)).slice().sort((a, b) => b.at - a.at);
  return (
    <Card title="Proposals" flush>
      <div className="list tr-prop-list">
        {list.map((x) => {
          const cell = cells.find((c) => c.id === x.cell)!;
          const project = p.projects.find((y) => y.id === cell.project)?.name ?? cell.project;
          const st = ({ pending: "Pending", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" } as Record<string, string>)[x.status] ?? x.status;
          const note = x.evidence.note || `${x.evidence.cleanRuns} clean runs, eval ${x.evidence.evalScore.toFixed(2)}`;
          const done = x.status !== "pending" ? `${x.by ? ` ${who(x.by).name}` : ""}${x.decidedAt ? ` ${fmt.ago(x.decidedAt, Date.now())}` : ""}${x.reason ? `: ${x.reason}` : ""}` : "";
          return (
            <div key={x.id} className={`li tr-prop is-${x.status}${trustUi.hiProposal === x.id ? " is-hi" : ""}`} id={`tr-prop-${x.id}`}>
              <div className="main1">
                <span className="t1">{`${p.agentName(cell.agent)} on ${project}: ${code(x.from)} \u2192 ${code(x.to)}`}</span>
                <span className="t2">{`${note}${done}`}</span>
              </div>
              {x.status === "pending" ? <ProposalButtons prop={x} cell={cell} p={p} /> : <Chip text={st} cls={x.status === "accepted" ? "ok" : "idle"} />}
            </div>
          );
        })}
        {!list.length ? <div className="li" id="tr-props-empty"><div className="main1"><span className="t1">No proposals yet</span><span className="t2">Proposals appear when a cell meets the criteria for its next level.</span></div></div> : null}
      </div>
    </Card>
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

type PolicyProps = { p: LadderProps & { criteriaVersion: number }; cells: CellOut[]; projects: Project[] };

/** Ceilings tab (prototype): one setrow per ceiling, the rule as the title, its maximum below and a switch at the right. The runtime switch for levels above L1 is the last row of the same card. */
export function CeilingsTab({ p }: PolicyProps) {
  const ui_ = useUI();
  const out = useOutcome();
  const perm = useCan("trust.criteria");
  const ceilings = (p as unknown as { ceilings: Array<TrustCeiling & { version?: number }> }).ceilings;
  const toggleSwitch = () => {
    if (p.switchOn) {
      ui_.confirm({ title: "Turn trust levels above L1 off?", body: "Every gate waits for a person again. Recorded levels stay as they are.", ok: "Turn off", kind: "danger" }).then((yes) => { if (yes) void ops.setTrustSwitch(false).then((r) => out(r)); });
    } else {
      ui_.reasonDialog({ title: "Turn trust levels above L1 on", kicker: "Trust \u00b7 policy", sub: "Cells at L2 and L3 will pass gates without a person (L2 reviews a sample; L3 still reviews a random sample of at least 1 in 10). Risk-tagged changes, work with text from outside the organisation, the merge and release always need a person. Audited.", label: "Reason (required)", ok: "Turn on", min: 4, guard: perm, onOk: async (t) => out(await ops.setTrustSwitch(true, t)) });
    }
  };
  return (
    <Card title="Ceilings" flush>
      <div className="list tr-ceil">
        {ceilings.map((c) => (
          <div key={c.id} className="setrow" id={`tr-ceil-${c.id}`}>
            <div className="tx"><b>{c.text}</b><span>{`Maximum level L${c.max}. No proposal can exceed it.`}</span></div>
            <Toggle id={`tr-ceil-on-${c.id}`} checked={c.enabled !== false} decision={perm} label={c.text} onChange={(v) => { void ops.saveCeiling({ ...c, enabled: v }, { ifMatch: c.version ?? 0 }).then((r) => out(r, `${v ? "Enabled" : "Disabled"} ${c.text}`)); }} />
          </div>
        ))}
        <div className="setrow tr-switch" id="tr-switch-row">
          <div className="tx"><b>Levels above L1</b><span>{p.switchOn ? "On. A cell's level above L1 is enforced, within the ceilings." : "Off. A level above L1 does nothing and cannot be granted until a person turns this on."}</span></div>
          <Toggle id="tr-switch" checked={p.switchOn} decision={perm} label="Trust levels above L1" onChange={toggleSwitch} />
        </div>
      </div>
    </Card>
  );
}

/** Criteria tab (prototype): the promotion criteria for L2, L3 and L4 as a flush read-only table. */
export function CriteriaTab({ p }: PolicyProps) {
  // the server publishes criteria for the levels it can grant; a level without any (L4 is not grantable) shows no figures rather than invented ones
  const rows = [2, 3, 4].map((L) => ({ level: L, c: p.criteria[String(L)] ?? null }));
  return (
    <Card title="Promotion criteria" flush>
      <CrTable<(typeof rows)[number]> id="tr-criteria" caption="Promotion criteria" rows={rows} rowKey={(r) => String(r.level)}
        empty={{ title: "No criteria", text: "No promotion criteria are published yet." }}
        columns={[
          { key: "level", label: "To level", render: (r) => <span className="lvl" style={{ "--l": r.level, cursor: "default" } as CSSProperties}>{`L${r.level}`}</span> },
          { key: "runs", label: "Clean runs", align: "end", render: (r) => <span className="mono">{r.c ? r.c.cleanRuns : "\u2013"}</span> },
          { key: "eval", label: "Min eval", align: "end", render: (r) => <span className="mono">{r.c ? r.c.evalMin : "\u2013"}</span> },
          { key: "rework", label: "Max rework", align: "end", render: (r) => <span className="mono">{r.c ? `${Math.round(r.c.reworkMax * 100)}%` : "\u2013"}</span> },
          { key: "window", label: "Window (days)", align: "end", render: (r) => <span className="mono">{r.c ? r.c.windowD : "\u2013"}</span> },
        ]} />
    </Card>
  );
}
