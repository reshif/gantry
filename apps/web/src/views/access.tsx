/**
 * Access (prototype "access"): four stats and five tabs: Role matrix, Roles, Policies, Freezes, Access check. Tab, filters and the
 * check's person / action / project live in the URL. Role, policy and freeze administration sits in each panel's header and row menu.
 */
import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useCan } from "../api/can";
import { useAccessMatrix, useFreezes, useMe, usePeople, usePolicies, useProjects } from "../api/queries";
import { Btn, Empty, LockNote, Panel, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useAllRepos } from "./govern/data";
import { Pager, setQS, useQS } from "./govern/kit";
import { FreezeList, useFreezeDialog } from "./access/Freezes";
import { MatrixTable } from "./access/Matrix";
import { PolicyTable, usePolicyDialog } from "./access/Policies";
import { RolesList, useRoleDialogs } from "./access/Roles";
import { Simulator, nowIst, type Sim } from "./access/Simulator";
import type { Project } from "@gantry/domain";
import "../styles/views/access.css";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const TABS = ["matrix", "roles", "policies", "freezes", "check"];

export default function AccessView() {
  const me = useMe();
  const mQ = useAccessMatrix();
  const m = mQ.data;
  const peopleData = usePeople().data;
  const people = useMemo(() => peopleData ?? [], [peopleData]);
  const policiesQ = usePolicies();
  const freezesQ = useFreezes();
  const policies = policiesQ.data ?? [];
  const freezes = freezesQ.data ?? [];
  const projectsData = useProjects().data;
  const myProjects = me?.projects;
  const projects = useMemo(() => (projectsData ?? myProjects ?? []) as Project[], [projectsData, myProjects]);
  const { repos } = useAllRepos();
  const perm = dec(useCan("policy.edit"));
  const rperm = dec(useCan("role.edit"));
  const view = dec(useCan("policy.view"));
  const roles = m?.roles ?? [];
  const actions = useMemo(() => m?.actions ?? [], [m]);
  const matrix = m?.matrix ?? {};

  const [tabV] = useQS("acc.tab", "matrix");
  const tab = TABS.includes(tabV) ? tabV : "matrix";
  const setTab = (t: string) => setQS({ "acc.tab": t === "matrix" ? "" : t });
  const [newRole, setNewRole] = useState<string | null>(null);

  const openPolicy = usePolicyDialog({ perm, roles, actions, projects, policies, matrix });
  const openFreeze = useFreezeDialog(perm);
  const { openRole, removeRole } = useRoleDialogs({
    perm: rperm, roles, matrix, actions, people,
    onCreated: (id) => {
      setTab("matrix");
      setNewRole(id);
    },
  });

  if (!me) return null;
  if (!view.allowed) return <div className="view view-access"><ViewHead title="Access" kicker="All lines" sub="" /><Empty id="access-no-access" icon="lock" title="No access to this sheet" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin to give you a role that can see policy.`} /></div>;
  const now = Date.now();
  const liveFz = freezes.filter((f) => f.to > now).length;

  const showRights = (id: string) => {
    setTab("matrix");
    setNewRole(id);
    setTimeout(() => document.getElementById(`acc-mx-col-${id}`)?.scrollIntoView({ block: "nearest", inline: "center" }), 80);
  };
  const simDefaults = (): Sim => ({ person: people.some((p) => p.id === "p-meera") ? "p-meera" : me.person.id, action: actions.some((a) => a.id === "wo.submit") ? "wo.submit" : actions[0]?.id ?? "", project: projects.some((p) => p.id === "payments") ? "payments" : projects[0]?.id ?? "", repo: "", ...nowIst() });

  return (
    <div className="view view-access">
      <ViewHead title="Access" kicker="All lines" sub="Roles, the action matrix, conditional policies and freezes." />
      <LockNote decision={perm} what="The role matrix, policies and freezes" />
      <StatRow id="acc-stats">
        <Stat label="Roles" value={qState(mQ, () => String(roles.length))} tone="info" />
        <Stat label="Actions" value={qState(mQ, () => String(actions.length))} sub="governed" />
        <Stat label="Policies" value={qState(policiesQ, () => String(policies.filter((p) => p.enabled).length))} sub={policiesQ.data ? `of ${policies.length} on` : undefined} />
        <Stat label="Freezes" value={qState(freezesQ, () => String(liveFz))} sub="active or upcoming" tone="wait" />
      </StatRow>
      <Tabs
        idPrefix="acc-tab"
        active={tab}
        onChange={setTab}
        items={[{ id: "matrix", label: "Role matrix" }, { id: "roles", label: "Roles", count: roles.length }, { id: "policies", label: "Policies", count: policies.length }, { id: "freezes", label: "Freezes", count: freezes.length }, { id: "check", label: "Access check" }]}
      />
      <div className="acc-body" id="acc-tab-panel" role="tabpanel">
        <Async query={(tab === "freezes" ? freezesQ : tab === "policies" ? policiesQ : mQ) as UseQueryResult<unknown>} what={tab === "freezes" ? "freezes" : tab === "policies" ? "policies" : "the access matrix"} id="acc">{() => (
          tab === "check" ? <Simulator people={people} projects={projects} actions={actions} matrix={matrix} defaults={simDefaults()} />
          : tab === "matrix" ? <Panel title="What each role may do" flush><MatrixTable matrix={matrix} version={m?.version} roles={roles} actions={actions} newRole={newRole} /></Panel>
          : tab === "roles" ? <Panel title="Roles" flush><><RolesList roles={roles} matrix={matrix} actions={actions} people={people} onRights={showRights} onEdit={openRole} onRemove={removeRole} /><Pager id="acc-roles-pager" page={0} total={roles.length} onPage={() => undefined} /></></Panel>
          : tab === "freezes" ? <Panel title="Change freezes" flush tools={<Btn label="New freeze" small kind="primary" icon="plus" id="acc-add-freeze" guard={perm} onClick={openFreeze} />}><FreezeList freezes={freezes} repos={repos} /></Panel>
          : (
            <Panel title="Conditional policies" flush>
              <PolicyTable
                policies={policies} people={people} onEdit={openPolicy}
                onSimulate={(p, who) => setQS({ "acc.tab": "check", "acc.person": who?.id ?? me.person.id, "acc.action": p.actions[0] ?? "", "acc.project": p.where.projects?.[0] ?? projects[0]?.id ?? "" })}
              />
            </Panel>
          )
        )}</Async>
      </div>
    </div>
  );
}
