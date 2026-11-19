/**
 * Project config (#project-config): the Blueprint's eight tabs (Overview, Flow, Approvers, MCP, Budget, Repos, Members, Line control), the tab held in the URL (`?tab=`).
 * Nothing sits behind a menu. An old `?tab=` id (classes, rules, spend, archive, history ...) lands on the tab and section that took it over. Every change goes through ops, which call the API.
 */
import { useEffect, useRef, useState } from "react";
import { LEAVE_MESSAGE, pageHasUnsaved } from "../lib/useLeaveGuard";
import { useMe, usePeople, useProjects } from "../api/queries";
import { navigate, parseHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { Btn, Empty, Panel, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { flowOf, useCatalogQuery, type PView } from "./projects/kit";
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
/** Where an old bookmark's section sits on its new tab (`?sec=`). */
const SEC_ANCHOR: Record<string, string> = { classes: "flw-classes", history: "pcf-recent", notifications: "pcf-notify", overlay: "pcf-overlay" };
const fresh = (): CfgState => ({ tab: linked()?.tab ?? "overview", flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, drafts: {} });

export default function ProjectConfigView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const projects = (projectsQ.data ?? []) as PView[];
  const people = usePeople().data ?? [];
  const catQ = useCatalogQuery();
  const cat = catQ.data ?? null;
  const pid = pickProject(me, prefs.project);
  const p = projects.find((x) => x.id === pid) ?? null;
  const [s, setS] = useState<CfgState>(fresh);
  const [tabQ, setTabQ] = useQueryParam("tab");
  const [secQ, setSecQ] = useQueryParam("sec");
  const [, setDlgQ] = useQueryParam("dlg");
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
  // a path-segment link (#/p/x/project-config/budget, or .../approvers/G2 from the Traveler's "Edit rule") is adopted on arrival and on a same-page address edit:
  // the segment moves into the query (?tab=approvers&rule=G2) so the address, a reload and the screen agree after a tab switch
  useEffect(() => {
    const adopt = () => {
    const l = linked();
    if (!l) return;
    if (l.gate) setRuleQ(l.gate);
    setTabQ(l.tab === "overview" ? null : l.tab);
    setS((x) => ({ ...x, tab: l.tab }));
    try {
      const h = window.location.hash;
      const i = h.indexOf("project-config");
      if (i >= 0) {
        const qi = h.indexOf("?");
        const next = h.slice(0, i + "project-config".length) + (qi < 0 ? "" : h.slice(qi));
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${next}`);
      }
    } catch { /* no history access */ }
    };
    adopt();
    window.addEventListener("hashchange", adopt);
    return () => window.removeEventListener("hashchange", adopt);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // an old bookmark's section (`?sec=`) scrolls into view once its tab is showing
  useEffect(() => {
    const id = secQ ? SEC_ANCHOR[secQ] : undefined;
    if (id && cat && p && !legacy) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [secQ, tab, !!cat, !!p]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<CfgState>) => {
    const { tab: t, ...rest } = patch;
    if (t && t !== tab) {
      // a tab switch is only a replaceState, so the page-leave guard never sees it: ask here before an unsaved draft is dropped
      if (pageHasUnsaved() && !window.confirm(LEAVE_MESSAGE)) return;
      setSecQ(null); setRuleQ(null); setDlgQ(null);
    }
    if (t) setTabQ(t === "overview" ? null : t);
    setS((x) => ({ ...x, ...rest, ...(t ? { tab: t } : {}) }));
  };

  if (!me) return null;
  if (!pid) return <div className="view"><Empty title="No project" text="Pick a project in the top bar." /></div>;
  if (!p) return <div className="view pcf">{projectsQ.data ? <><ViewHead title="Project config" /><Panel><Empty id="pcf-gone" title="Nothing to show" text="That project does not exist." action={<Btn label="Work orders" onClick={() => navigate("work-orders")} />} /></Panel></> : <Async query={projectsQ} what="this project" id="pcf-project">{() => null}</Async>}</div>;
  if (!cat) return <div className="view pcf"><ViewHead title="Project config" sub={`${p.name} · ${p.key}`} /><Async query={catQ} what="the project catalogue" id="pcf-catalog">{() => null}</Async></div>;
  if (legacy) return <div className="view pcf" />;

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
      />
      <Tabs revealActive idPrefix="pcf-tab" items={TABS.map((t) => ({ id: t[0], label: t[1], count: t[0] === "mcp" ? p.mcp.length : null }))} active={active} onChange={(id) => set({ tab: id })} />
      <div className="pcf-body" id="pcf-tab-panel" role="tabpanel" aria-labelledby={`pcf-tab-${active}`}>
        {body}
      </div>
    </div>
  );
}
