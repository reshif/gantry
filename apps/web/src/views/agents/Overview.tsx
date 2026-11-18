/** The agent page's Overview and Evals tabs, as the prototype draws them: score tiles, identity, recent eval runs, the score trend and the guardrails in brief. Read-only. */
import type { ReactNode } from "react";
import { fmt, type Project } from "@gantry/domain";
import { useSuiteRuns } from "../../api/queries";
import { Bars, Card, CrEmpty, Stats } from "../../ui/cr";
import { DataTable } from "../../ui/DataTable";
import { Btn, Who } from "../../ui/primitives";
import { useStations, type AgentRow } from "./kit";

const LEVEL: Record<string, string> = { suggest: "L0", gate: "L1", auto: "L2" };

export function AgentOverview({ a, projects, goTab, pause }: { a: AgentRow; projects: Project[]; goTab: (t: string) => void; pause?: ReactNode }) {
  const st = useStations();
  const extra = a as AgentRow & { rework?: number; runs30?: number };
  const runs = useSuiteRuns(a.suite).data ?? [];
  const recent = [...runs].sort((x, y) => y.at - x.at).slice(0, 6);
  const trend = [...runs].sort((x, y) => x.at - y.at).slice(-8).map((r) => Math.round(r.score * 100));
  return (
    <div id="ag-overview">
      <Stats items={[
        { l: "Eval score", v: a.suite ? a.evalScore.toFixed(2) : "n/a", tone: a.threshold != null && a.evalScore < a.threshold ? "bad" : "ok", spark: a.spark },
        // the agents read carries neither figure yet; they show when the server sends them
        { l: "Rework", v: extra.rework != null ? `${Math.round(extra.rework * 100)}%` : "n/a", ...(extra.rework != null ? { tone: extra.rework > 0.1 ? "warn" : "ok" } : {}) },
        { l: "Runs, 30d", v: extra.runs30 != null ? String(extra.runs30) : "n/a" },
        { l: "Autonomy", v: LEVEL[a.autonomy] ?? a.autonomy },
      ]} />
      <div className="grid g-main">
        <div className="stack">
          <Card title="Recent runs" hint={a.suite ? `Eval runs of ${a.suiteName ?? a.suite}` : undefined} flush>
            <DataTable
              id="ag-recent-runs"
              caption="Recent eval runs"
              rows={recent}
              rowKey={(r) => r.id}
              empty={{ title: "No runs yet", text: "Runs appear after the agent's eval suite has run." }}
              columns={[
                { key: "id", label: "Run", render: (r) => <span className="mono">{r.id}</span> },
                { key: "score", label: "Outcome", render: (r) => <span className={`chip ${a.threshold != null && r.score < a.threshold ? "warn" : "ok"}`}>{a.threshold != null && r.score < a.threshold ? "Below threshold" : "Passed"}</span> },
                { key: "version", label: "Version", render: (r) => <span className="mono">{r.version}</span> },
                { key: "at", label: "When", align: "end", render: (r) => <span className="mono">{fmt.stamp(r.at)}</span> },
                { key: "cost", label: "Cost", align: "end", render: (r) => <span className="mono">{fmt.money(r.cost)}</span> },
              ]}
            />
          </Card>
        </div>
        <div className="stack">
          <Card title="Identity" acts={pause}>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Station</dt><dd>{st.label(a.station, projects)}</dd>
              <dt>Model</dt><dd className="mono">{a.model}</dd>
              <dt>Version</dt><dd className="mono">{a.version}</dd>
              <dt>Budget</dt><dd>{`$${a.budget} per run`}</dd>
              <dt>Skills</dt><dd>{a.skills.length ? a.skills.map((sk) => <span key={sk} className="tag">{sk.replace(/^sk-/, "")}</span>) : "none"}</dd>
            </dl>
          </Card>
          <Card title="Eval trend" hint="Score of the last runs, percent">
            {trend.length ? <Bars data={trend} w={240} h={96} label="Eval score of the last runs" /> : <CrEmpty title="No runs yet" icon="eval" />}
          </Card>
          <Card title="Guardrails" acts={<Btn label="Open" small id="ag-open-guardrails" onClick={() => goTab("guardrails")} />}>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Max diff</dt><dd>{a.guardrails.maxDiff ? `${a.guardrails.maxDiff} lines` : "no limit"}</dd>
              <dt>Forbidden paths</dt><dd>{a.guardrails.paths.length ? `${a.guardrails.paths.length} pattern${a.guardrails.paths.length === 1 ? "" : "s"}` : "none"}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function AgentEvals({ a }: { a: AgentRow }) {
  const runs = useSuiteRuns(a.suite).data ?? [];
  const rows = [...runs].sort((x, y) => y.at - x.at);
  return (
    <Card title="Evals" hint={a.suite ? `${a.suiteName ?? a.suite}${a.threshold != null ? ` · threshold ${a.threshold.toFixed(2)}` : ""}` : "No suite is set for this agent"} flush id="ag-evals-tab" acts={<a className="btn sm" href="#evals">Open Evals</a>}>
      <DataTable
        id="ag-eval-runs"
        caption="Eval runs"
        rows={rows}
        rowKey={(r) => r.id}
        empty={{ title: "No eval runs", text: "Run the suite from Evals." }}
        columns={[
          { key: "id", label: "Run", render: (r) => <span className="mono">{r.id}</span> },
          { key: "score", label: "Score", render: (r) => <span className="mono">{r.score.toFixed(2)}</span> },
          { key: "version", label: "Version", render: (r) => <span className="mono">{r.version}</span> },
          { key: "model", label: "Model", render: (r) => <span className="mono">{r.model}</span> },
          { key: "by", label: "By", render: (r) => <Who id={r.by} /> },
          { key: "at", label: "When", align: "end", render: (r) => <span className="mono">{fmt.stamp(r.at)}</span> },
        ]}
      />
    </Card>
  );
}
