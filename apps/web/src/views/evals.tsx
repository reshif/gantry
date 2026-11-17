/**
 * Evals (spec 8.7, 13.2). Port of legacy/js/views/evals.js against /api/v1: per-agent scorecards from live work, suites with a real "Run suite" through the production runtime
 * (the same launcher, edge and runner as work, in sandboxes with no write access to real repositories, under their own concurrency cap and behind work orders), run history with
 * the task count and a range, head-to-head of two runs task by task, regressions, promotion eligibility, and factory-wide views.
 * Not ported, on purpose: the legacy "Runs are simulated locally" timer and its random pass/fail. A model-graded check is advisory only; deterministic checks decide.
 */
import { fmt } from "@gantry/domain";
import { useMemo } from "react";
import { usePrefs } from "../lib/prefs";
import { Empty, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useProjects } from "../api/queries";
import { FactoryTab } from "./evals/Factory";
import { LinkedOutcomes, ScorecardsTab } from "./evals/Scorecards";
import { SuitesTab } from "./evals/Suites";
import { agentOf, evalsUi, rerender, suiteOf, useEvalsData, useEvalsUi, type EvalsData, type EvalsTab, type RunRow } from "./evals/kit";

const DAY = 86_400_000;

interface Regression { suite: NonNullable<ReturnType<typeof suiteOf>>; run: RunRow; base: RunRow; delta: number; agentId: string; agentName: string }

/** A run in the last 14 days that scored 3 points under the live version's last completed run, or the live version under its gate (legacy regressions). Model overrides are not the live version. */
export function regressionsOf(d: EvalsData, now = Date.now()): Regression[] {
  const out: Regression[] = [];
  for (const su of d.suites) {
    const ag = agentOf(d, su.agent);
    const live = ag?.versions.find((v) => v.live);
    if (!ag || !live) continue;
    const runs = d.runsOf(su.id).filter((r) => r.status === "completed");
    const base = runs.filter((r) => r.version === live.v && !r.override).pop();
    if (!base) continue;
    const seen = new Set<string>();
    for (const r of runs.slice().reverse()) {
      if (r.id === base.id || r.at < now - 14 * DAY) continue;
      const key = `${r.version}|${r.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.score < base.score - 0.03 || (r.version === live.v && r.score < su.threshold)) out.push({ suite: su, run: r, base, delta: r.score - base.score, agentId: ag.id, agentName: ag.name });
    }
  }
  return out;
}

export default function EvalsView() {
  useEvalsUi();
  const d = useEvalsData();
  usePrefs();
  const projectsData = useProjects().data;
  const label = useMemo(() => (c: { agent: string; cls: string; project: string; repo: string | null }): string => {
    const a = d.agents.find((x) => x.id === c.agent)?.name ?? c.agent;
    const p = (projectsData ?? []).find((x) => x.id === c.project)?.name ?? c.project;
    return `${a} · ${c.cls} · ${p}${c.repo ? ` · ${c.repo}` : ""}`;
  }, [d.agents, projectsData]);
  if (d.q.data === undefined) return <div className="view view-evals"><ViewHead title="Evals" /><Async query={d.q as never} what="evals" id="evals">{() => null}</Async></div>;
  if (!d.agents.length) return <div className="view view-evals"><ViewHead title="Evals" /><Empty title="No agents" text="Create an agent to see how it does its job." /></div>;
  const regs = regressionsOf(d);
  let eligible = 0;
  let waiting = 0;
  for (const a of d.agents) for (const v of a.versions) if (v.rc) { waiting++; if (v.eligibility.ok) eligible++; }
  const tab = evalsUi.tab as EvalsTab;
  const body = tab === "suites" ? <SuitesTab d={d} /> : tab === "factory" ? <FactoryTab d={d} /> : <ScorecardsTab d={d} label={label} />;
  const overall = d.extra?.overrideRate ?? 0;
  const cards = Object.values(d.scorecards);
  const avg = (k: "taskSuccess" | "firstPass" | "rework"): string => { const v = cards.map((c) => c[k]).filter((x): x is number => typeof x === "number"); return v.length ? fmt.pct(v.reduce((x, y) => x + y, 0) / v.length) : "–"; };
  return (
    <div className="view view-evals">
      <ViewHead title="Evals" sub="Golden-set suites decide whether an agent version is allowed to serve." />
      <StatRow id="ev-stats">
        <Stat label="Task success" value={avg("taskSuccess")} sub="7-day, all agents" tone="done" />
        <Stat label="First pass" value={avg("firstPass")} sub="no rework" tone="done" />
        <Stat label="Rework rate" value={avg("rework")} tone="wait" />
        <Stat label="Human override" value={fmt.pct(overall)} sub="of classifications" />
        <Stat label="Suites" value={String(d.suites.length)} sub={`${d.runs.length} runs`} />
      </StatRow>
      {regs.length ? (
        <div className="callout callout-fail ev-regs" role="note">
          <Icon name="st-fail" />
          <div>
            <strong>{`${regs.length} regression${regs.length > 1 ? "s" : ""} in the last 14 days. `}</strong>
            <ul className="plain-list">
              {regs.map((r, i) => (
                <li key={`${r.run.id}`}>
                  <button type="button" className="linkish" id={`ev-reg-${i}`} onClick={() => { evalsUi.tab = "suites"; evalsUi.suite = r.suite.id; evalsUi.run = r.run.id; evalsUi.a = r.run.id; evalsUi.b = r.base.id; rerender(); }}>
                    {`${r.suite.id}: ${r.agentName} ${r.run.version} on ${r.run.model || "stub"} scored ${fmt.pct(r.run.score)} vs ${fmt.pct(r.base.score)} for the floor version (${r.delta >= 0 ? "+" : ""}${fmt.pct(r.delta)}). Compare`}
                  </button>
                  <LinkedOutcomes agentId={r.agentId} idp={`ev-reg-${i}`} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <Tabs idPrefix="ev-tab" items={[{ id: "agents", label: "Scorecards" }, { id: "suites", label: "Suites and runs", count: d.suites.length }, { id: "factory", label: "Factory-wide" }]} active={tab} onChange={(t) => { evalsUi.tab = t as EvalsTab; rerender(); }} />
      {body}
    </div>
  );
}
