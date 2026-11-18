/** Scorecards tab (legacy agentsTab): per-agent live scorecard, trend charts, suite history, promotion eligibility, trust and learning links, candidates across the factory. */
import type { ReactElement } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useLearningFindings, useTrustCells } from "../../api/queries";
import { hashFor, navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { IconBtn, Btn, Chip, Empty, LockNote, Panel, type Decision } from "../../ui/primitives";
import { DataView } from "../dataview";
import { Icon } from "../../ui/Icon";
import { AreaChart, Spark } from "../../ui/charts";
import { useUI } from "../../ui/overlay-context";
import type { AgentRow, AgentVersionRow } from "../agents/kit";
import { useOutcome } from "../govern/data";
import { MIN_N, agentOf, evalsGoSuite, evalsUi, metricHas, suiteOf, useEvalsData, useEvalsUi, weekLabels, weeksOf, type EvalsData } from "./kit";

const METRICS: Array<[keyof import("@gantry/domain").Scorecard, string, "pct" | "money" | "min" | "n", boolean]> = [
  ["taskSuccess", "Task success", "pct", true], ["firstPass", "First-pass approval", "pct", true], ["testPass", "Test pass", "pct", true], ["rework", "Rework", "pct", false],
  ["costPerWO", "Cost / WO", "money", false], ["minutesPerStation", "Min / station", "min", false], ["gateRejections", "Gate rejections", "n", false], ["overrideRate", "Human override", "pct", false],
];
export { METRICS };
export const fmtMetric = (kind: string, v: number): string => (kind === "pct" ? fmt.pct(v) : kind === "money" ? fmt.money(v) : kind === "min" ? `${v}m` : String(v));

/** Trust demotions in the last 14 days for an agent (over the projects the viewer can see) and the learning findings that point at it. */
function useTrustLearning(agentId: string) {
  const cells = useTrustCells().data?.cells ?? [];
  const findings = (useLearningFindings().data ?? []) as Array<{ id: string; title: string; agent?: string; status?: string; count?: number; project?: string }>;
  const since = Date.now() - 14 * 86_400_000;
  const demotions: Array<{ cell: (typeof cells)[number]; e: (typeof cells)[number]["history"][number] }> = [];
  for (const c of cells) if (c.agent === agentId) for (const e of c.history) if (e.kind === "demote" && e.at >= since) demotions.push({ cell: c, e });
  return { demotions: demotions.sort((a, b) => b.e.at - a.e.at), findings: findings.filter((f) => f.agent === agentId) };
}

export function goTrust(cellId?: string): void {
  updatePrefs({ trustFocus: cellId ? { cell: cellId } : { tab: "demotions" } } as never);
  navigate("trust");
}
const goFinding = (id: string): void => {
  updatePrefs({ learningFocus: { finding: id } } as never);
  navigate("learning");
};

export function LinkedOutcomes({ agentId, idp }: { agentId: string; idp: string }) {
  const x = useTrustLearning(agentId);
  const out: ReactElement[] = [];
  if (x.demotions.length) {
    out.push(<button key="dem" type="button" className="linkish" id={`${idp}-dem`} onClick={() => goTrust(x.demotions.length === 1 ? x.demotions[0]!.cell.id : undefined)}>{`${x.demotions.length} trust demotion${x.demotions.length > 1 ? "s" : ""} in 14 days`}</button>);
  }
  x.findings.filter((f) => f.status === "open").slice(0, 2).forEach((f) => out.push(<button key={f.id} type="button" className="linkish" id={`${idp}-f-${f.id}`} onClick={() => goFinding(f.id)}>{`Finding ${f.id}: ${f.title}`}</button>));
  return <>{out.map((n, i) => <span key={i} className="ev-reg-link">{" · "}{n}</span>)}</>;
}

function OutcomesPanel({ a, label }: { a: AgentRow; label: (c: { agent: string; cls: string; project: string; repo: string | null }) => string }) {
  const x = useTrustLearning(a.id);
  return (
    <Panel title="Trust and learning">
      <div className="ev-tl">
        <h3 className="sub-h">Trust demotions, 14 days</h3>
        {x.demotions.length ? (
          <ul className="plain-list small">
            {x.demotions.map((d, i) => (
              <li key={i}>
                <span className="mono">{`${fmt.istDate(d.e.at)} `}</span>
                <button type="button" className="linkish" id={`ev-tl-dem-${i}`} onClick={() => goTrust(d.cell.id)}>{label(d.cell)}</button>
                {` L${d.e.from} ▼ L${d.e.to}: ${d.e.reason}`}
              </li>
            ))}
          </ul>
        ) : <p className="small muted">None. A suite regression does not demote by itself; post-release reverts, incidents and guardrail breaches do.</p>}
        <h3 className="sub-h">Learning findings</h3>
        {x.findings.length ? (
          <ul className="plain-list small">
            {x.findings.map((f) => (
              <li key={f.id}><button type="button" className="linkish" id={`ev-tl-f-${f.id}`} onClick={() => goFinding(f.id)}>{`${f.id} ${f.title}`}</button>{` · ${f.count ?? 0} signals · ${f.status ?? "open"}`}</li>
            ))}
          </ul>
        ) : <p className="small muted">No findings point at this agent.</p>}
      </div>
    </Panel>
  );
}

function PromoteRow({ a, v, perm }: { a: AgentRow; v: AgentVersionRow; perm: Decision }) {
  const out = useOutcome();
  const el = v.eligibility;
  const g: Decision | null = !perm.allowed ? perm : !el.ok ? { allowed: false, needs: "Needs a passing run", reason: `${el.text}.` } : null;
  return (
    <li className={`ev-promo ${el.ok ? "is-ok" : "is-blocked"}`}>
      <span className="ev-promo-mark" aria-hidden="true"><Icon name={el.ok ? "check" : "lock"} /></span>
      <span>
        <strong>{`${a.name} `}</strong><span className="mono">{v.v}</span>
        {v.live ? <Chip text="on the floor" cls="chip-accent" /> : v.rc ? <Chip text="candidate" /> : null}
        <div className={`small ${el.ok ? "pos" : "neg"}`}>{el.text}</div>
      </span>
      {v.live ? <span className="muted small">live</span> : (
        <Btn label="Promote" small kind={el.ok ? "primary" : undefined} icon="rocket" id={`ev-promote-${a.id}-${v.v.replace(/\W/g, "")}`} guard={g}
          onClick={() => { void ops.promoteAgent(a.id, v.v, { ifMatch: a.rev }).then((r) => out(r)); }} />
      )}
    </li>
  );
}

/** The agent's full scorecard (live metrics, weekly charts, suite history, promotion eligibility, trust and learning links, candidates), in a drawer opened from the list row. */
export function ScorecardDrawer({ agentId, label, close }: { agentId: string; label: (c: { agent: string; cls: string; project: string; repo: string | null }) => string; close: () => void }) {
  useEvalsUi();
  const d = useEvalsData();
  const perm = useCan("agent.edit");
  const a = agentOf(d, agentId);
  if (!a) return <div className="drawer-inner"><div className="drawer-head"><h2 className="drawer-title">Scorecard</h2><IconBtn icon="x" label="Close" className="drawer-close" onClick={close} /></div><Empty title="Loading" text="Reading the scorecard." /></div>;
  evalsUi.agent = a.id;
  const c = d.scorecards[a.id];
  const su = suiteOf(d, a.suite);
  const wk = weeksOf(c, weekLabels(8));
  const n = c?.counts?.attempts ?? 0;
  const runs = d.runs.filter((r) => r.agent === a.id && r.status === "completed").slice(-8);
  const candidates: Array<[AgentRow, AgentVersionRow]> = [];
  for (const x of d.agents) for (const v of x.versions) if (v.rc) candidates.push([x, v]);
  return (
    <div className="drawer-inner ev-agmain" id="ev-scorecard">
      <div className="drawer-head">
        <div><div className="kicker">Scorecard</div><h2 className="drawer-title">{`${a.name} scorecard`}</h2></div>
        <IconBtn icon="x" label="Close" className="drawer-close" id="ev-sc-close" onClick={close} />
      </div>
      <div className="drawer-scroll">
        <p className="small muted ev-p">{`Live work over the last 7 days, version ${a.version} on ${a.model}. Suite ${su ? `${su.id}, gate ${fmt.pct(su.threshold)}` : "none"}.`}</p>
        <div className="row"><a className="btn sm" href={hashFor("agents", a.id)} id="ev-open-agent" onClick={close}>Open agent</a><Btn label="Open suite" small icon="eval" id="ev-open-suite" onClick={() => { close(); evalsGoSuite(a.suite, a.id); }} /></div>
        <dl className="ev-tiles">
          {METRICS.map(([k, name, kind, higher]) => (
            <div className="ev-tile" key={k}>
              <dt>{name}</dt>
              <dd className="ev-big">{metricHas(c, k) ? fmtMetric(kind, c![k] as number) : "–"}</dd>
              <dd className="ev-dir small muted">{higher ? "higher is better" : "lower is better"}</dd>
            </div>
          ))}
        </dl>
        <p className="small muted ev-n" id="ev-n">
          {n < MIN_N ? `Insufficient data: ${n} finished attempt${n === 1 ? "" : "s"} in 7 days, ${c?.counts?.decisions ?? 0} gate decision${c?.counts?.decisions === 1 ? "" : "s"}.` : `Based on ${n} finished attempts on ${c?.counts?.workOrders ?? 0} work orders and ${c?.counts?.decisions ?? 0} gate decisions in 7 days.`}
        </p>
        {wk.idx.length >= 2 ? (
          <div className="chart-pair">
            <AreaChart title={`${a.name}: task success by week`} values={wk.success} labels={wk.labels} fmt={(v) => fmt.pct(v)} yLabel="success rate" min={0.5} max={1} {...(su ? { threshold: su.threshold, threshLabel: `gate ${fmt.pct(su.threshold)}` } : {})} />
            <AreaChart title={`${a.name}: cost per work order by week`} values={wk.cost} labels={wk.labels} fmt={(v) => `$${v.toFixed(2)}`} yLabel="USD per work order" />
          </div>
        ) : <Panel title="Weekly trend"><Empty title="Insufficient data" text={`Charts need at least two weeks with finished attempts. ${a.name} has ${wk.idx.length}.`} /></Panel>}
        {runs.length > 1 ? (
          <Panel title="Suite history">
            <AreaChart title={`${su ? su.id : "Suite"} score by run`} values={runs.map((r) => r.score)} labels={runs.map((r) => r.version)} fmt={(v) => fmt.pct(v)} yLabel="suite score" min={0.4} max={1} {...(su ? { threshold: su.threshold } : {})} threshLabel="gate" />
          </Panel>
        ) : <Panel title="Suite history"><Empty title="Not enough runs" text="Run the suite twice to see a trend." /></Panel>}
        <Panel title="Promotion eligibility">
          <LockNote decision={perm} what="Promoting agent versions" />
          <ul className="ev-promos">{a.versions.slice().reverse().map((v) => <PromoteRow key={v.v} a={a} v={v} perm={perm} />)}</ul>
        </Panel>
        <OutcomesPanel a={a} label={label} />
        <Panel title="Candidates across the factory">
          {candidates.length ? <ul className="ev-promos">{candidates.map(([x, v]) => <PromoteRow key={`${x.id}-${v.v}`} a={x} v={v} perm={perm} />)}</ul> : <Empty title="No candidates" text="Create a candidate version on an agent to see it here." />}
        </Panel>
      </div>
    </div>
  );
}

/** The prototype's Scorecards: one flat table of the agents, the agent a link to its page, the eight-week trend a plain line with an end dot. */
export function ScorecardsTab({ d, label }: { d: EvalsData; label: (c: { agent: string; cls: string; project: string; repo: string | null }) => string }) {
  const ui = useUI();
  const val = (a: AgentRow, k: "taskSuccess" | "firstPass" | "rework"): number => (metricHas(d.scorecards[a.id], k) ? d.scorecards[a.id]![k] : k === "taskSuccess" ? a.evalScore : -1);
  const cell = (a: AgentRow, k: "taskSuccess" | "firstPass" | "rework") => <span className="num">{val(a, k) >= 0 ? fmt.pct(val(a, k)) : "–"}</span>;
  const open = (a: AgentRow): void => navigate("agents", a.id);
  if (!d.agents.length) return <Empty title="No agents" text="Create an agent to see its scorecard." />;
  return (
    <Panel title="Agent scorecards" flush cls="ev-aglist-panel">
      <DataView id="ev-scorecards" noun="agent" rows={d.agents} rowKey={(x) => x.id} rowId={(x) => `ev-ag-${x.id}`} text={(x) => x.name} onRow={open} pageSize={12} empty={{ title: "No agents", text: "Create an agent to see its scorecard." }}
        columns={[
          { key: "name", label: "Agent", sort: (x) => x.name.toLowerCase(), render: (x) => <a className="pri" href={hashFor("agents", x.id)} onClick={(e) => { e.preventDefault(); open(x); }}>{x.name}</a> },
          { key: "ts", label: "Task success", align: "end", sort: (x) => val(x, "taskSuccess"), render: (x) => cell(x, "taskSuccess") },
          { key: "fp", label: "First pass", align: "end", sort: (x) => val(x, "firstPass"), render: (x) => cell(x, "firstPass") },
          { key: "rw", label: "Rework", align: "end", sort: (x) => val(x, "rework"), render: (x) => cell(x, "rework") },
          { key: "cost", label: "Cost / WO", align: "end", sort: (x) => d.scorecards[x.id]?.costPerWO ?? -1, render: (x) => <span className="num">{metricHas(d.scorecards[x.id], "costPerWO") ? fmt.money(d.scorecards[x.id]!.costPerWO) : "–"}</span> },
          { key: "trend", label: "8-week trend", hideSmall: true, render: (x) => { const k = d.scorecards[x.id]; const w = k ? weeksOf(k, []) : null; return w && w.idx.length >= 2 ? <Spark values={w.success} w={90} h={24} plain label={`Trend ${w.success.map((v) => +v.toFixed(2)).join(", ")}`} /> : <span className="muted">–</span>; } },
          { key: "detail", label: "", align: "end", render: (x) => <Btn label="Scorecard" small kind="ghost" id={`ev-sc-open-${x.id}`} aria={`Open the full scorecard of ${x.name}`} onClick={() => { evalsUi.agent = x.id; ui.drawer.open(`ev-sc:${x.id}`, (close) => <ScorecardDrawer agentId={x.id} label={label} close={close} />); }} /> },
        ]} />
    </Panel>
  );
}
