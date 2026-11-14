/** The repo drawer (legacy onboarding.js drawer): status, stepper, callouts, actions and the Findings, Pull request, Timeline, Settings and History tabs. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useGuidelines, useProjects, useRepos } from "../../api/queries";
import { Btn, Empty, Tabs, Who, LockNote } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { HistoryList } from "../project-config/history";
import { SettingsDialog } from "./Settings";
import { BUSY, StatusChip, Steps, gaps, instLabel, needsMerge, stageName, useIntegrationsFor, usePrFiles, useTeamName, type RepoV } from "./kit";

const tabMemory: Record<string, string> = {};
export const rememberTab = (repoId: string, tab: string): void => { tabMemory[repoId] = tab; };

const fixable = (r: RepoV): boolean => r.onboarding.findings.some((f) => !f.ok && !!f.file && !f.manual);

function SevMark({ sev }: { sev: string }) {
  return (
    <span className={`onb-sev onb-sev-${sev}`} title={`Severity ${sev}`}>
      <span className="onb-sev-shape" aria-hidden="true" />
      {sev}
    </span>
  );
}

function FindingsTab({ r }: { r: RepoV }) {
  const o = r.onboarding;
  const f = o.findings;
  const v = o.verification;
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const list = f.slice().sort((a, b) => Number(a.ok) - Number(b.ok) || (order[a.sev] ?? 3) - (order[b.sev] ?? 3));
  const stamp = (t: number) => fmt.stamp(t);
  return (
    <div>
      {!f.length ? (
        <Empty title="Not assessed yet" text="The Onboarding agent lists findings once the assessment finishes." />
      ) : (
        <ul className="onb-findings">
          {list.map((x) => {
            const inPR = !!o.pr && o.pr.files.some((p) => p.finding === x.id);
            return (
              <li key={x.id} className={x.ok ? "is-ok" : "is-gap"}>
                <span className="onb-f-ic"><Icon name={x.ok ? "check" : x.manual ? "human" : "alert"} /></span>
                <div className="onb-f-main">
                  <div className="onb-f-t">
                    <strong>{x.check}</strong>
                    {x.ok ? <span className="muted small">passes</span> : <SevMark sev={x.sev} />}
                    {!x.ok && x.required === false ? <span className="muted small"> · advisory</span> : null}
                  </div>
                  {x.ok ? null : (
                    <div className="small">
                      {x.fix}
                      {x.file ? <> · <span className="mono">{x.file}</span></> : null}
                    </div>
                  )}
                  {x.detail ? <div className="muted small">{x.detail}</div> : null}
                  {x.ok ? null : <div className="muted small">{x.manual ? "Cannot be fixed by the PR. Needs a person with access." : inPR ? "Fixed in the onboarding PR." : x.file ? "Will be fixed in the onboarding PR." : "Documented in AGENTS.md by the PR."}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {v ? (
        <>
          <h3 className="sub-h">{`Live checks · ${v.ok ? "all passed" : v.unknown && v.checks.every((c) => c.ok || c.unknown) ? "could not finish" : "not all passed"}`}</h3>
          <p className="muted small">{`Checked ${stamp(v.at)}, ${v.trigger === "schedule" ? "by the scheduled re-check" : v.trigger === "merge" ? "after the merge" : "on request"}. Ready means all of these hold, checked on GitHub.`}</p>
          <ul className="onb-findings" id="onb-live-checks">
            {v.checks.map((c) => (
              <li key={c.id} className={c.ok ? "is-ok" : c.unknown ? "is-gap" : "is-gap"}>
                <span className="onb-f-ic"><Icon name={c.ok ? "check" : c.unknown ? "clock" : "alert"} /></span>
                <div className="onb-f-main">
                  <div className="onb-f-t"><strong>{c.label}</strong><span className="muted small">{c.ok ? "holds" : c.unknown ? "could not be checked" : "fails"}</span></div>
                  <div className={c.ok ? "muted small" : "small"}>{c.detail}{c.at ? <span className="muted">{` (checked ${stamp(c.at)})`}</span> : null}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PrTab({ r }: { r: RepoV }) {
  const pr = r.onboarding.pr;
  const actor = useActors();
  const g = useGuidelines().data;
  const files = usePrFiles(r.id, !!pr, `${pr?.number}:${pr?.headSha}`);
  if (!pr) return <Empty title="No PR yet" text={r.onboarding.stage === "person" ? "A person must fix the blocker before the agent can open a PR." : "The Onboarding agent opens a PR after the assessment."} />;
  const plus = pr.files.reduce((s, f) => s + f.plus, 0);
  const minus = pr.files.reduce((s, f) => s + f.minus, 0);
  const checks = r.config.requiredChecks.map((c) => ({ name: c, st: pr.state === "merged" || pr.checks === "green" ? "ok" : pr.checks === "red" ? "bad" : pr.checks === "running" ? "warn" : "pending" }));
  const added = (path: string): string[] => files.data?.files.find((x) => x.path === path)?.added ?? [];
  return (
    <div className="onb-pr">
      <div className="onb-pr-head">
        <span className="mono strong">{`#${pr.number}`}</span>
        <strong>{pr.title}</strong>
        <span className={`chip ${pr.state === "merged" ? "chip-accent" : ""}`}>{pr.state === "merged" ? `Merged by ${actor(pr.mergedBy).name}` : pr.state === "closed" ? "Closed" : "Open"}</span>
        {pr.url ? <a className="small" href={pr.url} target="_blank" rel="noreferrer noopener" id="onb-pr-link">Open on GitHub</a> : null}
      </div>
      <div className="kv-row">
        <div className="kv"><div className="kv-k">Branch</div><div className="kv-v mono">{`${pr.branch} → ${r.config.defaultBranch}`}</div></div>
        <div className="kv"><div className="kv-k">Files</div><div className="kv-v mono">{`${pr.files.length} `}<span className="pos">{`+${plus}`}</span>{" "}<span className="neg">{`−${minus}`}</span></div></div>
        <div className="kv"><div className="kv-k">Checks</div><div className="kv-v">{pr.checks}</div></div>
      </div>
      <h3 className="sub-h">Checks</h3>
      <ul className="checklist">
        {checks.map((c) => (
          <li key={c.name} className={c.st}>
            <Icon name={c.st === "ok" ? "check" : c.st === "bad" ? "x" : c.st === "warn" ? "clock" : "dots"} />
            <span className="mono">{c.name}</span>
            <span className="muted small">{c.st === "ok" ? "passed" : c.st === "bad" ? "failed" : c.st === "warn" ? "running" : "waiting to start"}</span>
          </li>
        ))}
        {!checks.length ? <li className="pending"><span className="muted small">No required checks are set for this repo.</span></li> : null}
      </ul>
      <h3 className="sub-h">Reviewers from project approvers</h3>
      {pr.reviewers.length ? <div className="onb-revs">{pr.reviewers.map((id) => <Who key={id} id={id} />)}</div> : <p className="muted small">None assigned. Anyone with merge rights on onboarding PRs in this project can approve.</p>}
      <h3 className="sub-h">Files changed</h3>
      <ul className="onb-files">
        {pr.files.map((f) => {
          const lines = added(f.path);
          return (
            <li key={f.path}>
              <details id={`onb-file-${f.path.replace(/[^a-z0-9]/gi, "-")}`}>
                <summary>
                  <span className="mono">{f.path}</span>
                  <span className="mono small"><span className="pos">{`+${f.plus}`}</span>{" "}<span className="neg">{`−${f.minus}`}</span></span>
                </summary>
                <pre className="onb-diff mono">
                  {lines.map((l, i) => <span key={i} className="onb-add">{`+ ${l}\n`}</span>)}
                  {f.plus > lines.length ? <span className="muted">{lines.length ? `… ${f.plus - lines.length} more lines` : files.isLoading ? "Loading…" : "The lines of this file are not available."}</span> : null}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
      <p className="footnote">{`The lines shown are what the pull request adds. Guideline: ${g?.mayNot ?? ""}`}</p>
    </div>
  );
}

function TimelineTab({ r }: { r: RepoV }) {
  const t = r.onboarding.timeline.slice().sort((a, b) => b.at - a.at);
  return (
    <ol className="onb-timeline">
      {t.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <span className="mono small muted">{fmt.stamp(e.at)}</span>
          {e.who === "ci" ? <span className="who"><Icon name="tool" /><span>CI</span></span> : <Who id={e.who} />}
          <span>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function SettingsTab({ r, edit, can }: { r: RepoV; edit: () => void; can: ReturnType<typeof useCan> }) {
  const c = r.config;
  const teamName = useTeamName();
  const { all } = useIntegrationsFor(r.project);
  const src = r.source ? all.find((x) => x.inst.id === r.source) : null;
  const kv = (k: string, v: React.ReactNode) => <div className="onb-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <div>
      <dl className="onb-kvs">
        {kv("Owning team", teamName(r.team))}
        {kv("Source", src ? `${instLabel(src.inst)} · ${src.type.name ?? src.inst.type}` : "GitHub App")}
        {kv("Default branch", <span className="mono">{c.defaultBranch}</span>)}
        {kv("Branch prefix", <span className="mono">{c.branchPrefix}</span>)}
        {kv("Merge method", c.merge)}
        {kv("Release tagging", c.tagging)}
        {kv("Required checks", <span className="mono">{c.requiredChecks.join(", ") || "none"}</span>)}
        {kv("Protected paths", <span className="mono">{c.protectedPaths.join(", ") || "none"}</span>)}
        {kv("MCP servers", r.mcp.join(", ") || "none")}
        {kv("Issue triggers", r.triggers ? "On (project trigger rules apply)" : "Off")}
        {kv("Notification overrides", r.notifyOverrides.length ? <ul className="plain-list small">{r.notifyOverrides.map((n) => <li key={n.id}>{`${n.event} → ${n.dest.map((d) => `${d.channel} ${d.target}`).join(", ")} (${n.template || "standard"})`}</li>)}</ul> : "Project routes")}
      </dl>
      <Btn label="Edit settings" icon="tool" id="onb-settings-edit" guard={can} onClick={edit} />
    </div>
  );
}

export function RepoDrawer({ repoId, projectId, close }: { repoId: string; projectId: string; close: () => void }) {
  const ui = useUI();
  const project = (useProjects().data ?? []).find((p) => p.id === projectId);
  const repos = (useRepos(projectId).data ?? []) as RepoV[];
  const r = repos.find((x) => x.id === repoId);
  const [tab, setTab] = useState<string>(tabMemory[repoId] ?? "");
  const manage = useCan("onboarding.manage", { project: projectId, repo: repoId });
  const merge = useCan("onboarding.merge", { project: projectId, repo: repoId });
  const exc = useCan("onboarding.exception", { project: projectId, repo: repoId });
  const teamName = useTeamName();
  const { all } = useIntegrationsFor(projectId);
  if (!r || !project) return <div className="drawer-inner onb-drawer"><div className="drawer-scroll"><Empty title="No such repo" text="It may have been removed." /></div></div>;
  const o = r.onboarding;
  const prOpen = !!o.pr && o.pr.state === "open";
  const busy = o.busy ? BUSY[o.busy] ?? "Working" : null;
  const active = tab || (o.pr && o.stage !== "ready" ? "pr" : "findings");
  const go = (t: string) => { rememberTab(repoId, t); setTab(t); };
  const run = async (fn: () => Promise<{ ok: boolean; msg: string }>) => {
    const res = await fn();
    ui.toast(res.msg, res.ok ? "ok" : "error");
  };
  const sourceName = r.source ? all.find((x) => x.inst.id === r.source)?.inst.name ?? "your source control" : "GitHub";
  const canVerify = !o.exception && (["pr_merged", "verified", "ready"].includes(o.stage) || (o.stage === "person" && o.pr?.state === "merged") || (o.stage === "assessed" && o.findings.length > 0 && !fixable(r)));
  const showOpen = !prOpen;
  const openReason = manage.allowed
    ? busy ?? (o.stage === "connected" ? "Assessment has not finished yet" : !["assessed", "failed"].includes(o.stage) ? "Resolve the blocker first, then re-run the assessment" : !fixable(r) && o.findings.length ? "Nothing to add: the repo already has everything a PR can add" : null)
    : null;
  const edit = () => ui.open((done) => <SettingsDialog repo={r} project={project} close={done} />);

  const acts = [
    <Btn key="rerun" label="Re-run assessment" icon="refresh" small id="onb-act-rerun" guard={manage} disabledReason={manage.allowed ? busy ?? (o.stage === "ready" ? "Already ready; re-assessing would restart onboarding" : null) : null} onClick={() => void run(() => ops.rerunAssessment(r.id))} />,
    showOpen ? <Btn key="openpr" label="Open onboarding PR" icon="branch" small id="onb-act-openpr" guard={manage} disabledReason={openReason} onClick={() => void run(() => ops.openOnboardingPR(r.id))} /> : null,
    o.pr ? <Btn key="merge" label="Approve and merge" kind="primary" icon="check" small id="onb-act-merge" guard={merge} disabledReason={merge.allowed ? (!prOpen ? "The PR is already merged" : busy ?? (o.pr.checks !== "green" || o.stage !== "pr_checks" ? "Checks are not green yet" : null)) : null} onClick={() => void run(() => ops.mergeOnboardingPR(r.id))} /> : null,
    canVerify ? <Btn key="verify" label={o.stage === "ready" ? "Re-check now" : "Verify now"} kind={o.stage === "ready" ? undefined : "primary"} icon="check" small id="onb-act-verify" guard={manage} disabledReason={manage.allowed ? busy : null} onClick={() => void run(() => ops.verifyNow(r.id))} /> : null,
    o.pr ? (
      <Btn key="changes" label="Request changes" small icon="undo" id="onb-act-changes" guard={manage} disabledReason={manage.allowed ? (!prOpen ? "The PR is already merged" : busy) : null}
        onClick={() => ui.reasonDialog({ title: `Request changes on ${r.name}#${o.pr!.number}`, kicker: "Onboarding PR", label: "What should the agent change?", ok: "Request changes", min: 5, placeholder: "For example: keep CODEOWNERS to the /internal directory only.", onOk: async (v) => { const x = await ops.requestChanges(r.id, v); if (x.ok) ui.toast(x.msg, "ok"); return x; } })} />
    ) : null,
    <Btn key="exc" label="Mark exception" small icon="shield" id="onb-act-exception" guard={exc} disabledReason={exc.allowed && o.stage === "ready" ? (o.exception ? "Already ready by exception" : "Already ready") : null}
      onClick={() => ui.reasonDialog({ title: `Mark ${r.name} ready by exception`, kicker: "Onboarding exception", label: "Why is it safe to accept work without finishing onboarding?", ok: "Mark ready", kind: "danger", min: 10, sub: "The repo becomes Ready now. Open gaps stay listed on the repo and the exception is written to the audit ledger.", onOk: async (v) => { const x = await ops.markException(r.id, v); if (x.ok) ui.toast(x.msg, "warn"); return x; } })} />,
    <Btn key="settings" label="Repo settings" small icon="tool" id="onb-act-settings" guard={manage} onClick={edit} />,
  ];
  const auto = ["pr_merged", "verified", "connected", "pr_opened"].includes(o.stage) || (o.stage === "pr_checks" && o.pr?.checks !== "green");
  const tabs = [{ id: "findings", label: "Findings", count: gaps(r).length }, { id: "pr", label: "Pull request" }, { id: "timeline", label: "Timeline", count: o.timeline.length }, { id: "settings", label: "Settings" }, { id: "history", label: "History" }];
  return (
    <div className="drawer-inner onb-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker">{`Onboarding · ${project.name}`}</div>
          <div className="drawer-id"><span className="mono big-id">{r.name}</span><StatusChip r={r} /></div>
          <p className="muted small">{`${r.lang || "Language not read yet"} · owned by ${teamName(r.team)} · stage ${stageName(o.stage)}`}</p>
        </div>
        <button type="button" className="icon-btn drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        <Steps r={r} big />
        {busy ? <div className="callout" id="onb-busy"><Icon name="clock" /><div>{busy}</div></div> : null}
        {o.blocker && o.stage === "person" ? <div className="callout callout-block"><Icon name="human" /><div><strong>Needs a person. </strong>{o.blocker}{` Fix it in ${sourceName}, then re-run the assessment or verify again, or mark an exception.`}</div></div> : null}
        {o.stage === "failed" ? <div className="callout callout-fail"><Icon name="st-fail" /><div><strong>Onboarding failed. </strong>{o.blocker || "Re-run the assessment after fixing the cause."}</div></div> : null}
        {o.exception ? <div className="callout callout-warn"><Icon name="shield" /><div><strong>Ready by exception. </strong>{o.exception.reason}<span className="muted">{` · ${fmt.stamp(o.exception.at)}`}</span></div></div> : null}
        {r.halted && /readiness/i.test(r.halted.reason ?? "") ? <div className="callout callout-warn" id="onb-halt"><Icon name="alert" /><div><strong>Halted: readiness was lost. </strong>{`Agents on this repo are stopped until it is verified again. ${r.halted.reason}`}</div></div> : null}
        {auto && o.stage !== "ready" && !busy ? <div className="callout"><Icon name="clock" /><div>The Onboarding agent moves this repo to the next stage on its own. Gantry checks GitHub every minute.</div></div> : null}
        {needsMerge(r) ? <div className="callout callout-warn"><Icon name="st-wait" /><div>{`Checks are green. A person with merge rights on this project must approve and merge PR #${o.pr!.number}.`}</div></div> : null}
        <div className="onb-acts">{acts}</div>
        <LockNote decision={!manage.allowed ? manage : null} what="Onboarding actions on this repo" />
        {/* The drawer body is a flex column: without this a long tab body squeezes the tab bar to nothing (the legacy screen has the same fault). */}
        <div className="onb-dtabs" style={{ flexShrink: 0 }}>
          <Tabs idPrefix="onb-dtab" items={tabs} active={active} onChange={go} />
        </div>
        <div className="onb-dbody">
          {active === "findings" ? <FindingsTab r={r} /> : active === "pr" ? <PrTab r={r} /> : active === "timeline" ? <TimelineTab r={r} /> : active === "settings" ? <SettingsTab r={r} edit={edit} can={manage} /> : <HistoryList type="repo" id={r.id} project={projectId} />}
        </div>
      </div>
    </div>
  );
}
