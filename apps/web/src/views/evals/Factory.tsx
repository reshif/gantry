/** Factory-wide tab (the prototype's): task success trend, gate rejection reasons, agent x project heat map and classifier confusion. */
import { fmt, type EvalExtra } from "@gantry/domain";
import { BarChart as ProtoBars, LineChart } from "./protoCharts";
import { Empty, Panel } from "../../ui/primitives";
import { weeksOf, agentOf, type EvalsData } from "./kit";

type Extra = EvalExtra & { counts?: { workOrders: number; classified: number; decisions: number; attempts: number } };

const heatColor = (v: number | null): string => (v == null ? "var(--sunk)" : `color-mix(in srgb, var(--accent) ${Math.round(Math.max(0, (v - 0.6) / 0.4) * 40 + 8)}%, var(--surface))`);

/** The prototype's agent x project heat map: micro project headers, the first ten agents, whole-number scores, a dash where there is no work. */
function Heat({ d }: { d: EvalsData }) {
  const heat = d.extra?.heat ?? {};
  const ags = d.agents.filter((a) => heat[a.id]).slice(0, 10);
  const pj = ags.length ? Object.keys(heat[ags[0]!.id] ?? {}) : [];
  if (!ags.length || !pj.length) return <Empty title="No scores yet" text="Scores per agent and project appear once agents have finished work." />;
  return (
    <div className="tw">
      <div className="heat" id="ev-heat" role="table" aria-label="Task success per agent and project" style={{ gridTemplateColumns: `130px repeat(${pj.length},1fr)` }}>
        <div />
        {pj.map((p) => <div key={p} className="micro">{p}</div>)}
        {ags.map((a) => [
          <div key={a.id} className="small" style={{ textAlign: "left" }}>{a.name}</div>,
          ...pj.map((p) => { const v = heat[a.id]?.[p] ?? null; return <div key={`${a.id}-${p}`} style={{ background: heatColor(v) }} title={`${a.name} · ${p}: ${v == null ? "no data" : fmt.pct(v)}`}>{v == null ? "—" : Math.round(v * 100)}</div>; }),
        ])}
      </div>
    </div>
  );
}

/** The prototype's classifier confusion: true classes down, predicted across (first five letters), counts shaded green on the diagonal and red off it. */
function Confusion({ ex }: { ex: Extra }) {
  const cf = ex.confusion ?? {};
  const cls = Object.keys(cf);
  let total = 0;
  cls.forEach((t) => cls.forEach((p) => { const n = cf[t]![p] ?? 0; total += n; }));
  if (!total) return <Empty title="No classified requests yet" text="The table fills in as requests are classified at intake and confirmed or changed by a person." />;
  return (
    <div>
      <div className="tw">
        <div className="heat" id="ev-confusion" role="table" aria-label="Classifier confusion" style={{ gridTemplateColumns: `90px repeat(${cls.length},minmax(44px,1fr))`, minWidth: 560 }}>
          <div>true ↓ pred →</div>
          {cls.map((c) => <div key={c} className="micro">{c.slice(0, 5)}</div>)}
          {cls.map((t) => [
            <div key={t} className="small">{t}</div>,
            ...cls.map((p) => { const v = cf[t]![p] ?? 0; return <div key={`${t}-${p}`} style={{ background: v ? `color-mix(in srgb,${t === p ? "var(--ok)" : "var(--bad)"} ${Math.min(80, 10 + v)}%,var(--surface))` : "transparent" }}>{v || ""}</div>; }),
          ])}
        </div>
      </div>
    </div>
  );
}

export function FactoryTab({ d }: { d: EvalsData }) {
  const ex = (d.extra ?? { heat: {}, confusion: {}, perClass: {}, overrideRate: 0, onboarding: { attempts: 0, ready: 0, successRate: 0, medianDays: 0, p90Days: 0, failedReasons: [] }, gateRejections: [], humanOverride: {} }) as Extra;
  const live = d.agents.filter((a) => d.scorecards[a.id] && weeksOf(d.scorecards[a.id], []).idx.length > 0);
  // Weeks with at least one finished attempt by any agent; the mean is over the agents that had some that week. No endpoint serves a factory trend, so it is derived from the scorecards.
  const idxOf = new Map(live.map((a) => [a.id, weeksOf(d.scorecards[a.id], []).idx]));
  const weeks = Array.from({ length: 8 }, (_, i) => i).filter((i) => live.some((a) => idxOf.get(a.id)!.includes(i)));
  const avg = weeks.map((i) => { const who = live.filter((a) => idxOf.get(a.id)!.includes(i)); return who.reduce((t, a) => t + (d.scorecards[a.id]!.trend.success[i] ?? 0), 0) / who.length; });
  const labels = weeks.map((i) => `W${i + 1}`);
  const gr = (ex.gateRejections ?? []).map((r) => ({ label: r[0], value: r[1], tone: "warn" as const }));
  return (
    <div className="ev-factory stack">
      <div className="cols">
        <Panel title="Task success, 8 weeks">
          {weeks.length >= 2 ? <LineChart values={avg} labels={labels} fmt={(v) => `${Math.round(v * 100)}%`} min={0.8} max={1} label="Task success, 8 weeks" /> : <Empty title="Insufficient data" text="The chart needs at least two weeks with finished attempts on real work." />}
        </Panel>
        <Panel title="Gate rejection reasons">{gr.length ? <ProtoBars items={gr.map((g) => ({ l: g.label, v: g.value, tone: "warn" }))} label="Gate rejection reasons" lw={170} /> : <Empty title="No rejections" text="Nothing was rejected at a gate in the last 30 days." />}</Panel>
      </div>
      <Panel title="Agent × project heat map"><Heat d={d} /></Panel>
      <Panel title="Classifier confusion"><Confusion ex={ex} /></Panel>
    </div>
  );
}
export { agentOf };
