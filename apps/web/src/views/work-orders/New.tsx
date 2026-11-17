/**
 * The New work order dialog (legacy traveler.js newWODialog) and the reason a submit is blocked (legacy submitGuard).
 * The submit button is guarded by the server's decision for this person and by the stop and onboarding state; one click makes one
 * work order (the request carries an Idempotency-Key that is kept for retries of the same dialog).
 */
import { useEffect, useRef, useState } from "react";
import { ONBOARD_STAGES, classify, classesOf, route as routeOf, type Project, type Repo } from "@gantry/domain";
import { useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import type { Me } from "../../api/types";
import { useMe } from "../../api/queries";
import { useProjectRepos } from "../floor/kit";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { Field, Select } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { registerCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { setProject, usePrefs } from "../../lib/prefs";
import { ClassChip, classOf, useCatalog } from "../projects/kit";
import { ClassificationCard } from "./intake";

const STAGE_NAMES: Record<string, string> = { ...Object.fromEntries(ONBOARD_STAGES.map((s) => [s.id, s.name])), failed: "Failed", person: "Needs a person" };
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

function NewWorkOrderDialog({ preset, onClose }: { preset: NewWoPreset; onClose: () => void }) {
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const prefs = usePrefs();
  const projects = (me?.projects ?? []).filter((p) => p.status !== "archived");
  const [projectId, setProjectId] = useState<string>(preset.project && projects.some((p) => p.id === preset.project) ? preset.project : (projects.find((p) => p.id === prefs.project)?.id ?? projects[0]?.id ?? ""));
  const repos = useProjectRepos(projectId);
  const [repoId, setRepoId] = useState<string | null>(preset.repo ?? null);
  const [title, setTitle] = useState(preset.title ?? "");
  const [desc, setDesc] = useState(preset.description ?? "");
  const [att, setAtt] = useState("");
  const [cls, setCls] = useState("");
  const [prio, setPrio] = useState("auto");
  const [source, setSource] = useState(preset.source ?? "web");
  const [err, setErr] = useState("");
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
  }, [projectId, repo, title, desc, att, cls, prio, source]);
  if (!me || !cat || !project) return null;
  const decision = can[projects.indexOf(project)];
  const block = decision && !decision.allowed && !decision.pending ? { reason: decision.reason, needs: decision.needs, onboarding: false } : (() => { const b = submitBlock(me, project, repos, repo); return b ? { reason: b.reason, needs: "", onboarding: b.onboarding } : null; })();
  const fullProject = project as unknown as Project;
  const classes = classesOf(cat, fullProject);
  const text = `${title} ${desc}`.trim();
  const preview = text.length >= 6 ? classify(cat, text, cls || null, fullProject) : null;
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
    if (title.trim().length < 3) {
      setErr("Give the work order a title.");
      return;
    }
    const r = await send.run(
      { project: projectId, repo, title: title.trim(), description: desc.trim(), priority: prio === "auto" ? undefined : prio, requestedCls: cls || undefined, attachments: att.split(",").map((s) => s.trim()).filter(Boolean), source },
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
    if (id) ui.open((close) => <ClassificationCard woId={id} onClose={close} />);
    else ui.toast(r.msg, "ok");
  };
  return (
    <Dialog
      title="New work order"
      kicker="Intake · S0"
      wide
      onClose={onClose}
      sub="It starts at S0 Intake. The Intake agent classifies it, proposes a route and opens a conversation to complete the brief."
      body={
        <div className="form-grid">
          <div className="form-row">
            <Field label="Project" htmlFor="nwo-project">
              <Select id="nwo-project" options={projects.map((p, i) => ({ value: p.id, label: p.name + (can[i]?.allowed === false && !can[i]?.pending ? " (not permitted)" : "") }))} value={projectId} onChange={(v) => { setProjectId(v); setRepoId(null); }} />
            </Field>
            <div className="nwo-repo">
              <Field label="Repo" htmlFor="nwo-repo" hint="Only Ready repos accept work orders.">
                {repos.length ? (
                  <Select id="nwo-repo" options={repos.map((r) => ({ value: r.id, label: r.name + (ready(r) ? "" : ` (not ready: ${STAGE_NAMES[r.onboarding.stage] ?? r.onboarding.stage})`) }))} value={repo} onChange={setRepoId} />
                ) : (
                  <p className="muted small" id="nwo-repo">{`No repos in ${project.name} yet.`}</p>
                )}
              </Field>
            </div>
          </div>
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
          <Field label="Title" htmlFor="nwo-title">
            <input id="nwo-title" className="input" value={title} placeholder="Add idempotency keys to refund endpoint" autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="nwo-desc" hint="Acceptance criteria help the Spec agent.">
            <textarea id="nwo-desc" className="input" rows={4} placeholder="What should change, and how will we know it is done?" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label="Attachment names" htmlFor="nwo-att" hint="Names only; files are not uploaded here.">
            <input id="nwo-att" className="input" placeholder="trace.log, screenshot.png" autoComplete="off" value={att} onChange={(e) => setAtt(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="Requested class" htmlFor="nwo-cls" hint="The classifier may disagree; overrides are audited.">
              <Select id="nwo-cls" options={[{ value: "", label: "Let the Intake agent decide" }, ...classes.map((c) => ({ value: c.id, label: c.name }))]} value={cls} onChange={setCls} />
            </Field>
            <Field label="Priority" htmlFor="nwo-prio">
              <Select id="nwo-prio" options={[{ value: "auto", label: "From class" }, { value: "P1", label: "P1 · urgent" }, { value: "P2", label: "P2 · normal" }, { value: "P3", label: "P3 · when free" }]} value={prio} onChange={setPrio} />
            </Field>
            <Field label="Source" htmlFor="nwo-source">
              <Select id="nwo-source" options={[{ value: "web", label: "Web" }, { value: "console", label: "Console" }, { value: "slack", label: "Slack message" }, { value: "github", label: "GitHub issue" }]} value={source} onChange={setSource} />
            </Field>
          </div>
          <div className="nwo-preview" aria-live="polite">
            {preview ? (
              <>
                <div className="nwo-cls-preview">
                  <span className="muted small">Classifier preview:</span>
                  <ClassChip cls={classOf(cat, fullProject, preview.cls)} />
                  <span className="mono small">{`${Math.round(preview.confidence * 100)}%`}</span>
                  <span className="small">{preview.rationale}</span>
                </div>
                <p className="small muted">{`Route: ${routeOf(cat, fullProject, preview.cls).map((s) => cat.stations.find((x) => x.id === s)?.name ?? s).join(" → ")}`}</p>
              </>
            ) : (
              <p className="muted small">The Intake classifier previews the class as you type.</p>
            )}
          </div>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: busy ? "Submitting…" : "Submit work order", kind: "primary", submit: true, id: "nwo-submit", guard: block ? { allowed: false, reason: block.reason, needs: block.needs } : null, onClick: () => void submit() }]}
    />
  );
}

/** Opens the New work order dialog. */
export function useNewWorkOrder(): (preset?: NewWoPreset) => void {
  const ui = useUI();
  const me = useMe();
  return (preset = {}) => {
    if (!me?.projects.some((p) => p.status !== "archived")) {
      ui.toast("You have no projects to submit work to.", "warn");
      return;
    }
    ui.open((close) => <NewWorkOrderDialog preset={preset} onClose={close} />);
  };
}

/** Makes "Submit a work order" available in the palette and on Home: registered once for the signed-in shell. */
export function useRegisterNewWorkOrder(): void {
  const open = useNewWorkOrder();
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => registerCommand("newWorkOrder", () => ref.current()), []);
}
