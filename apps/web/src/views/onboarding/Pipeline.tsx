/** The Pipeline tab: repos per stage, the filter, the waiting-for-merge callout and the table of repos (legacy onboarding.js pipeline). */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Empty, Segmented } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { STAGES, StatusChip, Steps, gaps, isStopped, needsMerge, stageName, status, useIntegrationsFor, useTeamName, type RepoV } from "./kit";

type Filter = "all" | "attention" | "progress" | "ready";

export function Pipeline({ project, repos, open }: { project: string; repos: RepoV[]; open: (repoId: string, tab?: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const teamName = useTeamName();
  const { all } = useIntegrationsFor(project);
  const now = Date.now();
  const counts = STAGES.map((s) => repos.filter((r) => r.onboarding.stage === s.id).length);
  const stopped = repos.filter(isStopped).length;
  const list = repos.filter((r) => {
    const s = status(r).id;
    return filter === "all" || (filter === "attention" ? s === "person" || s === "failed" || s === "merge" : filter === "ready" ? s === "ready" || s === "exception" : s === "progress" || s === "merge");
  });
  const waiting = repos.filter(needsMerge);
  const sourceName = (r: RepoV): string => (r.source ? all.find((x) => x.inst.id === r.source)?.inst.name ?? "source control" : "GitHub App");

  return (
    <div className="onb-pipe">
      <ol className="onb-strip" aria-label="Repos per onboarding stage">
        {STAGES.map((s, i) => (
          <li key={s.id} className={counts[i] ? "has-n" : ""}>
            <span className="onb-strip-no mono">{`STAGE ${i + 1}`}</span>
            <span className="onb-strip-n">{String(counts[i])}</span>
            <span className="onb-strip-l">{s.name}</span>
          </li>
        ))}
        <li className={`onb-strip-off${stopped ? " has-n" : ""}`}>
          <span className="onb-strip-no mono">OFF BELT</span>
          <span className="onb-strip-n">{String(stopped)}</span>
          <span className="onb-strip-l">Stopped</span>
        </li>
      </ol>
      {waiting.length ? (
        <div className="callout callout-warn">
          <Icon name="st-wait" />
          <div>
            <strong>{`${waiting.length} onboarding PR${waiting.length > 1 ? "s are" : " is"} green and waiting for a person to approve and merge: `}</strong>
            {waiting.map((r, i) => (
              <span key={r.id}>
                {i ? ", " : ""}
                <button type="button" className="linkish mono" id={`onb-wait-${r.id}`} onClick={() => open(r.id, "pr")}>{`${r.name}#${r.onboarding.pr!.number}`}</button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="toolbar">
        <Segmented name="onb-filter" label="Filter repos" value={filter} onChange={(v) => setFilter(v as Filter)} items={[{ id: "all", label: "All" }, { id: "attention", label: "Needs action" }, { id: "progress", label: "In progress" }, { id: "ready", label: "Ready" }]} />
        <span className="muted small">{`${list.length} of ${repos.length} repos`}</span>
      </div>
      {list.length ? (
        <div className="table-scroll" data-keep-scroll="onb-table">
          <table className="table onb-table">
            <thead>
              <tr>
                {["Repo", "Pipeline", "Stage", "Onboarding PR", "Gaps", "Time"].map((c, i) => (
                  <th key={c} scope="col" className={i === 4 ? "num" : ""}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const o = r.onboarding;
                const go = () => open(r.id);
                return (
                  <tr key={r.id} className="row-link" tabIndex={0} id={`onb-row-${r.id}`} aria-label={`Open onboarding detail for ${r.name}`} onClick={go} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }}>
                    <td>
                      <div className="onb-repo">
                        <span className="mono strong">{r.name}</span>
                        <span className="muted small">{`${r.lang || "Language not read yet"} · ${teamName(r.team)} · ${sourceName(r)}${r.tags.length ? ` · ${r.tags.join(", ")}` : ""}`}</span>
                      </div>
                    </td>
                    <td><Steps r={r} /></td>
                    <td>
                      <div className="onb-stage-cell">
                        <span className="strong">{stageName(o.stage)}</span>
                        <StatusChip r={r} />
                      </div>
                    </td>
                    <td>
                      {o.pr ? (
                        <span className="mono">{`#${o.pr.number}`}<span className="muted">{` · ${o.pr.state === "merged" ? "merged" : `checks ${o.pr.checks}`}`}</span></span>
                      ) : (
                        <span className="muted">none yet</span>
                      )}
                    </td>
                    <td className="num mono">{String(gaps(r).length)}</td>
                    <td className="mono small">{o.stage === "ready" ? (o.readyAt ? `ready ${fmt.ago(o.readyAt, now)}` : "ready") : `started ${fmt.ago(o.startedAt || o.timeline[0]?.at || now, now)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty id="onb-empty" title={repos.length ? "No repos match" : "No repos yet"} text={repos.length ? "Pick another filter." : "Connect a repo the GitHub App is installed on to start onboarding."} action={repos.length ? <Btn id="onb-filter-clear" label="Show all" onClick={() => setFilter("all")} /> : undefined} />
      )}
      <p className="footnote">Gantry reads each repo through the GitHub App, checks the onboarding PR's CI every minute, and moves repos on by itself. A person must approve and merge each onboarding PR.</p>
    </div>
  );
}
