/**
 * The New work order dialog (legacy traveler.js newWODialog) and the reason a submit is blocked (legacy submitGuard).
 * The submit button is guarded by the server's decision for this person and by the stop and onboarding state; one click makes one
 * work order (the request carries an Idempotency-Key that is kept for retries of the same dialog).
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ONBOARD_STAGES, classOf as classDef, classify, classesOf, route as routeOf, routeGates, type Project, type Repo } from "@gantry/domain";
import { useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import type { Me } from "../../api/types";
import { useMe } from "../../api/queries";
import { useProjectRepos } from "../floor/kit";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { Btn, Field, Select } from "../../ui/primitives";
import { CrIcon } from "../../ui/cr";
import { useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { registerCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { getPrefs, setProject, usePrefs } from "../../lib/prefs";
import { useCatalog } from "../projects/kit";
import { ClassificationCard } from "./intake";

const STAGE_NAMES: Record<string, string> = { ...Object.fromEntries(ONBOARD_STAGES.map((s) => [s.id, s.name])), failed: "Failed", person: "Needs a person" };
const shortRepo = (n: string): string => n.split("/").pop() ?? n;
const ready = (r: Repo): boolean => r.onboarding.stage === "ready" || !!r.onboarding.exception;

/** Why submissions are refused for a project (and repo), or null. Mirrors the server's own checks, which decide in the end. */
export function submitBlock(me: Me, project: Pick<Project, "id" | "name" | "status" | "killed">, repos: Repo[], repoId: string | null): { reason: string; onboarding: boolean } | null {
  const f = me.factory.killed;
  if (f) return { reason: `Submissions are refused. The factory is killed: ${f.reason}.`, onboarding: false };
  if (project.killed) return { reason: `Submissions are refused. ${project.name} is killed: ${project.killed.reason}.`, onboarding: false };
  if (project.status === "archived") return { reason: `Submissions are refused. ${project.name} is archived.`, onboarding: false };
  if (!repoId) return repos.length ? { reason: `Pick a repo in ${project.name}.`, onboarding: false } : { reason: `No repos in ${project.name} yet. Connect one and finish onboarding first.`, onboarding: true };
  const r = repos.find((x) => x.id === repoId);
  if (!r) return { reason: `Pick a repo in ${project.name}.`, onboarding: false };
  if (!ready(r)) return { reason: `${r.name} is not ready: onboarding is at '${STAGE_NAMES[r.onboarding.stage] ?? r.onboarding.stage}'. Finish onboarding first.`, onboarding: true };
  return null;
}

/** Whether any repo of the project can take work now: the reason the New work order button is locked, or null. */
export function projectSubmitBlock(me: Me, project: Pick<Project, "id" | "name" | "status" | "killed">, repos: Repo[]): string | null {
  const stop = submitBlock(me, project, repos, repos.find(ready)?.id ?? null);
  if (!stop) return null;
  if (!stop.onboarding) return stop.reason.replace(/^Submissions are refused\. /, "");
  return `No repo in ${project.name} is Ready yet. Finish onboarding first`;
}

export interface NewWoPreset {
  project?: string;
  repo?: string;
  title?: string;
  description?: string;
  source?: string;
}

export function NewWorkOrderDialog({ preset, onClose, variant = "dialog", aside }: { preset: NewWoPreset; onClose: () => void; variant?: "dialog" | "page"; aside?: ReactNode }) {
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const prefs = usePrefs();
  const projects = (me?.projects ?? []).filter((p) => p.status !== "archived");
  const defaultProject = preset.project && projects.some((p) => p.id === preset.project) ? preset.project : (projects.find((p) => p.id === prefs.project)?.id ?? projects[0]?.id ?? "");
  const [projectId, setProjectId] = useState<string>(preset.project && projects.some((p) => p.id === preset.project) ? preset.project : (projects.find((p) => p.id === prefs.project)?.id ?? projects[0]?.id ?? ""));
  const repos = useProjectRepos(projectId);
  const [repoId, setRepoId] = useState<string | null>(preset.repo ?? null);
  const [title, setTitle] = useState(preset.title ?? "");
  const [desc, setDesc] = useState(preset.description ?? "");
  const [files, setFiles] = useState<string[]>([]);
  const [cls, setCls] = useState("");
  const [prio, setPrio] = useState("P2");
  const [tpl, setTpl] = useState("");
  const source = preset.source ?? "web";
  const [err, setErr] = useState("");
  const [titleErr, setTitleErr] = useState("");
  const titleEl = useRef<HTMLInputElement>(null);
  // The refusal is shown inline (setErr), so the command toasts nothing itself.
  const send = useCommand(ops.submitWO, { ok: false, toastFail: false });
  const busy = send.busy;
  const key = useRef(globalThis.crypto.randomUUID());
  const can = useCanMany(projects.map((p) => ({ action: "wo.submit", project: p.id })));
  const project = projects.find((p) => p.id === projectId);
  // the repo follows the project: the first Ready one unless a pick is still valid
  const repo = repoId && repos.some((r) => r.id === repoId) ? repoId : (repos.find(ready)?.id ?? repos[0]?.id ?? null);
  useEffect(() => {
    key.current = globalThis.crypto.randomUUID();
    // The inline error describes the form as it was submitted: once a field changes it no longer applies (a title typed after "Give the work order a title" must clear it).
    setErr("");
  }, [projectId, repo, title, desc, files, cls, prio]);
  useEffect(() => { setTitleErr(""); }, [title]);
  if (!me || !cat || !project) return null;
  const decision = can[projects.indexOf(project)];
  const block = decision && !decision.allowed && !decision.pending ? { reason: decision.reason, needs: decision.needs, onboarding: false } : (() => { const b = submitBlock(me, project, repos, repo); return b ? { reason: b.reason, needs: "", onboarding: b.onboarding } : null; })();
  const fullProject = project as unknown as Project;
  const classes = classesOf(cat, fullProject);
  const text = `${title} ${desc}`.trim();
  const guess = classify(cat, text, cls || null, fullProject);
  const clsId = cls || guess.cls;
  const clsDef = classDef(cat, fullProject, clsId);
  const stationName = (id: string): string => cat.stations.find((x) => x.id === id)?.name ?? id;
  const path = routeOf(cat, fullProject, clsId);
  const gateIds = routeGates(cat, fullProject, clsId);
  const gateLabel = (id: string): string => cat.gates.find((g) => g.id === id)?.label ?? id;
  const confidence = cls ? "you chose it" : text.length >= 6 ? `${Math.round(guess.confidence * 100)}%` : "—";
  const attach = () => {
    // A real file picker: only the names are kept (the work order records attachment names).
    const pick = document.createElement("input");
    pick.type = "file";
    pick.multiple = true;
    pick.onchange = () => setFiles((x) => [...x, ...Array.from(pick.files ?? []).map((f) => f.name).filter((n) => !x.includes(n))]);
    pick.click();
  };
  const applyTemplate = (v: string) => {
    // The prototype returns the select to "Start from template…" once a template has filled the form.
    setTpl("");
    const t = v === "bug" ? { title: "Fix: ", desc: "Steps to reproduce:\n1. \nExpected:\nActual:", cls: "bug" } : v === "feat" ? { title: "Add ", desc: "Goal:\nAcceptance criteria:\n- ", cls: "feature" } : v === "chore" ? { title: "Bump dependencies", desc: "Update minor versions and run tests.", cls: "chore" } : null;
    if (!t) return;
    setTitle(t.title);
    setDesc(t.desc);
    setCls(classes.some((c) => c.id === t.cls) ? t.cls : "");
  };
  const submit = async () => {
    if (busy) return;
    if (block) {
      setErr(block.reason);
      return;
    }
    if (!repo) {
      setErr(`Pick a repo in ${project.name}.`);
      return;
    }
    const t = title.trim();
    const bad = !t ? "Title is required." : t.length < 8 ? "Title needs at least 8 characters." : "";
    if (bad) {
      setTitleErr(bad);
      titleEl.current?.focus();
      return;
    }
    const r = await send.run(
      { project: projectId, repo, title: title.trim(), description: desc.trim(), priority: prio, requestedCls: cls || undefined, attachments: files, source },
      source === "console" ? "console" : "web",
      key.current,
    );
    if (!r) return;
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    onClose();
    const id = (r as unknown as { id?: string }).id;
    if (id && variant === "page") {
      // The Console screen goes to the new record, like the prototype.
      ui.toast(`Submitted ${id}. It is in the Intake queue.`, "ok");
      navigate("record", id, projectId);
    } else if (id) ui.open((close) => <ClassificationCard woId={id} onClose={close} />);
    else ui.toast(r.msg, "ok");
  };
  const previewEl = (
    <div className="nwo-route" aria-live="polite">
      <div className="row spread"><span className="label">Predicted class</span><span className="chip info">{clsDef.name}</span></div>
      <dl className="kv" id="nwo-kv">
        <dt>Confidence</dt><dd>{confidence}</dd>
        <dt>Priority</dt><dd><span className={`tag pri ${prio.toLowerCase()}`}>{prio}</span></dd>
        <dt>SLA</dt><dd>{clsDef.slaH ? `${clsDef.slaH} h` : "not available"}</dd>
        <dt>Skips</dt><dd>{clsDef.skips.length ? clsDef.skips.map(stationName).join(", ") : "none"}</dd>
        <dt>Gates</dt><dd>{gateIds.length ? gateIds.map(gateLabel).join(", ") : "not available"}</dd>
        <dt>Estimate</dt><dd>{clsDef.est ? `size ${clsDef.est}; cost and time not available` : "not available"}</dd>
      </dl>
      <div className="pipe" aria-label="Pipeline" id="nwo-pipe" style={{ marginTop: 12 }}>
        {cat.stations.map((st, i) => (
          <Fragment key={st.id}>
            {i ? <span className="ln" /> : null}
            <span className={`st${i === 0 ? " cur" : ""}`} {...(path.includes(st.id) ? {} : { style: { opacity: 0.45 } })} data-skipped={path.includes(st.id) ? undefined : "1"}><i>{i + 1}</i>{st.name}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
  const errEl = (
    <div className="form-err" role="alert">
      {err}
    </div>
  );
  const fields = (
    <>
          <Field label="Title (required)" htmlFor="nwo-title" hint="A short imperative sentence." error={titleErr || undefined}>
            <input id="nwo-title" ref={titleEl} className="input" value={title} placeholder="What should change?" autoComplete="off" aria-invalid={titleErr ? true : undefined} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="nwo-desc">
            <textarea id="nwo-desc" className="input" rows={5} placeholder="Context, acceptance criteria, links" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <div>
            {block ? (
              <div className="callout callout-warn" role="note">
                <Icon name="lock" />
                <span>
                  {`${block.needs ? `${block.needs}. ` : ""}${block.reason} `}
                  {block.onboarding ? (
                    <a href="#onboarding" className="linkish" id="nwo-onb-link" onClick={() => { setProject(projectId); onClose(); navigate("onboarding"); }}>{`Open onboarding for ${project.name}`}</a>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
          <div className="grid g2">
            <Field label="Project" htmlFor="nwo-project">
              <Select id="nwo-project" options={projects.map((p, i) => ({ value: p.id, label: p.name + (can[i]?.allowed === false && !can[i]?.pending ? " (not permitted)" : "") }))} value={projectId} onChange={(v) => { setProjectId(v); setRepoId(null); }} />
            </Field>
            <Field label="Repository" htmlFor="nwo-repo">
              {repos.length ? (
                <Select id="nwo-repo" options={(repos.some(ready) ? repos.filter(ready) : repos).map((r) => ({ value: r.id, label: shortRepo(r.name) }))} value={repo} onChange={setRepoId} />
              ) : (
                <p className="muted small" id="nwo-repo">{`No repos in ${project.name} yet.`}</p>
              )}
            </Field>
            <Field label="Class" htmlFor="nwo-cls">
              <Select id="nwo-cls" options={[{ value: "", label: "Let Gantry classify" }, ...classes.map((c) => ({ value: c.id, label: c.name }))]} value={cls} onChange={setCls} />
            </Field>
            <Field label="Priority" htmlFor="nwo-prio">
              <Select id="nwo-prio" options={["P1", "P2", "P3"]} value={prio} onChange={setPrio} />
            </Field>
          </div>
          <div className="field">
            <span className="lbl">Attachments</span>
            <div className="row" id="nwo-files">
              {files.map((x) => <span key={x} className="tag">{x} <Btn small kind="ghost" aria={`Remove ${x}`} cls="nwo-rm" onClick={() => setFiles(files.filter((f) => f !== x))}>×</Btn></span>)}
              <Btn small id="nwo-attach" onClick={attach}><CrIcon name="plus" />Attach file</Btn>
            </div>
          </div>
    </>
  );
  if (variant === "page") {
    // The Console screen (Control Room prototype): the same form and the same submit, laid out as a card beside the route preview.
    return (
      <div className="grid g-main">
        <form className="card" id="conform" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="card-h"><h2>New work order</h2>
            <Select id="nwo-tpl" aria-label="Template" style={{ width: "auto" }} options={[{ value: "", label: "Start from template…" }, { value: "bug", label: "Bug report" }, { value: "feat", label: "Feature request" }, { value: "chore", label: "Dependency chore" }]} value={tpl} onChange={applyTemplate} />
          </div>
          <div className="card-b stack">{fields}{errEl}</div>
          <div className="dlg-f">
            <Btn kind="ghost" label="Reset" id="nwo-reset" onClick={() => { setTitle(""); setDesc(""); setFiles([]); setCls(""); setPrio("P2"); setTpl(""); setTitleErr(""); setProjectId(defaultProject); setRepoId(null); }} />
            <Btn kind="primary" type="submit" label={busy ? "Submitting…" : "Submit work order"} id="nwo-submit" guard={block ? { allowed: false, reason: block.reason, needs: block.needs } : null} />
          </div>
        </form>
        <div className="stack">
          <section className="card"><div className="card-h"><h2>Route preview</h2></div><div className="card-b" id="conprev">{previewEl}</div></section>
          {aside}
        </div>
      </div>
    );
  }
  return (
    <Dialog
      title="New work order"
      kicker="Intake · S0"
      wide
      onClose={onClose}
      sub="It starts at S0 Intake. The Intake agent classifies it, proposes a route and opens a conversation to complete the brief."
      body={<div className="form-grid">{fields}{previewEl}{errEl}</div>}
      actions={[{ label: "Cancel" }, { label: busy ? "Submitting…" : "Submit work order", kind: "primary", submit: true, id: "nwo-submit", guard: block ? { allowed: false, reason: block.reason, needs: block.needs } : null, onClick: () => void submit() }]}
    />
  );
}

/** Opens the Console screen, where work orders are submitted (the Control Room prototype's "New work order" destination everywhere). */
/** The project chosen for a new work order while the scope is All: the Console asks which project, this carries an answer already given (the Floor's menu). Read once. */
let pendingProject: string | null = null;
export const takePendingProject = (): string | null => {
  const p = pendingProject;
  pendingProject = null;
  return p;
};

export function useNewWorkOrder(): (preset?: NewWoPreset) => void {
  const ui = useUI();
  const me = useMe();
  return (preset = {}) => {
    if (!me?.projects.some((p) => p.status !== "archived")) {
      ui.toast("You have no projects to submit work to.", "warn");
      return;
    }
    if (preset.project) {
      pendingProject = preset.project;
      // Under All projects the pick stays this one work order's; only a narrowed scope remembers the project.
      if (!getPrefs().scopeAll) setProject(preset.project);
    }
    navigate("console", "submit");
  };
}

/** Makes "Submit a work order" available in the palette and on Home: registered once for the signed-in shell. */
export function useRegisterNewWorkOrder(): void {
  const open = useNewWorkOrder();
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => registerCommand("newWorkOrder", () => ref.current()), []);
}
