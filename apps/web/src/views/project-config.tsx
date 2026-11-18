/**
 * Project config (#project-config): the Blueprint's seven tabs (Overview, Flow, Approvers, MCP, Budget, Repos, Line control), the tab held in the URL (`?tab=`).
 * Members, work classes, notification routes, history and the detailed editors are secondary pages linked from their tab. Every change goes through ops, which call the API.
 */
import { useEffect, useRef, useState } from "react";
import { useMe, usePeople, useProjects } from "../api/queries";
import { navigate, parseHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty, Panel, Select, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { useCatalog, type PView } from "./projects/kit";
import { useQueryParam } from "./projects/urlState";
import { SECONDARY, TABS, type CfgState } from "./project-config/ctx";
import { OverviewTab, MembersTab } from "./project-config/overview";
import { FlowTab } from "./project-config/flow";
import { ClassesTab } from "./project-config/classes";
import { ApproversTab } from "./project-config/approvers";
import { ArchivePanel, BudgetTab, HistoryTab, NotificationsTab } from "./project-config/misc";
import { ApproversProto, BudgetProto, FlowProto, LineProto, McpProto, OverviewProto, ReposProto } from "./project-config/proto";

/** `#/p/<project>/project-config/approvers/G2` opens that gate's rule in the full rule editor (the traveler's "Edit rule"). */
const linked = (): { tab: string; gate: string } | null => {
  const [tab, gate] = (parseHash(window.location.hash).param ?? "").split("/");
  if (!tab) return null;
  if (tab === "approvers" && gate) return { tab: "rules", gate };
  return TABS.some((t) => t[0] === tab) || SECONDARY.some((t) => t[0] === tab) ? { tab, gate: gate || "G5" } : null;
};
const fresh = (): CfgState => ({ tab: linked()?.tab ?? "overview", gate: linked()?.gate ?? "G5", flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, drafts: {}, text: {} });

export default function ProjectConfigView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const projects = (projectsQ.data ?? []) as PView[];
  const people = usePeople().data ?? [];
  const cat = useCatalog();
  const pid = pickProject(me, prefs.project);
  const p = projects.find((x) => x.id === pid) ?? null;
  const [s, setS] = useState<CfgState>(fresh);
  const [tabQ, setTabQ] = useQueryParam("tab");
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (pid && last.current !== null && last.current !== pid) { setS(fresh()); setTabQ(null); }
    last.current = pid;
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = [...TABS.map((t) => t[0]), ...SECONDARY.map((t) => t[0])];
  const tab = tabQ && known.includes(tabQ) ? tabQ : s.tab;
  const set = (patch: Partial<CfgState>) => {
    const { tab: t, ...rest } = patch;
    if (t) setTabQ(t === "overview" ? null : t);
    setS((x) => ({ ...x, ...rest, ...(t ? { tab: t } : {}) }));
  };

  if (!me) return null;
  if (!pid) return <div className="view"><Empty title="No project" text="Pick a project in the top bar." /></div>;
  if (!p) return <div className="view pcf">{projectsQ.data ? <><ViewHead title="Project config" /><Panel><Empty id="pcf-gone" title="Nothing to show" text="That project does not exist." action={<Btn label="Work orders" onClick={() => navigate("work-orders")} />} /></Panel></> : <Async query={projectsQ} what="this project" id="pcf-project">{() => null}</Async>}</div>;
  if (!cat) return <div className="view pcf" />;

  const sec = SECONDARY.find((x) => x[0] === tab);
  const props = { p, cat, people, s: { ...s, tab }, set };
  const body = ({
    overview: <OverviewProto {...props} />, flow: <FlowProto {...props} />, approvers: <ApproversProto {...props} />, mcp: <McpProto {...props} />, budget: <BudgetProto {...props} />, repos: <ReposProto {...props} />,
    danger: <div className="stack"><LineProto {...props} /><ArchivePanel p={p} /></div>,
    members: <MembersTab {...props} />, classes: <ClassesTab {...props} />, notifications: <NotificationsTab {...props} />, history: <HistoryTab {...props} />, more: <OverviewTab {...props} />,
    "flow-advanced": <FlowTab {...props} />, rules: <ApproversTab {...props} />, spend: <BudgetTab {...props} />,
  } as Record<string, React.ReactNode>)[tab] ?? <OverviewProto {...props} />;
  const active = sec ? sec[2] : tab;
  return (
    <div className="view pcf">
      <ViewHead
        kicker={p.key} title="Project config" sub={`${p.name} · ${p.key}`}
        actions={<Select id="pcf-project" style={{ width: 200 }} aria-label="Project" value={p.id} options={projects.map((x) => ({ value: x.id, label: x.name }))} onChange={(v) => { updatePrefs({ project: v }); setTabQ(null); navigate("project-config"); }} />}
      />
      <Tabs idPrefix="pcf-tab" items={TABS.map((t) => ({ id: t[0], label: t[1], count: t[0] === "mcp" ? p.mcp.length : null }))} active={active} onChange={(id) => set({ tab: id })} />
      <div className="pcf-body" id="pcf-tab-panel" role="tabpanel" aria-labelledby={`pcf-tab-${active}`}>
        {sec ? <div className="row" style={{ marginBottom: 12 }}><Btn small kind="ghost" icon="back" id="pcf-back" label={TABS.find((t) => t[0] === sec[2])?.[1] ?? "Overview"} onClick={() => set({ tab: sec[2] })} /><strong>{sec[1]}</strong></div> : null}
        {body}
      </div>
    </div>
  );
}
