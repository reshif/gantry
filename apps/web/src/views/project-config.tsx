/**
 * Project config (#project-config): Overview, Members & roles, Flow, Work classes, Approvers, Notifications, MCP, Budget,
 * History and Danger zone. Ported from legacy/js/views/project-config.js. Every change goes through ops, which call the API.
 */
import { useEffect, useRef, useState } from "react";
import { fmt } from "@gantry/domain";
import { useMe, usePeople, useProjects } from "../api/queries";
import { navigate, parseHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { useActors } from "../ui/actors";
import { Btn, Empty, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { HealthChip, useCatalog, type PView } from "./projects/kit";
import { TABS, membersOf, type CfgState } from "./project-config/ctx";
import { OverviewTab, MembersTab } from "./project-config/overview";
import { FlowTab } from "./project-config/flow";
import { ClassesTab } from "./project-config/classes";
import { ApproversTab } from "./project-config/approvers";
import { BudgetTab, DangerTab, HistoryTab, McpTab, NotificationsTab } from "./project-config/misc";

/** `#/p/<project>/project-config/approvers/G2` opens that gate's rule (the traveler's "Edit rule"). */
const linked = (): { tab: string; gate: string } | null => {
  const [tab, gate] = (parseHash(window.location.hash).param ?? "").split("/");
  return tab && TABS.some((t) => t[0] === tab) ? { tab, gate: gate || "G5" } : null;
};
const fresh = (): CfgState => ({ tab: linked()?.tab ?? "overview", gate: linked()?.gate ?? "G5", flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, drafts: {}, text: {} });

export default function ProjectConfigView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const projects = (projectsQ.data ?? []) as PView[];
  const people = usePeople().data ?? [];
  const cat = useCatalog();
  const actor = useActors();
  const pid = pickProject(me, prefs.project);
  const p = projects.find((x) => x.id === pid) ?? null;
  const [s, setS] = useState<CfgState>(fresh);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (pid && last.current !== null && last.current !== pid) setS(fresh());
    last.current = pid;
  }, [pid]);
  const set = (patch: Partial<CfgState>) => setS((x) => ({ ...x, ...patch }));

  if (!me) return null;
  if (!pid) return <div className="view"><Empty title="No project" text="Pick a project in the top bar." /></div>;
  if (!p) return <div className="view pcf">{projectsQ.data ? <Empty id="pcf-gone" title="Project not found" text="It may have been removed, or you no longer have a role on it." /> : <Async query={projectsQ} what="this project" id="pcf-project">{() => null}</Async>}</div>;
  if (!cat) return <div className="view pcf" />;

  const dirtyN = Object.keys(s.drafts).filter((g) => JSON.stringify(s.drafts[g]) !== JSON.stringify(p.approvers[g])).length;
  const count = (id: string): number | null => (id === "approvers" && dirtyN ? dirtyN : id === "members" ? membersOf(people, p).length : id === "classes" ? p.flow.classes.filter((c) => c.enabled !== false).length : id === "flow" ? p.flow.order.length : null);
  const props = { p, cat, people, s, set };
  const body = ({
    overview: <OverviewTab {...props} />, members: <MembersTab {...props} />, flow: <FlowTab {...props} />, classes: <ClassesTab {...props} />, approvers: <ApproversTab {...props} />,
    notifications: <NotificationsTab {...props} />, mcp: <McpTab {...props} />, budget: <BudgetTab {...props} />, history: <HistoryTab {...props} />, danger: <DangerTab {...props} />,
  } as Record<string, React.ReactNode>)[s.tab] ?? <OverviewTab {...props} />;
  return (
    <div className="view pcf">
      <ViewHead
        kicker="Project settings"
        title={<>{p.name} <HealthChip p={p} /></>}
        sub={p.desc || "No description yet."}
        actions={
          <>
            <Btn icon="belt" id="pcf-to-floor" label="Open floor" onClick={() => navigate("floor")} />
            <Btn icon="ledger" id="pcf-to-history" label="History" onClick={() => set({ tab: "history" })} />
          </>
        }
      />
      <dl className="pcf-strip" id="pcf-strip">
        {([["Status", p.killed ? "Killed" : p.halted ? "Halted" : p.status === "archived" ? "Archived" : "Active"], ["Owner", actor(p.owner).name.replace(" (agent)", "")], ["Slots", String(p.flow.slots)], ["Budget", p.budget.monthly ? `${fmt.money0(p.budget.mtd)} / ${fmt.money0(p.budget.monthly)}` : "None set"]] as const).map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <Tabs idPrefix="pcf-tab" items={TABS.filter((t) => t[0] !== "history" || s.tab === "history").map((t) => ({ id: t[0], label: t[1], count: count(t[0]) }))} active={s.tab} onChange={(id) => set({ tab: id })} />
      <div className="pcf-body" id="pcf-tab-panel" role="tabpanel" aria-labelledby={`pcf-tab-${s.tab}`}>{body}</div>
    </div>
  );
}


