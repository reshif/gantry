/**
 * Access (spec 8.9, 14.4). Port of legacy/js/views/access.js: the policy simulator (server-side, same can() as enforcement),
 * scoped policies, freezes, the roles x actions matrix and roles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ops } from "../api/ops";
import { useCan } from "../api/can";
import { useAccessMatrix, useFreezes, useMe, usePeople, usePolicies, useProjects } from "../api/queries";
import { Btn, Empty, LockNote, Panel, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import type { UseQueryResult } from "@tanstack/react-query";
import { Icon } from "../ui/Icon";
import { useOutcome, useAllRepos } from "./govern/data";
import { FreezeList, useFreezeDialog } from "./access/Freezes";
import { MatrixTable } from "./access/Matrix";
import { PolicyCards, usePolicyDialog } from "./access/Policies";
import { RolesList, useRoleDialogs } from "./access/Roles";
import { Simulator, nowIst, presets, simTime, type Evaluated, type Sim } from "./access/Simulator";
import type { Project, SimulationResult } from "@gantry/domain";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function AccessView() {
  const me = useMe();
  const outcome = useOutcome();
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

  const [tab, setTab] = useState("policies");
  const [sim, setSim] = useState<Sim | null>(null);
  const [evaluated, setEvaluated] = useState<Evaluated | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<string | null>(null);
  const [fromPeople, setFromPeople] = useState<string | null>(null);

  // Legacy opened on Kenji releasing payments-api; use it when the seeded org is there, otherwise ask about the viewer.
  const defaults = useCallback((): Sim => {
    const seeded = people.some((p) => p.id === "p-kenji") && projects.some((p) => p.id === "payments") && repos.some((r) => r.id === "payments-api");
    return seeded
      ? { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", ...nowIst() }
      : { person: me?.person.id ?? people[0]?.id ?? "", action: "release", project: projects[0]?.id ?? "", repo: "", ...nowIst() };
  }, [me, people, projects, repos]);
  const cur = sim ?? defaults();

  const evaluate = useCallback(
    async (s: Sim, jump = true) => {
      if (!s.date || !s.time) return void outcome({ ok: false, msg: "Pick a date and time.", status: 422 });
      const act = actions.find((a) => a.id === s.action);
      const t = simTime(s);
      const r = await ops.simulateAccess({ person: s.person, action: s.action, ...(act?.scope === "factory" ? {} : { project: s.project, ...(s.repo ? { repo: s.repo } : {}) }), time: t });
      if (!r.ok) return void outcome(r);
      const result = r as unknown as SimulationResult;
      setEvaluated({ sim: s, t, result });
      const rule = result.decision.rule as { kind: string; id: string; freeze?: string };
      setHl(rule.kind === "matrix" ? "MATRIX" : rule.id);
      if (jump) setTab(rule.freeze ? "freezes" : rule.kind === "policy" ? "policies" : "matrix");
    },
    [actions, outcome],
  );

  // The People screen hands a question over through session storage.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || !actions.length || !me) return;
    picked.current = true;
    try {
      const raw = sessionStorage.getItem("gantry.accessSim");
      if (!raw) return;
      sessionStorage.removeItem("gantry.accessSim");
      const q = JSON.parse(raw) as Partial<Sim>;
      const s = { ...defaults(), ...q, repo: q.repo ?? "" };
      setSim(s);
      setFromPeople(s.person);
      void evaluate(s);
    } catch {
      /* no handover */
    }
  }, [actions.length, me, defaults, evaluate]);

  // The answer follows the configuration: a matrix, policy, freeze or people change re-asks the engine.
  const sig = `${m?.version}|${policies.map((p) => `${p.id}:${(p as { version?: number }).version}:${p.enabled}`).join(",")}|${freezes.map((f) => `${f.id}:${f.to}`).join(",")}|${people.length}`;
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    if (evaluated) void evaluate(evaluated.sim, false);
  }, [sig, evaluated, evaluate]);

  const openPolicy = usePolicyDialog({ perm, roles, actions, projects, policies, matrix });
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const openFreeze = useFreezeDialog(perm, repos, projectName);
  const { openRole, removeRole } = useRoleDialogs({
    perm: rperm, roles, matrix, actions, people,
    onCreated: (id) => {
      setTab("matrix");
      setNewRole(id);
    },
  });

  if (!me) return null;
  if (!view.allowed) return <div className="view view-access"><ViewHead title="Access" sub="" /><Empty id="access-no-access" title="No access to the access policy" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin to give you a role that can see policy.`} /></div>;
  const now = Date.now();
  const activeFz = freezes.filter((f) => now >= f.from && now < f.to).length;
  const custom = roles.filter((r) => r.custom).length;
  const tools =
    tab === "freezes" ? <Btn label="Schedule freeze" small icon="clock" id="acc-add-freeze" guard={perm} onClick={openFreeze} />
    : tab === "policies" ? <Btn label="Add policy" small icon="plus" id="acc-add-policy" guard={perm} onClick={() => openPolicy(null)} />
    : <Btn label="Add role" small icon="plus" id="acc-add-role" guard={rperm} onClick={() => openRole(null)} />;

  const showRights = (id: string) => {
    setTab("matrix");
    setNewRole(id);
    setTimeout(() => document.getElementById(`acc-mx-col-${id}`)?.scrollIntoView({ block: "nearest", inline: "center" }), 80);
  };

  const fromName = fromPeople ? people.find((p) => p.id === fromPeople)?.name ?? fromPeople : null;
  const matrixTab = tab === "matrix";

  return (
    <div className="view view-access">
      <ViewHead
        title="Access"
        sub="Who may do what, where and when. Roles grant actions per project; policies narrow or extend them by project, hour and on-call status; freezes override everything for release."
      />
      <LockNote decision={perm} what="The role matrix, policies and freezes" />
      {fromName ? (
        <div className="callout acc-from" id="acc-from-people" role="status">
          <Icon name="info" />
          <div><strong>Opened from People</strong><span>{` The simulator is asking the same question as the cell you picked for ${fromName}.`}</span></div>
          <Btn label="Dismiss" small id="acc-from-dismiss" onClick={() => setFromPeople(null)} />
        </div>
      ) : null}
      <StatRow id="acc-stats">
        <Stat label="Roles" value={qState(mQ, () => String(roles.length))} sub={custom ? `${custom} custom` : undefined} />
        <Stat label="Actions" value={qState(mQ, () => String(actions.length))} />
        <Stat label="Policies on" value={qState(policiesQ, () => String(policies.filter((p) => p.enabled).length))} sub={policiesQ.data ? `of ${policies.length}` : undefined} />
        <Stat label="Freezes active" value={qState(freezesQ, () => String(activeFz))} tone={activeFz ? "block" : undefined} />
      </StatRow>
      {mQ.isError && !m ? (
        <section className="panel" aria-label="Policy simulator"><div className="panel-body"><Async query={mQ} what="the access matrix" id="acc-matrix">{() => null}</Async></div></section>
      ) : (
        <Simulator
          people={people} projects={projects} repos={repos} actions={actions} sim={cur} setSim={setSim} evaluated={evaluated}
          onEvaluate={(s) => void evaluate(s)} onShowRule={setTab} presetsList={presets(people, projects, repos)}
        />
      )}
      <div className="acc-tabbar">
        <Tabs
          idPrefix="acc-tab"
          active={tab}
          onChange={setTab}
          items={[{ id: "policies", label: "Policies", count: policies.length }, { id: "freezes", label: "Freezes", count: freezes.length }, { id: "matrix", label: "Roles × actions" }, { id: "roles", label: "Roles", count: roles.length }]}
        />
        <div className="acc-tab-tools">{tools}</div>
      </div>
      <div className="acc-body" id="acc-tab-panel" role="tabpanel">
        <Async query={(tab === "freezes" ? freezesQ : tab === "policies" ? policiesQ : mQ) as UseQueryResult<unknown>} what={tab === "freezes" ? "freezes" : tab === "policies" ? "policies" : "the access matrix"} id="acc">{() => (
        matrixTab ? <Panel flush cls="acc-rules"><MatrixTable matrix={matrix} version={m?.version} roles={roles} actions={actions} hl={hl} evaluated={evaluated} people={people} newRole={newRole} /></Panel>
        : tab === "freezes" ? <FreezeList freezes={freezes} repos={repos} hlFreeze={evaluated && (evaluated.result.decision.rule as { freeze?: string }).freeze ? (evaluated.result.decision.rule as { freeze?: string }).freeze! : null} />
        : tab === "roles" ? <Panel flush cls="acc-rules"><RolesList roles={roles} matrix={matrix} actions={actions} people={people} onRights={showRights} onEdit={openRole} onRemove={removeRole} /></Panel>
        : (
          <PolicyCards
            policies={policies} hl={hl} people={people} onEdit={openPolicy}
            onSimulate={(p, who) => {
              const proj = p.where.projects?.[0] ?? projects[0]?.id ?? "";
              const s: Sim = { person: who?.id ?? me.person.id, action: p.actions[0] ?? "release", project: proj, repo: "", ...nowIst() };
              setSim(s);
              void evaluate(s);
              window.scrollTo({ top: 0 });
            }}
          />
        )
        )}</Async>
      </div>
    </div>
  );
}
