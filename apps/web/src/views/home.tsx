/** Home (#home): one page for everyone. The API decides which sections a person gets (`home.sections`); this renders what is present, in a fixed order: attention, waiting on you, set up, in motion, projects, health. */
import { useCan } from "../api/can";
import { useMemo } from "react";
import { useNavBadges } from "../api/queries/nav";
import { useHome, useMe, useProjects, useScorecards } from "../api/queries";
import { plural } from "../lib/plural";
import { runCommand } from "../lib/commands";
import { fmt } from "@gantry/domain";
import { Btn, Empty, Stat, StatRow, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import type { HomeFull } from "./home/data";
import { AttentionStrip, InMotion, RecentActivity, SetupChecklist, TaskSuccess, WaitingOnYou, openNewProject } from "./home/sections";
import { useItems } from "./work/items";
import { greetingAt } from "./work/format";
import { useScope } from "./work/scope";
import { metricsOf, type PView } from "./projects/kit";
import "../styles/views/home.css";
import "../styles/views/home-projects.css";

export { openNewProject };

export default function HomeView() {
  const me = useMe();
  const q = useHome();
  const projects = ((useProjects().data ?? []) as PView[]).slice();
  const submit = useCan("wo.submit");
  const home = q.data as unknown as HomeFull | undefined;
  const scope = useScope();
  const badges = useNavBadges();
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as [string, string])), [projects]);
  const allItems = useItems(home, names);
  const cards = useScorecards().data;
  if (!me) return null;
  if (!home) {
    // Loading, refused and failed look the same here as on every other page.
    return (
      <div className="view hm">
        <ViewHead title="Home" kicker={scope.kicker} />
        <Async query={q} what="your home page" id="hm">{() => null}</Async>
      </div>
    );
  }
  const s = home.sections ?? {};
  if (s.access === "none") {
    return (
      <div className="view hm">
        <ViewHead title="Home" kicker={scope.kicker} />
        <Empty id="hm-no-access" title="No access yet" text="Your account is signed in but has no role yet. Ask a Factory Admin or Project Admin to give you one." />
      </div>
    );
  }
  // An item shown in Attention is not repeated in Needs you (the bell still lists it); the page follows the project the switcher holds.
  const attIds = new Set((s.attention ?? []).map((a) => a.id));
  const items = allItems.filter(
    (i) =>
      (!scope.project || i.project === scope.project) &&
      !(i.kind === "onboarding" && !i.a.note && attIds.has(`hm-att-onb-${i.a.repo}`)) &&
      !(i.kind === "gate" && attIds.has(`hm-att-sla-${i.a.wo}-${i.a.gate}`)),
  );
  const pending = items.filter((i) => i.kind === "gate").length;
  // The left nav's Inbox count is the one number for everything waiting on this person; this page says which part of it it counts.
  const inboxTotal = badges.inbox?.n ?? 0;
  const away = me.person.away && me.person.away.to > Date.now() ? `Away until ${fmt.istDate(me.person.away.to)}.` : "";
  const showWaiting = !!s.waiting;
  const m = s.motion;
  const hl = s.health;
  const inScope = scope.project ? projects.filter((p) => p.id === scope.project) : projects;
  const inFlight = m ? (scope.project ? inScope.reduce((n, p) => n + metricsOf(p).wip, 0) : m.inFlight) : 0;
  const showMotion = !!m && (!s.setup || m.inFlight > 0 || m.recentDone.length > 0 || m.mine.length > 0);
  // Task success: the mean of the agents' scorecards (last 7 days); without scorecards, the share of live agent versions passing their suite.
  const scores = Object.values(cards ?? {}).map((c) => c.taskSuccess).filter((x) => typeof x === "number");
  const success = scores.length ? { v: scores.reduce((a, b) => a + b, 0) / scores.length, sub: "agents, last 7 days" } : hl?.evals && hl.evals.scored ? { v: hl.evals.passing / hl.evals.scored, sub: "agent versions passing evals" } : null;
  const budgetPct = hl && hl.spend.budget ? hl.spend.spent / hl.spend.budget : 0;
  const first = me.person.name.split(" ")[0];
  const sub = away || (showWaiting ? `${greetingAt(new Date().getHours())}, ${first}. ${plural(pending, "approval")} ${pending === 1 ? "waits" : "wait"} on you${inboxTotal > pending ? ` (${inboxTotal} things in your Inbox ${scope.project ? `for ${names.get(scope.project) ?? "this project"}` : "across all projects"})` : ""}.` : "What needs you, what is moving, and how the factory is doing.");
  const hasStats = showWaiting || !!m || !!hl;
  // The one primary action. Locked with the reason (never hidden) when this person may not submit, or no repo can take work yet.
  const submitBlock = s.setup ? "Finish setting up the factory first: no repo is Ready for work yet." : null;
  return (
    <div className="view hm">
      <ViewHead
        title="Home"
        kicker={scope.kicker}
        sub={sub}
        actions={<Btn label="Submit work order" kind="primary" icon="plus" id="hm-my-new" guard={submit.pending ? null : submit} disabledReason={submitBlock} onClick={() => void runCommand("newWorkOrder")} />}
      />
      {hasStats ? (
        <StatRow id="hm-stats">
          {showWaiting ? <Stat id="hm-stat-waiting" label="Waiting on you" value={String(pending)} sub={inboxTotal > pending ? `gates to approve · ${inboxTotal} in Inbox` : "gates to approve"} href="#inbox" tone={pending ? "wait" : "done"} /> : null}
          {m ? <Stat id="hm-stat-flight" label="In flight" value={String(inFlight)} sub="across the line" href="#floor" tone="info" /> : null}
          {m ? <Stat id="hm-stat-shipped" label="Released" value={String(m.shippedWeek)} sub="work orders closed" tone="done" /> : null}
          {success ? <Stat id="hm-stat-evals" label="Task success" value={fmt.pct(success.v)} sub={success.sub} href="#evals" tone="done" /> : null}
          {hl ? <Stat id="hm-stat-spend" label="Spend MTD" value={fmt.money0(hl.spend.spent)} sub={hl.spend.budget > 0 ? `of ${fmt.money0(hl.spend.budget)} budget` : "no cap set"} href="#models" {...(budgetPct > 0.8 ? { tone: "wait" as const } : {})} /> : null}
        </StatRow>
      ) : null}
      {s.attention ? <AttentionStrip items={s.attention} /> : null}
      {s.setup ? <SetupChecklist setup={s.setup} /> : null}
      {showWaiting || (showMotion && m) ? (
        <div className="cols w21">
          {showWaiting ? <WaitingOnYou items={items} /> : null}
          {showMotion && m ? <InMotion motion={m} projects={projects} scope={scope.project} /> : null}
        </div>
      ) : null}
      <div className="cols" style={{ marginTop: 16 }}>
        <TaskSuccess />
        <RecentActivity />
      </div>
    </div>
  );
}
