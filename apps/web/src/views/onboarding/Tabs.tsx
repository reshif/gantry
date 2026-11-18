/** The Session and Settings tabs of Onboarding (the prototype's last two tabs). */
import { useMe } from "../../api/queries";
import { navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import type { Project } from "@gantry/domain";
import { Card } from "../../ui/cr";
import { Btn, Empty, Toggle } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { AgentTab } from "./Agent";
import { useSession } from "./session-api";
import { stageIndex, type RepoV } from "./kit";

/** The latest onboarding conversation of the project: the repo whose onboarding is least finished (a person is most likely waiting on it). */
export function SessionTab({ repos }: { repos: RepoV[] }) {
  const pick = [...repos].sort((a, b) => stageIndex(a) - stageIndex(b) || b.onboarding.startedAt - a.onboarding.startedAt)[0];
  if (!pick) return <Card title="Onboarding session"><Empty title="No onboarding session yet" text="Connect a repo from the Wizard tab. The Onboarding Agent starts a conversation for it." /></Card>;
  return <SessionCard repo={pick} />;
}

function SessionCard({ repo }: { repo: RepoV }) {
  const q = useSession(repo.id);
  const actors = useActors();
  return (
    <Card title="Onboarding session" hint={<span className="mono">{repo.name}</span>}>
      <Async query={q} what="the onboarding session" id="onb-session">
        {(s) => (
          <>
            {s.messages.length ? s.messages.slice(-6).map((m) => (
              <div key={m.id} className="msg" style={{ maxWidth: "100%" }}>
                <div className="who">{actors(m.author).name.replace(" (agent)", "")}</div>
                <div className="bub">{m.text}</div>
              </div>
            )) : <p className="muted">Nothing has been said yet.</p>}
            <div className="row" style={{ marginTop: 12 }}>
              <Btn id="onb-open-conv" label="Open conversation" onClick={() => navigate("onboarding", repo.id)} />
            </div>
          </>
        )}
      </Async>
    </Card>
  );
}

const SETTINGS: Array<[string, string, string]> = [
  ["onb.pr", "Require approval before merging onboarding PRs", "A Project Admin approves; sensitive files need a tick."],
  ["onb.auto", "Assess new repos automatically", "Run the assessment as soon as a repo is connected."],
  ["onb.flaky", "Allow onboarding with flaky suites", "Builds retry flaky suites once."],
  ["onb.reg", "Use the strict pack for regulated projects", ""],
];

/**
 * Settings: the four onboarding switches, then the Onboarding agent and its versioned guidelines. The switches have no setting behind them in
 * this build (the API stores no project-level onboarding policy), so they are shown locked and say so instead of pretending to save.
 */
export function SettingsTab({ project }: { project: Project }) {
  const me = useMe();
  const lock = { allowed: false, reason: "Not available: onboarding policy is not stored per project yet.", needs: "" };
  return (
    <div className="stack">
      <Card title="Onboarding settings" flush hint="Not available yet: these switches are not stored per project.">
        <div className="list">
          {SETTINGS.map(([id, title, sub]) => (
            <div key={id} className="setrow">
              <div className="tx"><b>{title}</b><span>{sub}</span></div>
              <Toggle id={`onb-set-${id}`} checked decision={lock} label={title} />
            </div>
          ))}
        </div>
      </Card>
      {me ? <AgentTab project={project} /> : null}
      <div className="row"><Btn small kind="ghost" icon="agent" id="onb-agent-profile" label="Onboarding agent profile" onClick={() => { updatePrefs({ agent: "ag-onboard" }); navigate("agents"); }} /></div>
    </div>
  );
}
