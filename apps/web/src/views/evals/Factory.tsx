/** Factory-wide tab (legacy factoryTab): agents x metrics, agents x projects, per-class performance, onboarding, intake confusion, per-skill coverage, gate rejections, human override. */
import { fmt, type EvalExtra, type Project } from "@gantry/domain";
import { useProjects } from "../../api/queries";
import { AreaChart, BarChart } from "../../ui/charts";
import { Empty, Panel } from "../../ui/primitives";
import { ClassChip, useCatalog } from "../projects/kit";
import { METRICS, fmtMetric } from "./Scorecards";
import { MIN_N, agentOf, evalsUi, metricHas, rowKeys, suiteOf, weekLabels, type EvalsData } from "./kit";
import { setUrlParams } from "../urlState";

type Extra = EvalExtra & { counts?: { workOrders: number; classified: number; decisions: number; attempts: number } };

function Matrix({ d }: { d: EvalsData }) {
  const live = d.agents.filter((a) => (d.scorecards[a.id]?.counts?.attempts ?? 0) > 0);
  const ranges = METRICS.map(([k]) => {
    const vals = live.filter((a) => metricHas(d.scorecards[a.id], k)).map((a) => d.scorecards[a.id]![k] as number);
    return (vals.length ? [Math.min(...vals), Math.max(...vals)] : [0, 0]) as [number, number];
  });
  return (
    <div className="table-scroll" data-keep-scroll="ev-matrix">
      <table className="table table-compact ev-matrix">
        <thead><tr><th scope="col">Agent</th>{METRICS.map(([, name, , higher]) => <th key={name} scope="col" className="num">{name}<span className="ev-dir-h" aria-label={higher ? "higher is better" : "lower is better"}>{higher ? " ↑" : " ↓"}</span></th>)}</tr></thead>
        <tbody>
          {d.agents.map((a) => {
            const c = d.scorecards[a.id];
            const has = !!c && (c.counts?.attempts ?? 0) > 0;
            return (
              <tr key={a.id} className="row-link" tabIndex={0} id={`ev-mx-${a.id}`} {...rowKeys(() => { evalsUi.agent = a.id; setUrlParams({ tab: "agents", q: "", sort: "", dir: "", suite: "", run: "" }); })}>
                <th scope="row">{a.name}{has && (c!.counts?.attempts ?? 0) < MIN_N ? <span className="muted small">{` n=${c!.counts!.attempts}`}</span> : null}</th>
                {METRICS.map(([k, name, kind, higher], i) => {
                  if (!has || !metricHas(c, k)) return <td key={k} className="num muted">–</td>;
                  const v = c![k] as number;
                  const r = ranges[i]!;
                  let g = r[1] === r[0] ? 0.5 : (v - r[0]) / (r[1] - r[0]);
                  if (!higher) g = 1 - g;
                  return <td key={k} className={`num mono ev-cell${g >= 0.999 ? " is-best" : g <= 0.001 ? " is-worst" : ""}`} style={{ "--g": g.toFixed(2) } as never} title={`${name}: ${fmtMetric(kind, v)}${g >= 0.999 ? " (best)" : g <= 0.001 ? " (worst)" : ""}`}>{fmtMetric(kind, v)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Heat({ d, projects }: { d: EvalsData; projects: Project[] }) {
  const heat = d.extra?.heat ?? {};
  const ps = projects.filter((p) => p.status !== "archived");
  return (
    <div className="table-scroll" data-keep-scroll="ev-heat">
      <table className="table table-compact ev-heat">
        <thead><tr><th scope="col">Agent</th>{ps.map((p) => <th key={p.id} scope="col" className="num">{p.name}{p.regulated ? <span className="tag">reg</span> : null}</th>)}</tr></thead>
        <tbody>
          {d.agents.map((a) => {
            const th = suiteOf(d, a.suite)?.threshold ?? 0.85;
            return (
              <tr key={a.id}>
                <th scope="row">{a.name}</th>
                {ps.map((p) => {
                  const v = heat[a.id]?.[p.id] ?? null;
                  if (v == null) return <td key={p.id} className="num ev-hcell is-none" title={`${a.name} has no work on ${p.name}`}>–</td>;
                  const below = v < th;
                  return <td key={p.id} className={`num mono ev-hcell${below ? " is-below" : ""}`} style={{ "--v": Math.max(0, (v - 0.5) / 0.5).toFixed(2) } as never} title={`${a.name} on ${p.name}: ${fmt.pct(v)}${below ? `, below gate ${fmt.pct(th)}` : ""}`}>{below ? "▼ " : ""}{fmt.pct(v)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Confusion({ ex, cat }: { ex: Extra; cat: ReturnType<typeof useCatalog> }) {
  const cf = ex.confusion ?? {};
  const ids = Object.keys(cf);
  const name = (id: string) => cat?.classes.find((c) => c.id === id)?.name ?? id;
  const chip = (id: string) => <ClassChip cls={cat?.classes.find((c) => c.id === id) ?? { id, name: id }} small />;
  let total = 0, diag = 0, maxOff = 1, maxDiag = 1;
  const colTot: Record<string, number> = {};
  ids.forEach((p) => { colTot[p] = 0; });
  ids.forEach((t) => ids.forEach((p) => { const n = cf[t]![p] ?? 0; colTot[p] = (colTot[p] ?? 0) + n; total += n; if (t === p) { diag += n; maxDiag = Math.max(maxDiag, n); } else maxOff = Math.max(maxOff, n); }));
  if (!total) return <Empty title="No classified requests yet" text="The table fills in as requests are classified at intake and confirmed or changed by a person." />;
  let worst: [string, string, number] | null = null;
  ids.forEach((t) => ids.forEach((p) => { const n = cf[t]![p] ?? 0; if (t !== p && (!worst || n > worst[2])) worst = [t, p, n]; }));
  const w = worst as [string, string, number] | null;
  return (
    <div>
      <p className="small ev-p">
        {`Labelled sample of ${total} requests, last 90 days. Accuracy `}<strong className="mono">{fmt.pct(diag / total)}</strong>
        {w && w[2] > 0 ? `. Most common mistake: ${name(w[0])} read as ${name(w[1])} (${w[2]})` : ""}{". Overrides by submitters: "}<strong className="mono">{fmt.pct(ex.overrideRate || 0)}</strong>{total < MIN_N * 2 ? ". Insufficient data for per-class rates." : "."}
      </p>
      <div className="table-scroll" data-keep-scroll="ev-conf">
        <table className="table table-compact ev-conf">
          <thead><tr><th scope="col" className="ev-conf-corner"><span>Actual ↓</span><span>Predicted →</span></th>{ids.map((p) => <th key={p} scope="col" className="num">{chip(p)}</th>)}<th scope="col" className="num">Recall</th></tr></thead>
          <tbody>
            {ids.map((t) => {
              const rowTot = ids.reduce((n, p) => n + (cf[t]![p] ?? 0), 0);
              return (
                <tr key={t}>
                  <th scope="row">{chip(t)}</th>
                  {ids.map((p) => {
                    const n = cf[t]![p] ?? 0;
                    const isD = t === p;
                    return <td key={p} className={`num mono ev-cf${isD ? " is-diag" : n ? " is-off" : " is-zero"}`} style={{ "--v": ((isD ? n / maxDiag : n / maxOff)).toFixed(2) } as never} title={`${name(t)} classified as ${name(p)}: ${n}`}>{n ? String(n) : "·"}</td>;
                  })}
                  <td className={`num mono${rowTot && (cf[t]![t] ?? 0) / rowTot < 0.85 ? " neg" : ""}`}>{rowTot ? `${fmt.pct((cf[t]![t] ?? 0) / rowTot)} n=${rowTot}` : "–"}</td>
                </tr>
              );
            })}
            <tr className="ev-conf-foot">
              <th scope="row">Precision</th>
              {ids.map((p) => { const pr = colTot[p] ? (cf[p]![p] ?? 0) / colTot[p]! : 0; return <td key={p} className={`num mono${pr < 0.85 ? " neg" : ""}`}>{colTot[p] ? fmt.pct(pr) : "–"}</td>; })}
              <td className="num mono strong">{fmt.pct(diag / total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerClass({ ex, cat }: { ex: Extra; cat: ReturnType<typeof useCatalog> }) {
  const pc = ex.perClass ?? {};
  const ids = Object.keys(pc);
  const cls = (id: string) => cat?.classes.find((c) => c.id === id) ?? { id, name: id };
  if (!ids.length) return <Empty title="No work orders yet" text="Per-class figures appear once work has been submitted." />;
  return (
    <div className="ev-pc">
      <BarChart title="Success rate by work class" rows={ids.map((c) => ({ label: cls(c).name, value: pc[c]!.success, note: `n=${pc[c]!.count}` }))} min={0.5} max={1} fmt={(v) => fmt.pct(v)} xLabel="work orders shipped without rework, last 30 days" threshold={0.85} threshLabel="target 85%" emphasis="min" ticks={5} />
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr>{["Class", "Work orders", "Success", "Median cycle", "Rework"].map((x, i) => <th key={x} scope="col" className={i ? "num" : ""}>{x}</th>)}</tr></thead>
          <tbody>
            {ids.map((c) => {
              const x = pc[c]!;
              return (
                <tr key={c}>
                  <td><ClassChip cls={cls(c)} small /></td><td className="num mono">{x.count}</td>
                  <td className={`num mono${x.success < 0.85 ? " neg" : ""}`}>{x.count < MIN_N ? <span className="muted">insufficient data</span> : fmt.pct(x.success)}</td>
                  <td className="num mono">{x.cycleH >= 48 ? `${(x.cycleH / 24).toFixed(1)}d` : `${x.cycleH}h`}</td><td className={`num mono${x.rework > 0.2 ? " neg" : ""}`}>{fmt.pct(x.rework)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = { connected: "Connected", assessed: "Assessed", pr_opened: "PR opened", pr_checks: "PR checks", pr_merged: "PR merged", verified: "Verified", ready: "Ready", failed: "Failed", person: "Needs a person" };
const STAGES = ["connected", "assessed", "pr_opened", "pr_checks", "pr_merged", "verified", "ready", "failed", "person"];

function Onboarding({ ex }: { ex: Extra }) {
  const o = ex.onboarding ?? { attempts: 0, ready: 0, successRate: 0, medianDays: 0, p90Days: 0, failedReasons: [] };
  const counts = ex.onboardingStages ?? {};
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const shown = STAGES.filter((x) => counts[x]);
  const ready = counts.ready ?? 0;
  return (
    <div className="ev-onb">
      <dl className="ev-tiles ev-tiles-4">
        <div className="ev-tile"><dt>Success rate</dt><dd className="ev-big">{total ? fmt.pct(o.successRate) : "–"}</dd><dd className="small muted">{`${o.ready} of ${total} repos reached Ready`}</dd></div>
        <div className="ev-tile"><dt>Median time to ready</dt><dd className="ev-big">{o.ready ? `${o.medianDays}d` : "–"}</dd><dd className="small muted">{o.ready ? `n=${o.ready}, connect to Ready` : "insufficient data"}</dd></div>
        <div className="ev-tile"><dt>p90 time to ready</dt><dd className="ev-big">{o.ready >= MIN_N ? `${o.p90Days}d` : "–"}</dd><dd className="small muted">{o.ready >= MIN_N ? "slowest tenth" : "insufficient data"}</dd></div>
        <div className="ev-tile"><dt>In the pipeline now</dt><dd className="ev-big">{String(total - ready)}</dd><dd className="small muted">{`of ${total} repos`}</dd></div>
      </dl>
      {shown.length ? (
        <div className="ev-stack" role="img" aria-label={`Repos by onboarding stage: ${shown.map((x) => `${STAGE_LABEL[x]} ${counts[x]}`).join(", ")}`}>
          {shown.map((x) => <span key={x} className={`ev-stk ev-stk-${x}`} style={{ flex: `${counts[x]} 1 0` }} title={`${STAGE_LABEL[x]}: ${counts[x]}`}><span className="ev-stk-l">{`${STAGE_LABEL[x]} ${counts[x]}`}</span></span>)}
        </div>
      ) : null}
      <p className="small mono ev-stk-legend">{shown.map((x) => `${STAGE_LABEL[x]} ${counts[x]}`).join(" · ")}</p>
      <p className="small muted">{`${total ? Math.round((ready / total) * 100) : 0}% of connected repos are Ready. `}<a href="#onboarding" className="linkish" id="ev-goto-onb">Open onboarding</a></p>
      {o.failedReasons.length ? (
        <div><h3 className="sub-h">Why onboarding failed</h3><ul className="plain-list small">{o.failedReasons.map((r) => <li key={r[0]}><span className="mono">{`${r[1]}× `}</span>{r[0]}</li>)}</ul></div>
      ) : null}
    </div>
  );
}

function SkillCoverage({ d }: { d: EvalsData }) {
  return (
    <div className="table-scroll">
      <table className="table table-compact">
        <thead><tr>{["Skill", "Version", "Used by", "Cases", "Pass", "Coverage"].map((x, i) => <th key={x} scope="col" className={i >= 2 ? "num" : ""}>{x}</th>)}</tr></thead>
        <tbody>
          {d.skills.map((sk) => {
            const n = d.agents.filter((a) => a.skills.includes(sk.id)).length;
            const p = sk.coverage.cases ? sk.coverage.pass / sk.coverage.cases : 0;
            const low = !sk.coverage.cases || p < 0.85;
            return (
              <tr key={sk.id}>
                <td><a href="#skills" className="linkish" id={`ev-sk-${sk.id}`}>{sk.name}</a></td><td className="mono small">{`v${sk.version}`}</td><td className="num mono">{n}</td>
                <td className="num mono">{sk.coverage.cases}</td><td className="num mono">{sk.coverage.pass}</td>
                <td className="num"><span className={`ev-cov${low ? " is-low" : ""}`}><span className="ev-cov-bar" aria-hidden="true"><span style={{ width: `${(p * 100).toFixed(0)}%` }} /></span><span className="mono small">{`${low ? "▼ " : ""}${sk.coverage.cases ? fmt.pct(p) : "none"}`}</span></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FactoryTab({ d }: { d: EvalsData }) {
  const projects = (useProjects().data ?? []) as Project[];
  const cat = useCatalog();
  const ex = (d.extra ?? { heat: {}, confusion: {}, perClass: {}, overrideRate: 0, onboarding: { attempts: 0, ready: 0, successRate: 0, medianDays: 0, p90Days: 0, failedReasons: [] }, gateRejections: [], humanOverride: {} }) as Extra;
  const live = d.agents.filter((a) => (d.scorecards[a.id]?.counts?.attempts ?? 0) > 0);
  // Weeks with at least one finished attempt by any agent; the mean is over the agents that had some that week.
  const weeks = Array.from({ length: 8 }, (_, i) => i).filter((i) => live.some((a) => (d.scorecards[a.id]!.trend.n?.[i] ?? 0) > 0));
  const avg = weeks.map((i) => { const who = live.filter((a) => (d.scorecards[a.id]!.trend.n?.[i] ?? 0) > 0); return who.reduce((t, a) => t + (d.scorecards[a.id]!.trend.success[i] ?? 0), 0) / who.length; });
  const avgCost = weeks.map((i) => live.reduce((t, a) => t + (d.scorecards[a.id]!.trend.cost[i] ?? 0), 0));
  const labels = weeks.map((i) => weekLabels(8)[i] ?? "");
  const gr = (ex.gateRejections ?? []).map((r) => ({ label: r[0], value: r[1] }));
  const gateLabel = (g: string) => { const x = cat?.gates.find((y) => y.id === g); return x ? `${x.label} ${x.name}` : g; };
  const ho = Object.keys(ex.humanOverride ?? {}).map((g) => ({ label: gateLabel(g), value: ex.humanOverride[g]! }));
  return (
    <div className="ev-factory">
      {weeks.length >= 2 ? (
        <div className="chart-pair">
          <AreaChart title="Factory task success, all agents" values={avg} labels={labels} fmt={(v) => fmt.pct(v)} yLabel="mean success rate" min={0.5} max={1} threshold={0.85} threshLabel="target 85%" />
          <AreaChart title="Cost per work order, summed across stations" values={avgCost} labels={labels} fmt={(v) => `$${v.toFixed(2)}`} yLabel="USD per work order" />
        </div>
      ) : <Panel title="Factory trend"><Empty title="Insufficient data" text="Charts need at least two weeks with finished attempts on real work." /></Panel>}
      <Panel title="Agents × metrics" cls="ev-mx-panel"><div><p className="small muted ev-p">Shading runs from worst to best in each column. Best is marked ▲, worst ▼. Select a row for the agent's scorecard. A figure under {MIN_N} finished attempts is shown with its count.</p><Matrix d={d} /></div></Panel>
      <Panel title="Agents × projects"><div><p className="small muted ev-p">Task success per agent on each project, last 30 days. ▼ marks a score below the agent's gate.</p><Heat d={d} projects={projects} /></div></Panel>
      <div className="two-col ev-two"><Panel title="Per-class performance"><PerClass ex={ex} cat={cat} /></Panel><Panel title="Onboarding"><Onboarding ex={ex} /></Panel></div>
      <Panel title="Intake classification"><Confusion ex={ex} cat={cat} /></Panel>
      <Panel title="Per-skill eval coverage" flush><SkillCoverage d={d} /></Panel>
      <div className="two-col ev-two">
        <Panel title="Gate rejection reasons">{gr.length ? <BarChart title="Rejections by reason, last 30 days" rows={gr} min={0} fmt={(v) => String(Math.round(v))} xLabel="rejections" emphasis="max" ticks={4} /> : <Empty title="No rejections" text="Nothing was rejected at a gate in the last 30 days." />}</Panel>
        <Panel title="Human override rate">
          <div>
            {ho.length ? <BarChart title="Agent recommendation overridden at each human gate" rows={ho} min={0} max={0.15} fmt={(v) => fmt.pct(v)} xLabel="share of decisions where the human went against the agent" threshold={0.1} threshLabel="review at 10%" emphasis="max" ticks={3} /> : <Empty title="No decisions yet" text="Gate decisions by people in the last 30 days appear here." />}
            <p className="small muted">High override at a gate means the agent before it is often wrong, or the approvers want something it was never told.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
export { agentOf };
