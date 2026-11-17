/**
 * Suites and runs tab (legacy suitesTab): the suites, a real "Run suite" through the production runtime (sandboxes, no write access to real repos, own concurrency cap,
 * behind work orders), the run history and per-case results with the task count and range, the golden cases with their pinned snapshot, and the head-to-head of two runs.
 */
import { useState } from "react";
import { fmt, type Suite } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useActors } from "../../ui/actors";
import { Avatar, Btn, Chip, Empty, Field, FilterBar, LockNote, Meter, Panel, SearchBox, Select, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useOutcome, useAllRepos } from "../govern/data";
import { PassMark, ScoreN, agentOf, evalsUi, rerender, suiteOf, versionModel, type EvalsData, type RunRow } from "./kit";

const asRules = (c: Suite["cases"][number]): Array<{ kind: string; [k: string]: unknown }> => c.rules ?? [];
const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : "");

function AddCaseDialog({ su, perm, onDone }: { su: Suite; perm: Decision; onDone: () => void }) {
  const { repos } = useAllRepos();
  const [f, setF] = useState({ name: "", task: "", checks: "", repo: "", commit: "", mention: "", nomention: "", notouch: "" });
  const [err, setErr] = useState("");
  const out = useOutcome();
  const off = !perm.allowed;
  const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Eval suites" />
      <Field label="Case name" htmlFor="ev-case-name"><input id="ev-case-name" className="input" placeholder="e.g. Spec without a rollback section" value={f.name} disabled={off} onChange={set("name")} /></Field>
      <Field label="Task for the agent" htmlFor="ev-case-task" hint="What the agent is asked to do. Defaults to the case name. The checks below are never shown to it."><textarea id="ev-case-task" className="input" rows={3} value={f.task} disabled={off} onChange={set("task")} /></Field>
      <div className="form-row">
        <Field label="Repo snapshot" htmlFor="ev-case-repo" hint="Pins the task to a repository. The run reads it only; nothing is written back.">
          <Select id="ev-case-repo" value={f.repo} disabled={off} options={[{ value: "", label: "No repository" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} onChange={(v) => setF((p) => ({ ...p, repo: v }))} />
        </Field>
        <Field label="Commit" htmlFor="ev-case-commit" hint="Leave empty to use the commit recorded for the repo now."><input id="ev-case-commit" className="input mono" placeholder="40 hex characters" value={f.commit} disabled={off || !f.repo} onChange={set("commit")} /></Field>
      </div>
      <Field label="Must mention (one per line)" htmlFor="ev-case-mention"><textarea id="ev-case-mention" className="input" rows={2} value={f.mention} disabled={off} onChange={set("mention")} /></Field>
      <Field label="Must not mention (one per line)" htmlFor="ev-case-nomention"><textarea id="ev-case-nomention" className="input" rows={2} value={f.nomention} disabled={off} onChange={set("nomention")} /></Field>
      <Field label="Must not touch paths (one per line)" htmlFor="ev-case-notouch"><textarea id="ev-case-notouch" className="input" rows={2} value={f.notouch} disabled={off} onChange={set("notouch")} /></Field>
      <Field label="What it checks" htmlFor="ev-case-checks" hint="In your words. Kept with the case as an advisory note: a model's opinion never decides a result, the checks above do."><textarea id="ev-case-checks" className="input" rows={3} placeholder="What a passing answer must do" value={f.checks} disabled={off} onChange={set("checks")} /></Field>
      <div className="form-err" role="alert">{err}</div>
      <div className="dlg-actions-inline">
        <Btn label="Add case" kind="primary" id="ev-case-ok" guard={perm} onClick={() => {
          void ops.addEvalCase(su.id, {
            name: f.name, ...(f.task.trim() ? { task: f.task.trim() } : {}), ...(f.checks.trim() ? { checks: f.checks.trim() } : {}), ...(f.repo ? { repo: f.repo } : {}), ...(f.commit.trim() ? { commit: f.commit.trim() } : {}),
            mustMention: lines(f.mention), mustNotMention: lines(f.nomention), mustNotTouch: lines(f.notouch),
          }).then((r) => { if (!r.ok) { setErr(r.msg); return; } out(r); onDone(); });
        }} />
      </div>
    </div>
  );
}

function CasesList({ su }: { su: Suite }) {
  const who = useActors();
  return (
    <details className="ev-cases" id={`ev-cases-${su.id}`}>
      <summary>{`${su.cases.length} cases in ${su.id}`}</summary>
      <ol className="plain-list small ev-case-list">
        {su.cases.map((c) => (
          <li key={c.id}>
            <span className="mono muted">{`${c.id} `}</span>{c.name}
            {c.golden ? <span className="chip" title={`Pinned to ${c.repo} at ${c.commit}`}>{` golden ${c.repo}@${short(c.commit)}`}</span> : null}
            {asRules(c).filter((r) => r.kind !== "model_graded").length ? <span className="muted">{` · ${asRules(c).filter((r) => r.kind !== "model_graded").length} check${asRules(c).filter((r) => r.kind !== "model_graded").length === 1 ? "" : "s"}`}</span> : null}
            {c.by && c.added ? <span className="muted">{` · added ${fmt.istDate(c.added)} by ${who(c.by).name}`}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function RunDetail({ su, sel, who }: { su: Suite; sel: RunRow; who: (id: string) => { name: string } }) {
  const caseName = (id: string) => su.cases.find((x) => x.id === id)?.name ?? id;
  const pass = sel.score >= su.threshold;
  return (
    <div>
      <div className="run-head">
        <span className="mono strong">{sel.id}</span>
        <span>{`${sel.agent} ${sel.version} on`}</span><span className="mono">{sel.model || "stub adapter"}</span>
        <span className="muted small">{`${fmt.stamp(sel.at)} · by ${who(sel.by).name} · ${fmt.money(sel.cost)}${sel.override ? " · model override (does not qualify the version)" : ""}${sel.seeded ? " · seeded demo run" : ""}`}</span>
        {sel.status === "completed" ? (
          <span className={`decision-inline ${pass ? "pos" : "neg"}`}><Icon name={pass ? "check" : "x"} />{`${fmt.pct(sel.score)} ${pass ? "passes" : "below"} ${fmt.pct(su.threshold)}`}</span>
        ) : <span className="muted small">{sel.status}</span>}
      </div>
      {sel.status === "completed" || sel.status === "failed" ? <p className="small mono ev-range" id="ev-range">{`${sel.passed ?? 0} of ${sel.count ?? 0} tasks passed${(sel.repeats ?? 1) > 1 ? `, each run ${sel.repeats} times` : ""}. 95% range ${fmt.pct(sel.range?.[0] ?? 0)} to ${fmt.pct(sel.range?.[1] ?? 0)}.${(sel.count ?? 0) < 10 ? " Few tasks: read the range, not the point." : ""}`}</p> : null}
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr>{["Case", "Result", "Reason", "Time"].map((x, i) => <th key={x} scope="col" className={i === 3 ? "num" : ""}>{x}</th>)}</tr></thead>
          <tbody>
            {sel.results.map((r) => (
              <tr key={r.caseId} className={r.pass ? "" : "ev-fail-row"}>
                <td><span className="mono muted">{`${r.caseId} `}</span>{caseName(r.caseId)}</td>
                <td>{r.pass ? <span className="state state-done"><Icon name="st-done" /><span>Pass</span></span> : <span className="state state-failed"><Icon name="st-fail" /><span>Fail</span></span>}{r.repeats ? <span className="mono small muted">{` ${r.passes}/${r.repeats}`}</span> : null}</td>
                <td className="small">{r.reason || <span className="muted">–</span>}{r.advisory?.length ? <div className="muted small">{`Advisory: ${r.advisory.map((a) => a.label).join("; ")}`}</div> : null}</td>
                <td className="num mono">{`${(r.ms / 1000).toFixed(1)}s`}</td>
              </tr>
            ))}
            {!sel.results.length ? <tr><td colSpan={4} className="muted small">{sel.status === "running" || sel.status === "queued" ? "No case has finished yet." : "No results."}</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SuiteDetail({ d }: { d: EvalsData }) {
  const ui_ = useUI();
  const out = useOutcome();
  const who = useActors();
  const perm = useCan("eval.run");
  const su = suiteOf(d, evalsUi.suite)!;
  const ag = agentOf(d, su.agent);
  const runs = d.runsOf(su.id).slice().reverse();
  const active = runs.find((r) => r.status === "queued" || r.status === "running");
  if (!ag) return <Panel title={`${su.id} · ${su.name}`} cls="ev-suite"><Empty title="No agent" text={`${su.agent || "This suite"} has no agent to run.`} /><CasesList su={su} /></Panel>;
  if (!evalsUi.runVersion || !ag.versions.some((v) => v.v === evalsUi.runVersion)) evalsUi.runVersion = (ag.versions.find((v) => v.rc) ?? ag.versions[ag.versions.length - 1])!.v;
  const ver = ag.versions.find((v) => v.v === evalsUi.runVersion)!;
  const pinned = versionModel(ag, ver);
  const models = d.models;
  if (!evalsUi.runModel || (!models.some((m) => m.value === evalsUi.runModel) && evalsUi.runModel !== pinned)) evalsUi.runModel = pinned;
  const modelOpts = models.some((m) => m.value === pinned) || !pinned ? models : [{ value: pinned, label: pinned }, ...models];
  const runGuard: Decision | null = !perm.allowed ? perm : active ? { allowed: false, needs: "", reason: `A run is already in progress on ${su.id} (${active.id}).` } : !su.cases.length ? { allowed: false, needs: "", reason: "The suite has no cases yet. Add one first." } : null;
  const sel = runs.find((r) => r.id === evalsUi.run) ?? runs[0];
  return (
    <Panel title={`${su.id} · ${su.name}`} cls="ev-suite">
      <div>
        <LockNote decision={perm} what="Running suites" />
        <div className="run-bar">
          <Field label="Version" htmlFor="ev-run-ver"><Select id="ev-run-ver" disabled={!perm.allowed} value={evalsUi.runVersion} options={ag.versions.map((v) => ({ value: v.v, label: `${ag.name} ${v.v}${v.live ? " (floor)" : v.rc ? " (candidate)" : " (retired)"}` }))} onChange={(v) => { evalsUi.runVersion = v; evalsUi.runModel = null; rerender(); }} /></Field>
          <Field label="Model" htmlFor="ev-run-model"><Select id="ev-run-model" disabled={!perm.allowed} value={evalsUi.runModel} options={modelOpts.length ? modelOpts : [{ value: "", label: "Stub adapter (no model)" }]} onChange={(v) => { evalsUi.runModel = v; rerender(); }} /></Field>
          <Field label="Each task" htmlFor="ev-run-repeats"><Select id="ev-run-repeats" disabled={!perm.allowed} value={String(evalsUi.repeats)} options={[1, 2, 3, 5].map((n) => ({ value: String(n), label: n === 1 ? "once (smoke set)" : `${n} times` }))} onChange={(v) => { evalsUi.repeats = Number(v); rerender(); }} /></Field>
          <Btn label={active ? "Running…" : "Run suite"} kind="primary" icon="play" id="ev-run-btn" guard={runGuard}
            onClick={() => { void ops.runSuite(ag.id, su.id, ver.v, evalsUi.runModel ?? undefined, evalsUi.repeats).then((r) => { out(r); if (r.ok) { evalsUi.run = (r as { run?: string }).run ?? null; rerender(); } }); }} />
          {active ? (
            <div className="run-progress" role="status">
              <div className="meter"><span className="meter-fill" style={{ width: `${active.total ? Math.round(((active.done ?? 0) / active.total) * 100) : 0}%` }} /></div>
              <span className="mono small">{`${active.done ?? 0} / ${active.total ?? 0} runs · ${active.results.filter((x) => x.pass).length} cases passed so far`}</span>
              <Btn label="Cancel run" small id="ev-run-cancel" guard={perm} onClick={() => { void ops.cancelEvalRun(su.id, active.id).then((r) => out(r)); }} />
            </div>
          ) : <span className="small muted">{`Runs go through the same runtime as work, in sandboxes with no write access to real repositories, behind work orders: ${su.cases.length} golden case${su.cases.length === 1 ? "" : "s"}, gate ${fmt.pct(su.threshold)}.`}</span>}
          <Btn label="Add case" icon="plus" id="ev-add-case" guard={perm} onClick={() => { ui_.dialog({ title: `Add a case to ${su.id}`, kicker: `Evals · ${su.name}`, sub: "The case runs from the next suite run on. Existing runs keep their score. Audited.", wide: true, body: (close) => <AddCaseDialog su={su} perm={perm} onDone={close} />, actions: [{ label: "Close" }] }); }} />
        </div>
        <CasesList su={su} />
        <div className="suite-split">
          <div>
            <h3 className="sub-h">Run history</h3>
            {runs.length ? (
              <ul className="run-list" data-keep-scroll="ev-runs">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button type="button" className={`run-item${evalsUi.run === r.id || (!evalsUi.run && r === sel) ? " is-on" : ""}`} id={`ev-run-${r.id}`} onClick={() => { evalsUi.run = r.id; rerender(); }}>
                      <span className="mono strong">{r.id}</span><span className="mono">{r.version}</span><span className="mono muted small ev-run-model">{r.model || "stub"}</span>
                      {r.status === "completed" ? <span className={`mono ${r.score >= su.threshold ? "pos" : "neg"}`}>{`${r.score >= su.threshold ? "✓ " : "▼ "}${fmt.pct(r.score)}`}<span className="muted small">{` n=${r.count ?? 0}`}</span></span> : <span className="mono muted">{r.status}</span>}
                      <span className="muted small">{fmt.istDate(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No runs yet" text="Run the suite to get a first score." />}
          </div>
          <div className="ev-run-detail"><h3 className="sub-h">Case results</h3>{sel ? <RunDetail su={su} sel={sel} who={who} /> : null}</div>
        </div>
      </div>
    </Panel>
  );
}

function HeadToHead({ d }: { d: EvalsData }) {
  const su = suiteOf(d, evalsUi.suite)!;
  const runs = d.runsOf(su.id).filter((r) => r.status === "completed").reverse();
  if (runs.length < 2) return <Panel title="Head-to-head"><Empty title="Need two runs" text={`Run ${su.id} with another version or model to compare.`} /></Panel>;
  if (!evalsUi.a || !runs.some((r) => r.id === evalsUi.a)) evalsUi.a = runs[0]!.id;
  const A = runs.find((r) => r.id === evalsUi.a)!;
  if (!evalsUi.b || !runs.some((r) => r.id === evalsUi.b) || evalsUi.b === evalsUi.a) evalsUi.b = (runs.find((r) => r.id !== evalsUi.a && (r.model !== A.model || r.version !== A.version)) ?? runs.find((r) => r.id !== evalsUi.a)!).id;
  const B = runs.find((r) => r.id === evalsUi.b)!;
  const opt = runs.map((r) => ({ value: r.id, label: `${r.id} · ${r.version} · ${r.model || "stub"} · ${fmt.pct(r.score)}` }));
  let onlyA = 0, onlyB = 0, both = 0, neither = 0;
  const rows = su.cases.map((c) => {
    const ra = A.results.find((x) => x.caseId === c.id) ?? { pass: false };
    const rb = B.results.find((x) => x.caseId === c.id) ?? { pass: false };
    if (ra.pass && !rb.pass) onlyA++; else if (!ra.pass && rb.pass) onlyB++; else if (ra.pass) both++; else neither++;
    const diff = ra.pass !== rb.pass;
    return (
      <tr key={c.id} className={diff ? "row-diff" : ""}>
        <td><span className="mono muted">{`${c.id} `}</span>{c.name}</td><td><PassMark pass={ra.pass} /></td><td><PassMark pass={rb.pass} /></td>
        <td className="small">{diff ? (ra.pass ? "Only A passes" : "Only B passes") : !ra.pass ? "Both fail" : ""}</td>
      </tr>
    );
  });
  const avg = (r: RunRow): number => (r.results.length ? r.results.reduce((t, x) => t + x.ms, 0) / r.results.length / 1000 : 0);
  const side = (label: string, r: RunRow) => (
    <div className="h2h-side">
      <div className="kicker">{`${label} · ${r.version}`}</div><div className="mono small">{r.model || "stub"}</div>
      <div className={`big-num${r.score >= su.threshold ? " pos" : " neg"}`}>{fmt.pct(r.score)}</div>
      <div className="small muted">{`${r.passed ?? 0} of ${r.count ?? 0} tasks, range ${fmt.pct(r.range?.[0] ?? 0)} to ${fmt.pct(r.range?.[1] ?? 0)}`}</div>
      <div className="small muted">{`${avg(r).toFixed(1)}s per case · ${fmt.money(r.cost)}`}</div>
    </div>
  );
  const delta = B.score - A.score;
  const overlap = (A.range?.[1] ?? 0) >= (B.range?.[0] ?? 0) && (B.range?.[1] ?? 0) >= (A.range?.[0] ?? 0);
  return (
    <Panel title={`Head-to-head on ${su.id}`} cls="ev-h2h">
      <div>
        <div className="form-row">
          <Field label="A" htmlFor="h2h-a"><Select id="h2h-a" options={opt} value={evalsUi.a} onChange={(v) => { evalsUi.a = v; rerender(); }} /></Field>
          <Field label="B" htmlFor="h2h-b"><Select id="h2h-b" options={opt.map((o) => ({ ...o, disabled: o.value === evalsUi.a }))} value={evalsUi.b} onChange={(v) => { evalsUi.b = v; rerender(); }} /></Field>
        </div>
        <div className="h2h-sum">
          {side("A", A)}
          <div className="h2h-mid mono small">
            <div className={`ev-delta ${delta >= 0 ? "pos" : "neg"}`}>{`${delta >= 0 ? "+" : ""}${fmt.pct(delta)} B vs A`}</div>
            {`${both} both pass`}<br />{`${onlyA} only A`}<br />{`${onlyB} only B`}<br />{`${neither} both fail`}
          </div>
          {side("B", B)}
        </div>
        {overlap ? <p className="small muted" id="ev-h2h-note">The ranges overlap: with this many tasks the difference may be noise. Compare task by task below.</p> : null}
        <div className="table-scroll"><table className="table table-compact"><thead><tr><th scope="col">Case</th><th scope="col">A</th><th scope="col">B</th><th scope="col">Difference</th></tr></thead><tbody>{rows}</tbody></table></div>
      </div>
    </Panel>
  );
}

type SuiteTableRow = { su: Suite; agentName: string; agentId: string; cases: number; last: number | null; n: number | null; runs: number };

export function SuitesTab({ d }: { d: EvalsData }) {
  const agentSuite = agentOf(d, evalsUi.agent)?.suite;
  const [q, setQ] = useState("");
  if (!evalsUi.suite || !suiteOf(d, evalsUi.suite)) evalsUi.suite = (d.suites.find((s) => s.id === agentSuite) ?? d.suites[0])?.id ?? null;
  if (!d.suites.length) return <Empty title="No suites yet" text="Create an agent: it gets a golden set to add cases to." />;
  const all: SuiteTableRow[] = d.suites.map((su) => {
    const runs = d.runsOf(su.id);
    const done = runs.filter((r) => r.status === "completed");
    const last = done[done.length - 1];
    const ag = agentOf(d, su.agent);
    return { su, agentName: ag ? ag.name : su.name, agentId: ag?.id ?? su.agent, cases: su.cases.length, last: last ? last.score : null, n: last ? last.count ?? 0 : null, runs: runs.length };
  });
  const term = q.trim().toLowerCase();
  const rows = all.filter((r) => !term || `${r.su.name} ${r.su.id} ${r.agentName}`.toLowerCase().includes(term));
  const pick = (r: SuiteTableRow): void => { evalsUi.suite = r.su.id; evalsUi.run = null; evalsUi.a = evalsUi.b = null; evalsUi.runVersion = null; evalsUi.runModel = null; rerender(); };
  const cols: SortCol<SuiteTableRow>[] = [
    { key: "suite", label: "Suite", sort: (r) => r.su.name.toLowerCase(), render: (r) => <span className="stack" style={{ gap: 0 }}><b className="ell">{r.su.name}</b><span className="mono dim ell" style={{ fontSize: 11 }}>{r.su.id}</span></span> },
    { key: "agent", label: "Agent", sort: (r) => r.agentName.toLowerCase(), render: (r) => <span className="row nowrap"><Avatar id={r.agentId} size="sm" />{r.agentName}{r.su.builtin ? <Chip text="built-in" cls="agent" /> : null}</span> },
    { key: "cases", label: "Cases", sort: (r) => r.cases, align: "end", render: (r) => <span className="mono">{r.cases}</span> },
    { key: "last", label: "Last score", sort: (r) => r.last ?? -1, render: (r) => r.last === null ? <span className="dim">{"\u2013"}</span> : <span className="row nowrap"><span className="mono">{r.last.toFixed(2)}</span><span style={{ width: 100 }}><Meter value={r.last} max={1} label={`${r.su.id} last score`} warnAt={2} /></span><span className="dim mono" style={{ fontSize: 11 }}>{r.last >= r.su.threshold ? "" : "below gate"}</span>{r.n ? <span className="dim mono" style={{ fontSize: 11 }}>{`n=${r.n}`}</span> : null}</span> },
    { key: "gate", label: "Threshold", sort: (r) => r.su.threshold, align: "end", render: (r) => <span className="mono">{r.su.threshold.toFixed(2)}</span> },
    { key: "runs", label: "Runs", sort: (r) => r.runs, align: "end", render: (r) => <span className="mono">{r.runs}</span> },
  ];
  return (
    <div className="ev-suites">
      <div className="ev-suites-list" data-keep-scroll="ev-suites">
        <FilterBar label="Filter suites" count={`${rows.length} of ${all.length}`}>
          <SearchBox id="ev-search" value={q} onChange={setQ} placeholder="Search suites" />
        </FilterBar>
        <DataTable id="ev-su-table" caption="Eval suites" columns={cols} rows={rows} rowKey={(r) => r.su.id} rowId={(r) => `ev-su-${r.su.id}`} onRow={pick} pageSize={12} empty={{ title: "No suites match", text: "Clear the search to see every suite." }} />
      </div>
      <div className="ev-suites-main"><SuiteDetail d={d} /><HeadToHead d={d} /></div>
    </div>
  );
}
export { ScoreN };
