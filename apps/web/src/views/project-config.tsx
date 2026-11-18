/**
 * Project config (#project-config): the Blueprint's eight tabs (Overview, Flow, Approvers, MCP, Budget, Repos, Members, Line control), the tab held in the URL (`?tab=`).
 * Nothing sits behind a menu. An old `?tab=` id (classes, rules, spend, archive, history ...) lands on the tab and section that took it over. Every change goes through ops, which call the API.
 */
import { useEffect, useRef, useState } from "react";
import { useMe, usePeople, useProjects } from "../api/queries";
import { navigate, parseHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty, Panel, Select, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { flowOf, useCatalog, type PView } from "./projects/kit";
import { useQueryParam } from "./projects/urlState";
import { LEGACY_TABS, TABS, type CfgState } from "./project-config/ctx";
import { MembersTab, OverviewProto } from "./project-config/overview";
import { ApproversProto, BudgetProto, FlowProto, LineProto, McpProto, ReposProto } from "./project-config/proto";

/** `#/p/<project>/project-config/approvers/G2` opens that gate's rule in the full rule editor (the traveler's "Edit rule"). */
const linked = (): { tab: string; gate: string | null } | null => {
  const [tab, gate] = (parseHash(window.location.hash).param ?? "").split("/");
  if (!tab) return null;
  if (tab === "approvers" && gate) return { tab, gate };
  return TABS.some((t) => t[0] === tab) || tab in LEGACY_TABS ? { tab, gate: null } : null;
};
const fresh = (): CfgState => ({ tab: linked()?.tab ?? "overview", flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, drafts: {} });

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
  const [, setSecQ] = useQueryParam("sec");
  const [ruleQ, setRuleQ] = useQueryParam("rule");
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (pid && last.current !== null && last.current !== pid) { setS(fresh()); setTabQ(null); setSecQ(null); setRuleQ(null); }
    last.current = pid;
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const raw = tabQ ?? s.tab;
  const legacy = LEGACY_TABS[raw];
  const tab = legacy ? legacy.tab : TABS.some((t) => t[0] === raw) ? raw : "overview";
  // an old bookmark is rewritten once, then the tab renders: its section and editor are in the URL before the tab mounts
  useEffect(() => {
    if (!legacy || !cat || !p) return;
    if (legacy.sec) setSecQ(legacy.sec);
    const gates = flowOf(cat, p).gates;
    const first = (gates.find((g) => g.id === "G5") ?? gates[0])?.id; // G5 (the release gate) when this flow has it, else the first gate
    if (legacy.rule && !ruleQ && first) setRuleQ(first);
    setTabQ(legacy.tab === "overview" ? null : legacy.tab);
    setS((x) => ({ ...x, tab: legacy.tab }));
  }, [legacy, !!cat, !!p]); // eslint-disable-line react-hooks/exhaustive-deps
  // the Traveler's "Edit rule" link names the gate
  // the segment moves into the query (?tab=approvers&rule=G2) so the address and the screen agree after a tab switch
  useEffect(() => {
    const l = linked();
    if (!l?.gate) return;
    setRuleQ(l.gate);
    setTabQ(l.tab);
    try {
      const h = window.location.hash;
      const i = h.indexOf("project-config");
      if (i >= 0) {
        const qi = h.indexOf("?");
        const next = h.slice(0, i + "project-config".length) + (qi < 0 ? "" : h.slice(qi));
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${next}`);
      }
    } catch { /* no history access */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<CfgState>) => {
    const { tab: t, ...rest } = patch;
    if (t) setTabQ(t === "overview" ? null : t);
    setS((x) => ({ ...x, ...rest, ...(t ? { tab: t } : {}) }));
  };

  if (!me) return null;
  if (!pid) return <div className="view"><Empty title="No project" text="Pick a project in the top bar." /></div>;
  if (!p) return <div className="view pcf">{projectsQ.data ? <><ViewHead title="Project config" /><Panel><Empty id="pcf-gone" title="Nothing to show" text="That project does not exist." action={<Btn label="Work orders" onClick={() => navigate("work-orders")} />} /></Panel></> : <Async query={projectsQ} what="this project" id="pcf-project">{() => null}</Async>}</div>;
  if (!cat || legacy) return <div className="view pcf" />;

  const props = { p, cat, people, s: { ...s, tab }, set };
  const body = ({
    overview: <OverviewProto {...props} />, flow: <FlowProto {...props} />, approvers: <ApproversProto {...props} />, mcp: <McpProto {...props} />, budget: <BudgetProto {...props} />, repos: <ReposProto {...props} />,
    members: <MembersTab {...props} />, line: <LineProto {...props} />,
  } as Record<string, React.ReactNode>)[tab] ?? <OverviewProto {...props} />;
  const active = tab;
  return (
    <div className="view pcf">
      <ViewHead
        kicker={p.key} title="Project config" sub={`${p.name} · ${p.key}`}
        actions={<Select id="pcf-project" style={{ width: 200 }} aria-label="Project" value={p.id} options={projects.map((x) => ({ value: x.id, label: x.name }))} onChange={(v) => { updatePrefs({ project: v }); setTabQ(null); navigate("project-config"); }} />}
      />
      <Tabs revealActive idPrefix="pcf-tab" items={TABS.map((t) => ({ id: t[0], label: t[1], count: t[0] === "mcp" ? p.mcp.length : null }))} active={active} onChange={(id) => set({ tab: id })} />
      <div className="pcf-body" id="pcf-tab-panel" role="tabpanel" aria-labelledby={`pcf-tab-${active}`}>
        {body}
      </div>
    </div>
  );
}
