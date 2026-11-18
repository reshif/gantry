/**
 * Project config (#project-config, #project-config/<id>): the prototype's seven tabs, General, Stations and gates, Classes, Approvers,
 * Members, Freezes and Danger zone, with a project switcher in the header and a Line halted banner. The tab, the open editor and the
 * project are in the URL (`#/p/<project>/project-config/<id>?tab=members`). Budget, Notifications, MCP and History are reached from
 * General's "More settings" (`?tab=budget` and so on). Every change goes through ops, which call the API.
 */
import { useEffect, useRef, useState } from "react";
import { useMe, usePeople, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, replaceHash, useHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { Btn, Empty, IconBtn, Select, Tabs } from "../ui/primitives";
import { Page, CrIcon } from "../ui/cr";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { makeStopActions } from "../shell/stopActions";
import { useActors } from "../ui/actors";
import { useCatalog, type PView } from "./projects/kit";
import { useParams } from "./projects/url";
import { type CfgState } from "./project-config/ctx";
import { FlowTab } from "./project-config/flow";
import { ClassesTab } from "./project-config/classes";
import { ApproversTab } from "./project-config/approvers";
import { BudgetTab, HistoryTab, McpTab, NotificationsTab } from "./project-config/misc";
import { ApproversTable, ClassesTable, DangerCard, FreezesTab, GeneralTab, MembersTable, OnCallTab, OverlayTab, StationsTab } from "./project-config/tabs";
import { useSaveFromProject } from "./projects/templates";

export const PCF_TABS: Array<[string, string]> = [["general", "General"], ["stations", "Stations and gates"], ["classes", "Classes"], ["approvers", "Approvers"], ["members", "Members"], ["freezes", "Freezes"], ["danger", "Danger zone"]];
const EXTRA = ["budget", "notifications", "mcp", "history", "overlay", "oncall"];
/** Tab names from before the rebuild (`#project-config/approvers/G2`, "Edit rule" on a gate) map to the new tabs. */
const LEGACY: Record<string, string> = { overview: "general", flow: "stations", "work-classes": "classes" };

const TAB_ALIAS: Record<string, string> = { overview: "general", flow: "stations" };
const fresh = (): Omit<CfgState, "tab" | "gate"> => ({ flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, drafts: {}, text: {} });

export default function ProjectConfigView() {
  const ui = useUI();
  const me = useMe();
  const hash = useHash();
  const [params, setParams] = useParams();
  const projectsQ = useProjects();
  const projects = (projectsQ.data ?? []) as PView[];
  const people = usePeople().data ?? [];
  const cat = useCatalog();
  const actor = useActors();
  // `project-config/<id>` names the project; `project-config/approvers/G2` is a legacy deep link into a tab
  const seg = (hash.param ?? "").split("/");
  const idParam = projects.find((x) => x.id === seg[0])?.id ?? null;
  const legacyTab = !idParam && seg[0] ? (LEGACY[seg[0]] ?? seg[0]) : null;
  const legacyGate = !idParam && seg[0] === "approvers" ? seg[1] || "G5" : "";
  const pid = idParam ?? pickProject(me, hash.project);
  const p = projects.find((x) => x.id === pid) ?? null;
  const known = [...PCF_TABS.map((t) => t[0]), ...EXTRA];
  const tabQ = params.get("tab") ?? legacyTab ?? "general";
  const tab = known.includes(tabQ) ? tabQ : "general";
  const edit = params.get("edit") ?? legacyGate;
  const [s, setS] = useState(fresh);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (pid && last.current !== null && last.current !== pid) setS(fresh());
    last.current = pid;
  }, [pid]);
  // a project in the URL that is not the current one becomes the current one (the hash decides the project)
  useEffect(() => {
    if (idParam && hash.project !== idParam) replaceHash(hashFor("project-config", idParam, idParam) + (hash.query ? `?${hash.query}` : ""));
  }, [idParam, hash.project, hash.query]);
  const tplGuard = useCan("template.edit");
  const saveAs = useSaveFromProject();
  const halt = useCan("line.halt", { project: pid ?? undefined });
  const goTab = (t: string) => setParams({ tab: t === "general" ? null : t, edit: null });
  const setEdit = (v: string) => setParams({ edit: v || null });

  if (!me) return null;
  if (!pid) return <div className="view"><Empty title="No project" text="Pick a project in the top bar." /></div>;
  if (!p) return <div className="view pcf">{projectsQ.data ? <Empty id="pcf-gone" title="Project not found" text="It may have been removed, or you no longer have a role on it." /> : <Async query={projectsQ} what="this project" id="pcf-project">{() => null}</Async>}</div>;
  if (!cat) return <div className="view pcf" />;

  const state: CfgState = { ...s, tab, gate: edit && edit !== "flow" && edit !== "classes" ? edit : "G5" };
  const set = (patch: Partial<CfgState>) => {
    const { tab: t, gate, ...rest } = patch;
    if (Object.keys(rest).length) setS((x) => ({ ...x, ...rest }));
    if (t !== undefined) {
      const n = TAB_ALIAS[t] ?? t;
      setParams({ tab: n === "general" ? null : n, edit: t === "approvers" && gate ? gate : null });
    } else if (gate) setParams({ edit: gate });
  };
  const props = { p, cat, people, s: state, set, edit, setEdit, goTab };
  const body = ({
    general: <GeneralTab {...props} advanced={null} />,
    stations: <StationsTab {...props} advanced={<FlowTab {...props} />} />,
    classes: <ClassesTable {...props} advanced={<ClassesTab {...props} />} />,
    approvers: <ApproversTable {...props} advanced={<ApproversTab {...props} />} />,
    members: <MembersTable {...props} advanced={null} />,
    freezes: <FreezesTab {...props} advanced={null} />,
    danger: <DangerCard {...props} advanced={null} />,
    overlay: <OverlayTab {...props} advanced={null} />, oncall: <OnCallTab {...props} advanced={null} />,
    budget: <BudgetTab {...props} />, notifications: <NotificationsTab {...props} />, mcp: <McpTab {...props} />, history: <HistoryTab {...props} />,
  } as Record<string, React.ReactNode>)[tab];
  const stop = makeStopActions(ui, me);
  const by = p.halted ? actor(p.halted.by).name : "";
  const tools = (anchor: HTMLElement) => ui.menu(anchor, "Project tools", [
    { label: "Edit stations, gates and routes", icon: "tool", onClick: () => setParams({ tab: "stations", edit: "flow" }) },
    { label: "Edit classes", icon: "tool", onClick: () => setParams({ tab: "classes", edit: "classes" }) },
    { label: "Edit approver rules", icon: "tool", onClick: () => setParams({ tab: "approvers", edit: "G5" }) },
    { label: "Instructions overlay", onClick: () => goTab("overlay") },
    { label: "Budget", onClick: () => goTab("budget") },
    { label: "Notifications", onClick: () => goTab("notifications") },
    { label: "MCP servers", onClick: () => goTab("mcp") },
    { label: "On call", onClick: () => goTab("oncall") },
    { label: "History", onClick: () => goTab("history") },
    { label: "Onboarding", icon: "branch", onClick: () => { window.location.hash = hashFor("onboarding", null, p.id); } },
    { label: "Save as template", icon: "copy", guard: tplGuard, onClick: () => saveAs(p) },
  ]);
  const switchTo = (id: string) => { if (id !== p.id) window.location.hash = hashFor("project-config", id, id); };

  return (
    <Page
      cls="pcf"
      eyebrow={`Portfolio · ${p.key}`}
      title={p.name}
      sub="Project configuration: line, people, approvals and safety."
      acts={<><Select id="pcf-switch" aria-label="Switch project" style={{ width: "auto" }} options={projects.filter((x) => x.status !== "archived" || x.id === p.id).map((x) => ({ value: x.id, label: x.name }))} value={p.id} onChange={switchTo} /><IconBtn icon="tool" id="pcf-tools" label="Project tools" onClick={() => { const el = document.getElementById("pcf-tools"); if (el) tools(el); }} /></>}
    >
      <Tabs idPrefix="pcf-tab" items={PCF_TABS.map((t) => ({ id: t[0], label: t[1] }))} active={PCF_TABS.some((t) => t[0] === tab) ? tab : "general"} onChange={goTab} />
      {p.halted || p.killed ? (
        <div className="banner warn" id="pcf-halted">
          <CrIcon name="pause" />
          <div className="grow"><b>{p.killed ? "Project stopped" : "Line halted"}</b>{" "}{p.killed ? `by ${actor(p.killed.by).name}: ${p.killed.reason}` : p.halted ? `by ${by}: ${p.halted.reason}` : ""}</div>
          {p.killed ? null : <Btn small id="pcf-resume" guard={halt} label="Resume" onClick={() => void stop.resume(p.id)} />}
        </div>
      ) : null}
      {EXTRA.includes(tab) ? <div className="row" style={{ marginBottom: 12 }}><Btn small kind="ghost" icon="back" id="pcf-back" label="Back to General" onClick={() => goTab("general")} /></div> : null}
      <div className="pcf-body" id="pcf-tab-panel" role="tabpanel" aria-labelledby={`pcf-tab-${PCF_TABS.some((t) => t[0] === tab) ? tab : "general"}`}>{body}</div>
    </Page>
  );
}
