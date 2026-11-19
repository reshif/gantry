/** The New work order dialog body. Loaded on first open by New.tsx. */
import { useEffect, useRef, useState } from "react";
import { classify, route as routeOf, type Project } from "@gantry/domain";
import { useCanMany } from "../../api/can";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { useProjectRepos } from "../floor/kit";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { Field, Select } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject, usePrefs } from "../../lib/prefs";
import { ClassChip, classOf, useCatalog } from "../projects/kit";
import { ClassificationCard } from "./intake";
import { ready, submitBlock, type NewWoPreset } from "./New";

/** The Class select's default: no requested class is sent, the Intake agent classifies. */
const AUTO_CLASS = "__auto";

export function NewWorkOrderDialog({ preset, onClose }: { preset: NewWoPreset; onClose: () => void }) {
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const prefs = usePrefs();
  // every project is listed (an archived or stopped one is refused with its reason, like the server does)
  const projects = me?.projects ?? [];
  const [projectId, setProjectId] = useState<string>(preset.project && projects.some((p) => p.id === preset.project) ? preset.project : (projects.find((p) => p.id === prefs.project)?.id ?? projects[0]?.id ?? ""));
  const repos = useProjectRepos(projectId);
  const [repoId, setRepoId] = useState<string | null>(preset.repo ?? null);
  const [title, setTitle] = useState(preset.title ?? "");
  const [desc, setDesc] = useState(preset.description ?? "");
  const [att, setAtt] = useState("");
  // Class opens on "Let Intake classify" and sends no requested class until the person picks one; priority opens on P2 but only a picked one is sent. Untouched, the Intake agent classifies and the class sets the priority.
  const [cls, setCls] = useState("");
  const [prio, setPrio] = useState("");
  const [source] = useState(preset.source ?? "web");
  const [err, setErr] = useState("");
  const [fe, setFe] = useState<{ title?: string; desc?: string }>({});
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
  useEffect(() => { if (title.trim().length >= 6) setFe((f) => (f.title ? { ...f, title: undefined } : f)); }, [title]);
  useEffect(() => { if (desc.trim().length >= 15) setFe((f) => (f.desc ? { ...f, desc: undefined } : f)); }, [desc]);
  if (!me || !cat || !project) return null;
  const decision = can[projects.indexOf(project)];
  const block = decision && !decision.allowed && !decision.pending ? { reason: decision.reason, needs: decision.needs, onboarding: false } : (() => { const b = submitBlock(me, project, repos, repo); return b ? { reason: b.reason, needs: "", onboarding: b.onboarding } : null; })();
  // /me may list projects as summaries without a flow: the preview then reads the catalogue (a missing flow must never crash the sheet)
  const asFull = project as unknown as Project;
  const fullProject = asFull.flow ? asFull : null;
  // the prototype's class list is the whole catalogue
  const classes = cat.classes.filter((c) => c.enabled !== false);
  const clsShown = cls || AUTO_CLASS;
  const text = `${title} ${desc}`.trim();
  const preview = text.length >= 6 ? classify(cat, text, cls || null, fullProject) : null;
  const submit = async () => {
    if (busy) return;
    // field messages first, in the prototype's words, and focus goes to the first invalid field
    const f: { title?: string; desc?: string } = {};
    if (!title.trim()) f.title = "Title is required.";
    else if (title.trim().length < 6) f.title = "Title needs at least 6 characters.";
    if (!desc.trim()) f.desc = "What should change and why is required.";
    else if (desc.trim().length < 15) f.desc = "What should change and why needs at least 15 characters.";
    setFe(f);
    if (f.title || f.desc) {
      setErr("");
      document.getElementById(f.title ? "nwo-title" : "nwo-desc")?.focus();
      return;
    }
    if (block) {
      setErr(block.reason);
      return;
    }
    if (!repo) {
      setErr(`Pick a repo in ${project.name}.`);
      return;
    }
    const r = await send.run(
      { project: projectId, repo, title: title.trim(), description: desc.trim(), priority: prio || undefined, requestedCls: cls || undefined, attachments: att.split(",").map((s) => s.trim()).filter(Boolean), source },
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
    if (id) {
      ui.toast(`${id} submitted to Intake`, "ok");
      ui.open((close) => <ClassificationCard woId={id} onClose={close} />);
    } else ui.toast(r.msg, "ok");
  };
  return (
    <Dialog
      title="Submit a work order"
      dirty={!!(title.trim() || desc.trim())}
      onClose={onClose}
      body={
        <div className="form-grid">
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
          <Field label="Title (required)" htmlFor="nwo-title" hint="A short, specific request." error={fe.title}>
            <input id="nwo-title" className="input" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="What should change and why (required)" htmlFor="nwo-desc" error={fe.desc}>
            <textarea id="nwo-desc" className="input" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label="Project" htmlFor="nwo-project">
            <Select id="nwo-project" options={projects.map((p, i) => ({ value: p.id, label: p.name + (can[i]?.allowed === false && !can[i]?.pending ? " (not permitted)" : "") }))} value={projectId} onChange={(v) => { setProjectId(v); setRepoId(null); }} />
          </Field>
          <Field label="Class" htmlFor="nwo-cls" hint="Pick a class to ask for it, or leave it on Let Intake classify. The preview below is Intake's suggestion.">
            <Select id="nwo-cls" options={[{ value: AUTO_CLASS, label: "Let Intake classify" }, ...classes.map((c) => ({ value: c.id, label: c.name }))]} value={clsShown} onChange={(v) => setCls(v === AUTO_CLASS ? "" : v)} />
          </Field>
          <Field label="Priority" htmlFor="nwo-prio">
            <Select id="nwo-prio" options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))} value={prio || "P2"} onChange={setPrio} />
          </Field>
          {/* the classifier preview shows as soon as there is text; attachments sit behind a closed disclosure so the sheet reads as the prototype's */}
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

          <details className="nwo-more" id="nwo-more">
            <summary className="small muted">Add attachments</summary>
            <Field label="Attachments" htmlFor="nwo-att" hint="File names, comma separated.">
              <input id="nwo-att" className="input" autoComplete="off" value={att} onChange={(e) => setAtt(e.target.value)} />
            </Field>
          </details>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel", kind: "default" }, { label: busy ? "Submitting…" : "Submit work order", kind: "primary", submit: true, id: "nwo-submit", guard: block ? { allowed: false, reason: block.reason, needs: block.needs } : null, onClick: () => void submit() }]}
    />
  );
}
