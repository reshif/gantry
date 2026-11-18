/**
 * Evals (spec 8.7, 13.2). Port of legacy/js/views/evals.js against /api/v1: per-agent scorecards from live work, suites with a real "Run suite" through the production runtime
 * (the same launcher, edge and runner as work, in sandboxes with no write access to real repositories, under their own concurrency cap and behind work orders), run history with
 * the task count and a range, head-to-head of two runs task by task, regressions, promotion eligibility, and factory-wide views.
 * Not ported, on purpose: the legacy "Runs are simulated locally" timer and its random pass/fail. A model-graded check is advisory only; deterministic checks decide.
 */
import { useEffect } from "react";
import { usePrefs } from "../lib/prefs";
import { Btn, Empty, Tabs } from "../ui/primitives";
import { Async } from "../ui/async";
import { Page, Stats } from "../ui/cr";
import { setUrlParams, useUrlState } from "./urlState";
import { SuitesTab, useRunSuites } from "./evals/Suites";
import { agentOf, evalsUi, suiteOf, useEvalsData, useEvalsUi, type EvalsData, type EvalsTab, type RunRow } from "./evals/kit";
import { RunsTab } from "./evals/Runs";

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

const TABS: EvalsTab[] = ["suites", "runs"];
const SUB = "Golden-set suites that decide whether an agent change may go live.";

export default function EvalsView() {
  useEvalsUi();
  const d = useEvalsData();
  usePrefs();
  const [url, setUrl] = useUrlState({ tab: "suites", q: "", sort: "", dir: "", suite: "", run: "" });
  const runner = useRunSuites(d);
  // another screen (Agents) asked for a suite: its request becomes URL state once, so a reload keeps it
  useEffect(() => {
    if (evalsUi.suite && !url.suite) setUrlParams({ suite: evalsUi.suite, ...(evalsUi.tab !== "suites" ? { tab: evalsUi.tab } : {}) });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tab = (TABS as string[]).includes(url.tab) ? (url.tab as EvalsTab) : "suites";
  evalsUi.tab = tab;
  evalsUi.suite = url.suite || null;
  evalsUi.run = url.run || null;
  const head = <Page eyebrow="Workforce" title="Evals" sub={SUB} />;
  if (d.q.data === undefined) return <div className="view view-evals">{head}<Async query={d.q as never} what="evals" id="evals">{() => null}</Async></div>;
  if (!d.agents.length) return <div className="view view-evals">{head}<Empty title="No agents" text="Create an agent to see how it does its job." /></div>;
  const lastOf = (id: string): RunRow | undefined => { const done = d.runsOf(id).filter((r) => r.status === "completed"); return done[done.length - 1]; };
  const passing = d.suites.filter((su) => { const last = lastOf(su.id); return !!last && last.score >= su.threshold; }).length;
  const below = d.suites.filter((su) => { const last = lastOf(su.id); return !!last && last.score < su.threshold; }).length;
  const setTab = (t: string): void => { evalsUi.run = null; setUrl({ tab: t, q: "", sort: "", dir: "", suite: t === "suites" ? url.suite : "", run: "" }); };
  const body = tab === "suites" ? <SuitesTab d={d} url={url} setUrl={setUrl} runner={runner} /> : <RunsTab d={d} url={url} setUrl={setUrl} />;
  const all = d.suites.map((s) => s.id);
  return (
    <div className="view view-evals">
      <Page eyebrow="Workforce" title="Evals" sub={SUB}
        acts={<Btn label="Run all suites" kind="primary" icon="play" id="ev-run-all" guard={runner.guard.allowed ? null : runner.guard} onClick={() => runner.start(all)} />}>
        <div id="ev-stats">
          <Stats items={[
            { l: "Suites", v: String(d.suites.length), tone: "info" },
            { l: "Passing", v: String(passing), tone: "ok" },
            { l: "Below threshold", v: String(below), tone: "bad" },
            { l: "Runs, 7 days", v: String(d.runs.filter((r) => r.at > Date.now() - 7 * DAY).length), tone: "agent" },
          ]} />
        </div>
        <Tabs idPrefix="ev-tab" items={[{ id: "suites", label: "Suites" }, { id: "runs", label: "Runs" }]} active={tab} onChange={setTab} />
        {body}
      </Page>
    </div>
  );
}
