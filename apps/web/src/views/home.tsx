/** Home (#home): one page for everyone. The API decides which sections a person gets (`home.sections`); this renders what is present, in a fixed order: attention, waiting on you, set up, in motion, projects, health. */
import { useCan } from "../api/can";
import { useHome, useMe, useProjects } from "../api/queries";
import { plural } from "../lib/plural";
import { hasCommand, runCommand } from "../lib/commands";
import { fmt } from "@gantry/domain";
import { Btn, Empty, Stat, StatRow, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import type { HomeFull } from "./home/data";
import { ApproversWatch, AttentionStrip, FactoryHealth, InMotion, MineAndDone, ProjectsSummary, SetupChecklist, WaitingOnYou, openNewProject } from "./home/sections";
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
  if (!home) {
    // Loading, refused and failed look the same here as on every other page.
    return (
      <div className="view hm">
        <ViewHead title="Home" />
        <Async query={q} what="your home page" id="hm">{() => null}</Async>
      </div>
    );
  }
  const s = home.sections ?? {};
  if (s.access === "none") {
    return (
      <div className="view hm">
        <ViewHead title="Home" />
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
  const att = s.attention ?? [];
  const crit = att.filter((a) => a.sev === 0).length;
  const waitingN = waiting ? waiting.approvals.length + waiting.conversations.length : 0;
  // While the setup checklist is up its active step carries the New project button; the header has it afterwards.
  const canCreate = !create.pending && create.allowed && !s.setup && !!s.health;
  // No work order can be submitted before a repo is Ready, so the checklist (which says so) replaces the button until then.
  const canSubmit = !submit.pending && submit.allowed && !s.setup && hasCommand("newWorkOrder");
  const factoryWide = !!s.health || !!s.approvers || !!s.setup;
  const viewerOnly = me.person.roles.length > 0 && me.person.roles.every((g) => g.role === "viewer");
  const m = s.motion;
  const showMotion = !!m && (!s.setup || m.inFlight > 0 || m.recentDone.length > 0 || m.mine.length > 0);
  const hl = s.health;
  const evalsPct = hl?.evals && hl.evals.scored ? hl.evals.passing / hl.evals.scored : null;
  const budgetPct = hl && hl.spend.budget ? hl.spend.spent / hl.spend.budget : 0;
  const first = me.person.name.split(" ")[0];
  const greeting = away || (waiting ? `Good day, ${first}. ${plural(waitingN, "work order")} ${waitingN === 1 ? "waits" : "wait"} on a person.` : "What needs you, what is moving, and how the factory is doing.");
  const hasStats = !!waiting || !!m || !!hl;
  return (
    <div className="view hm">
      <ViewHead
        title="Home"
        sub={greeting}
        actions={
          <>
            {canCreate ? <Btn label="New project" kind="primary" icon="plus" id="hm-new-project" onClick={openNewProject} /> : null}
            {canSubmit ? <Btn label="New work order" kind={canCreate ? "ghost" : "primary"} icon="plus" id="hm-my-new" onClick={() => void runCommand("newWorkOrder")} /> : null}
          </>
        }
      />
      {hasStats ? (
        <StatRow id="hm-stats">
          {waiting ? <Stat id="hm-stat-waiting" label="Waiting on you" value={String(waitingN)} sub={waitingN ? "gates and questions for you" : "Nothing is waiting on you"} {...(waitingN ? { tone: "wait" as const } : { tone: "done" as const })} /> : null}
          {m ? <Stat id="hm-stat-flight" label="In flight" value={String(m.inFlight)} sub={`${m.running} running${m.inBays ? ` · ${m.inBays} in bays` : ""}`} /> : null}
          {m ? <Stat id="hm-stat-shipped" label="Released" value={String(m.shippedWeek)} sub={`this week · ${m.shippedToday} today`} tone="done" /> : null}
          {evalsPct !== null ? <Stat id="hm-stat-evals" label="Task success" value={fmt.pct(evalsPct)} sub="agent versions passing evals" tone="done" /> : s.attention ? <Stat id="hm-stat-attention" label="Needs attention" value={String(att.length)} sub={crit ? `${crit} critical` : "None critical"} {...(crit ? { tone: "block" as const } : {})} /> : null}
          {hl && hl.spend.spent > 0 ? <Stat id="hm-stat-spend" label="Spend MTD" value={fmt.money0(hl.spend.spent)} sub={`of ${fmt.money0(hl.spend.budget)} budget`} {...(budgetPct > 0.8 ? { tone: "wait" as const } : {})} /> : null}
        </StatRow>
      ) : null}
      {s.attention ? <AttentionStrip items={s.attention} /> : null}
      {s.setup ? <SetupChecklist setup={s.setup} /> : null}
      {waiting || (showMotion && m) ? (
        <div className="cols w21">
          {waiting ? <WaitingOnYou approvals={waiting.approvals} conversations={waiting.conversations} /> : null}
          {showMotion && m ? <InMotion motion={m} projects={projects} /> : null}
        </div>
      ) : null}
      <div className={"cols"} style={{ marginTop: 16 }}>
        {s.health ? <FactoryHealth health={s.health} /> : null}
        {m ? <MineAndDone motion={m} /> : null}
      </div>
      {s.approvers ? <div style={{ marginTop: 16 }}><ApproversWatch data={s.approvers} /></div> : null}
      {s.projects ? <div style={{ marginTop: 16 }}><ProjectsSummary rows={s.projects} projects={projects} factoryWide={factoryWide} readOnlyNote={viewerOnly} /></div> : null}
    </div>
  );
}
