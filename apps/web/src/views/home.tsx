/** Home (#home): one page for everyone. The API decides which sections a person gets (`home.sections`); this renders what is present, in a fixed order: attention, waiting on you, set up, in motion, projects, health. */
import { useCan } from "../api/can";
import { useHome, useMe, useProjects } from "../api/queries";
import { hasCommand, runCommand } from "../lib/commands";
import { fmt } from "@gantry/domain";
import { Btn, Empty, ViewHead } from "../ui/primitives";
import type { HomeFull } from "./home/data";
import { ApproversWatch, AttentionStrip, FactoryHealth, InMotion, ProjectsSummary, SetupChecklist, WaitingOnYou, openNewProject } from "./home/sections";
import type { PView } from "./projects/kit";

export { openNewProject };

export default function HomeView() {
  const me = useMe();
  const q = useHome();
  const projects = ((useProjects().data ?? []) as PView[]).slice();
  const create = useCan("project.create");
  const submit = useCan("wo.submit");
  const home = q.data as unknown as HomeFull | undefined;
  if (!me) return null;
  if (q.isError) {
    return (
      <div className="view hm">
        <ViewHead kicker="Home" title="Home" />
        <Empty title="Home could not be loaded" text="Reload the page, or try again in a moment." />
      </div>
    );
  }
  if (!home) {
    return (
      <div className="view hm">
        <ViewHead kicker="Home" title="Home" />
        <p className="muted small">Loading…</p>
      </div>
    );
  }
  const s = home.sections ?? {};
  if (s.access === "none") {
    return (
      <div className="view hm">
        <ViewHead kicker="Home" title="Home" />
        <Empty id="hm-no-access" title="No access yet" text="Your account is signed in but has no role yet. Ask a Factory Admin or Project Admin to give you one." />
      </div>
    );
  }
  // An item shown in Attention is not repeated in Waiting on you (the bell still lists it).
  const attIds = new Set((s.attention ?? []).map((a) => a.id));
  const waiting = s.waiting
    ? {
        approvals: s.waiting.approvals.filter((a) => !(a.repo && !a.note && attIds.has(`hm-att-onb-${a.repo}`)) && !(a.wo && attIds.has(`hm-att-sla-${a.wo}-${a.gate}`))),
        conversations: s.waiting.conversations,
      }
    : null;
  const away = me.person.away && me.person.away.to > Date.now() ? `Away until ${fmt.istDate(me.person.away.to)}.` : "";
  // While the setup checklist is up its active step carries the New project button; the header has it afterwards.
  const canCreate = !create.pending && create.allowed && !s.setup && !!s.health;
  // No work order can be submitted before a repo is Ready, so the checklist (which says so) replaces the button until then.
  const canSubmit = !submit.pending && submit.allowed && !s.setup && hasCommand("newWorkOrder");
  const factoryWide = !!s.health || !!s.approvers || !!s.setup;
  const viewerOnly = me.person.roles.length > 0 && me.person.roles.every((g) => g.role === "viewer");
  const m = s.motion;
  const showMotion = !!m && (!s.setup || m.inFlight > 0 || m.recentDone.length > 0 || m.mine.length > 0);
  return (
    <div className="view hm">
      <ViewHead
        kicker="Home" title="Home"
        sub={away || undefined}
        actions={
          <>
            {canCreate ? <Btn label="New project" kind="primary" icon="plus" id="hm-new-project" onClick={openNewProject} /> : null}
            {canSubmit ? <Btn label="New work order" kind={canCreate ? "ghost" : "primary"} icon="plus" id="hm-my-new" onClick={() => void runCommand("newWorkOrder")} /> : null}
          </>
        }
      />
      <div className="hm-stack">
        {s.attention ? <AttentionStrip items={s.attention} /> : null}
        <div className={`hm-two${s.setup || (waiting && s.approvers) ? "" : " is-one"}`}>
          {waiting ? <WaitingOnYou approvals={waiting.approvals} conversations={waiting.conversations} /> : null}
          {s.approvers ? <ApproversWatch data={s.approvers} /> : null}
          {s.setup ? <SetupChecklist setup={s.setup} /> : null}
        </div>
        {showMotion || s.projects?.length ? (
          <div className={`hm-two${showMotion && m && s.projects ? "" : " is-one"}`}>
            {showMotion && m ? <InMotion motion={m} projects={projects} /> : null}
            {s.projects ? <ProjectsSummary rows={s.projects} projects={projects} factoryWide={factoryWide} readOnlyNote={viewerOnly} /> : null}
          </div>
        ) : null}
        {s.health ? <FactoryHealth health={s.health} /> : null}
      </div>
    </div>
  );
}

