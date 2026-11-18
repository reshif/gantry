/**
 * Access (spec 8.9, 14.4). Port of legacy/js/views/access.js: the policy simulator (server-side, same can() as enforcement),
 * scoped policies, freezes, the roles x actions matrix and roles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ops } from "../api/ops";
import { useCan } from "../api/can";
import { useAccessMatrix, useFreezes, useMe, usePeople, usePolicies, useProjects } from "../api/queries";
import { Btn, Empty, LockNote, Tabs, type Decision } from "../ui/primitives";
import { Card, Page } from "../ui/cr";
import { useUrlState } from "./govern/urlState";
import { Async } from "../ui/async";
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

  const [tab, setTab] = useUrlState("tab", "matrix"); // matrix | policies | check, plus the secondary freezes and roles surfaces (reached from the cards)
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [sim, setSim] = useState<Sim | null>(null);
  const [evaluated, setEvaluated] = useState<Evaluated | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<string | null>(null);
  const [fromPeople, setFromPeople] = useState<string | null>(null);

  // Like the prototype: the first person and the first permission, on the first project.
  const defaults = useCallback((): Sim => ({ person: people[0]?.id ?? me?.person.id ?? "", action: actions[0]?.id ?? "project.view", project: projects[0]?.id ?? "", repo: "", ...nowIst() }), [me, people, projects, actions]);
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
      if (jump && tabRef.current !== "check") setTab(rule.freeze ? "freezes" : rule.kind === "policy" ? "policies" : "matrix");
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
  if (!view.allowed) return <Page cls="view-access" eyebrow="Govern" title="Access"><Empty id="access-no-access" title="No access to the access policy" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin to give you a role that can see policy.`} /></Page>;
  const toolsFor = (t: string) =>
    t === "freezes" ? <Btn label="Schedule freeze" small icon="clock" id="acc-add-freeze" guard={perm} onClick={openFreeze} />
    : t === "policies" ? <Btn label="Add policy" small kind="primary" icon="plus" id="acc-add-policy" guard={perm} onClick={() => openPolicy(null)} />
    : t === "roles" ? <Btn label="Add role" small icon="plus" id="acc-add-role" guard={rperm} onClick={() => openRole(null)} />
    : null;

  const showRights = (id: string) => {
    setTab("matrix");
    setNewRole(id);
    setTimeout(() => document.getElementById(`acc-mx-col-${id}`)?.scrollIntoView({ block: "nearest", inline: "center" }), 80);
  };

  const fromName = fromPeople ? people.find((p) => p.id === fromPeople)?.name ?? fromPeople : null;
  const matrixTab = tab === "matrix";

  return (
    <Page cls="view-access" eyebrow="Govern" title="Access" sub="What each role may do, which policies add conditions, and a way to test a decision.">
      <LockNote decision={perm} what="The role matrix, policies and freezes" />
      {fromName ? (
        <div className="callout acc-from" id="acc-from-people" role="status">
          <Icon name="info" />
          <div><strong>Opened from People</strong><span>{` The simulator is asking the same question as the cell you picked for ${fromName}.`}</span></div>
          <Btn label="Dismiss" small id="acc-from-dismiss" onClick={() => setFromPeople(null)} />
        </div>
      ) : null}
      <Tabs
        idPrefix="acc-tab"
        active={tab}
        onChange={setTab}
        items={[{ id: "matrix", label: "Matrix" }, { id: "policies", label: "Policies" }, { id: "check", label: "Check access" }]}
      />
      <div className="acc-body" id="acc-tab-panel" role="tabpanel">
        {tab === "check" ? (
      mQ.isError && !m ? (
        <section className="panel" aria-label="Policy simulator"><div className="panel-body"><Async query={mQ} what="the access matrix" id="acc-matrix">{() => null}</Async></div></section>
      ) : (
        <Simulator
          roles={roles} people={people} projects={projects} repos={repos} actions={actions} sim={cur} setSim={setSim} evaluated={evaluated}
          onEvaluate={(s) => void evaluate(s)} onShowRule={setTab} presetsList={presets(people, projects, repos)}
        />
      )
        ) : (
        <Async query={(tab === "freezes" ? freezesQ : tab === "policies" ? policiesQ : mQ) as UseQueryResult<unknown>} what={tab === "freezes" ? "freezes" : tab === "policies" ? "policies" : "the access matrix"} id="acc">{() => (
        matrixTab ? <Card title="Role by permission" hint="Built-in roles are fixed. Custom roles are not enabled." flush id="acc-matrix-card"><MatrixTable matrix={matrix} version={m?.version} roles={roles} actions={actions} hl={hl} evaluated={evaluated} people={people} newRole={newRole} /></Card>
        : tab === "freezes" ? <Card title="Freezes" flush id="acc-freezes-card" acts={<>{<Btn label="Policies" small kind="ghost" id="acc-back-policies" onClick={() => setTab("policies")} />}{toolsFor("freezes")}</>}><FreezeList freezes={freezes} repos={repos} hlFreeze={evaluated && (evaluated.result.decision.rule as { freeze?: string }).freeze ? (evaluated.result.decision.rule as { freeze?: string }).freeze! : null} /></Card>
        : tab === "roles" ? <Card title="Roles" flush id="acc-roles-card" acts={<><Btn label="Matrix" small kind="ghost" id="acc-back-matrix" onClick={() => setTab("matrix")} />{toolsFor("roles")}</>}><RolesList roles={roles} matrix={matrix} actions={actions} people={people} onRights={showRights} onEdit={openRole} onRemove={removeRole} /></Card>
        : (
          <Card title="Policies" flush id="acc-policies-card">
          <PolicyCards
            policies={policies} hl={hl} roles={roles} onEdit={openPolicy}
          />
          </Card>
        )
        )}</Async>
        )}
      </div>
    </Page>
  );
}
