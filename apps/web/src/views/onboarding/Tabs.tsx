/** The Session and Settings tabs of Onboarding (the prototype's last two tabs). */
import { navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import type { Project } from "@gantry/domain";
import { Card } from "../../ui/cr";
import { Btn, Empty, IconBtn, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { Async } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { AgentTab } from "./Agent";
import { useSession } from "./session-api";
import { stageIndex, type RepoV } from "./kit";

/** The latest onboarding conversation: the repo whose onboarding is least finished (a person is most likely waiting on it). */
export function SessionTab({ repos }: { repos: RepoV[] }) {
  const pick = [...repos].sort((a, b) => stageIndex(a) - stageIndex(b) || b.onboarding.startedAt - a.onboarding.startedAt)[0];
  if (!pick) return <Card title="Onboarding session"><Empty title="No onboarding session yet" text="Connect a repo from the Wizard tab. The Onboarding Agent starts a conversation for it." /></Card>;
  return <SessionCard repo={pick} />;
}

function SessionCard({ repo }: { repo: RepoV }) {
  const q = useSession(repo.id);
  const actors = useActors();
  // the onboarding agent is named in words even where the agent list does not carry it
  const nameOf = (id: string): string => { const a = actors(id); return a.kind === "other" && /^ag-onboard/.test(id) ? "Onboarding Agent" : a.name.replace(" (agent)", ""); };
  return (
    <Card title="Onboarding session">
      <Async query={q} what="the onboarding session" id="onb-session">
        {(s) => (
          <>
            {s.messages.length ? s.messages.slice(-6).map((m) => (
              <div key={m.id} className="msg" style={{ maxWidth: "100%" }}>
                <div className="who">{nameOf(m.author)}</div>
                <div className="bub">{m.text}</div>
              </div>
            )) : <p className="muted">Nothing has been said yet.</p>}
            <div className="row" style={{ marginTop: 12 }}>
              <Btn id="onb-open-conv" label="Open conversation" onClick={() => navigate("onboarding", repo.id, repo.project)} />
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
 * Settings: the prototype's four onboarding switches. The API stores no project-level onboarding policy, so a switch says so when it is used
 * instead of pretending to save. The Onboarding agent and its versioned guidelines open from the card's action (a drawer), not inline.
 */
export function SettingsTab({ project }: { project: Project }) {
  const ui = useUI();
  const agent = () => ui.drawer.open("onb-agent", (close) => (
    <div className="drawer-inner onb-drawer" id="onb-agent-drawer">
      <div className="drawer-head">
        <div><div className="small muted">Onboarding</div><div className="drawer-id"><span className="big-id">Onboarding agent and guidelines</span></div></div>
        <IconBtn icon="x" className="drawer-close" label="Close" onClick={close} />
      </div>
      <div className="drawer-scroll">
        <AgentTab project={project} />
        <div className="row"><Btn small kind="ghost" icon="agent" id="onb-agent-profile" label="Onboarding agent profile" onClick={() => { close(); updatePrefs({ agent: "ag-onboard" }); navigate("agents"); }} /></div>
      </div>
    </div>
  ));
  return (
    <Card title="Onboarding settings" flush acts={<Btn small kind="ghost" icon="agent" id="onb-agent-open" label="Agent and guidelines" onClick={agent} />}>
      <div className="list">
        {SETTINGS.map(([id, title, sub]) => (
          <div key={id} className="setrow">
            <div className="tx"><b>{title}</b><span>{sub}</span></div>
            <Toggle id={`onb-set-${id}`} checked label={title} onChange={() => ui.toast("Not available yet: the onboarding policy is a server default and is not stored per project.", "info")} />
          </div>
        ))}
      </div>
    </Card>
  );
}
