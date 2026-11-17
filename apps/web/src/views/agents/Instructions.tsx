/** Instructions tab (legacy instructionsTab and textDialog): the four layers in order with their edit dialogs, and the effective text exactly as a run would receive it. */
import { useState } from "react";
import { fmt, type Repo } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useAgentEffective, useInstructions, useRepos, useSkills } from "../../api/queries";
import { invalidateSlices } from "../../api/keys";
import { ops } from "../../api/ops";
import { Btn, Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { BindingsPanel } from "./Bindings";
import { agentLayer, rerender, ui, words } from "./kit";
import type { TabProps } from "./Config";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

interface TextOpts {
  title: string;
  kicker: string;
  sub?: string;
  label: string;
  text: string;
  guard: Decision;
  what: string;
  ok?: string;
  note?: boolean;
  save: (text: string, note: string) => Promise<{ ok: boolean; msg: string }>;
}

export function TextDialog({ o, close }: { o: TextOpts; close: () => void }) {
  const ui_ = useUI();
  const [text, setText] = useState(o.text);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const ro = !o.guard.allowed;
  return (
    <Dialog
      title={o.title} kicker={o.kicker} sub={o.sub} wide onClose={close}
      body={(
        <div className="form-grid">
          <LockNote decision={o.guard} what={o.what} />
          <Field label={o.label} htmlFor="ag-txt-edit"><textarea id="ag-txt-edit" className="input mono" rows={8} value={text} disabled={ro} onChange={(e) => setText(e.target.value)} /></Field>
          {o.note ? <Field label="Change note" htmlFor="ag-txt-note"><input id="ag-txt-note" className="input" placeholder="What changed?" value={note} disabled={ro} onChange={(e) => setNote(e.target.value)} /></Field> : null}
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[
        { label: "Cancel" },
        {
          label: o.ok ?? "Save", kind: "primary", submit: true, id: "ag-txt-ok", guard: o.guard,
          onClick: (done) => {
            void o.save(text, note.trim()).then((r) => {
              if (!r.ok) { setErr(r.msg); return; }
              ui_.toast(r.msg, "ok");
              done();
            });
          },
        },
      ]}
    />
  );
}

export function InstructionsTab({ a, d, projects, ro, edit }: TabProps) {
  const ui_ = useUI();
  const base = useInstructions().data;
  const skills = useSkills().data ?? [];
  const live = projects.filter((p) => p.status !== "archived");
  if (!ui.ctxProject || !live.some((p) => p.id === ui.ctxProject)) ui.ctxProject = live[0]?.id ?? null;
  const project = live.find((p) => p.id === ui.ctxProject) ?? null;
  const repos = (useRepos(project?.id).data ?? []) as Repo[];
  if (ui.ctxRepo && !repos.some((r) => r.id === ui.ctxRepo)) ui.ctxRepo = null;
  if (!ui.ctxRepo && repos[0]) ui.ctxRepo = repos[0].id;
  const repo = repos.find((r) => r.id === ui.ctxRepo) ?? null;
  const eff = useAgentEffective(a.id, { ...(project ? { project: project.id } : {}), ...(repo ? { repo: repo.id } : {}), version: "draft" }).data;
  const baseGuard = dec(useCan("agent.edit"));
  const ovCan = dec(useCan("project.config", { project: project?.id ?? null }));
  const repoCan = dec(useCan("repo.onboard", { project: repo?.project ?? null }));
  const ovGuard = project ? ovCan : { allowed: false, reason: "Pick a project.", needs: "" };
  const repoGuard = repo ? repoCan : { allowed: false, reason: "Pick a repo.", needs: "" };

  const layerText = (key: string): string => eff?.layers.find((l) => l.key === key)?.text ?? "";
  const baseV = eff?.layers.find((l) => l.key === "base")?.version ?? base?.baseVersion ?? 0;
  /** What the agent receives: the server's layers, with this draft's own text in layer 3 (legacy effectiveText). */
  const text = (() => {
    if (!eff) return "Composing the effective instructions…";
    const parts: string[] = [`# 1 Factory base (v${baseV})\n${layerText("base")}`];
    if (project) parts.push(`# 2 Project overlay: ${project.name}\n${layerText("project") || "(none)"}`);
    parts.push(agentLayer(a, d, project));
    if (d.skills.length) {
      parts.push(`## Skills, in order\n${d.skills.map((id, i) => { const sk = skills.find((x) => x.id === id); return `${i + 1}. ${sk ? `${sk.name} v${sk.version}: ${sk.when}` : id}`; }).join("\n")}`);
    }
    if (repo) parts.push(`# 4 Repo guidelines: ${repo.name}\n${layerText("repo") || "(none)"}`);
    return parts.join("\n\n");
  })();
  const count = eff ? `${words(text)} words, about ${fmt.k(Math.round(text.length / 4))} tokens` : "";
  const repoLayer = eff?.layers.find((l) => l.key === "repo");

  const layer = (no: number, title: string, meta: string, body: React.ReactNode, action?: React.ReactNode) => (
    <li className="ag-layer">
      <div className="ag-layer-head">
        <span className="ag-layer-no mono">{no}</span><strong>{title}</strong><span className="muted small">{meta}</span>
        {action ? <span className="ag-layer-act">{action}</span> : null}
      </div>
      {body}
    </li>
  );
  const refreshed = <T extends { ok: boolean }>(r: T): T => { if (r.ok) invalidateSlices(["agents"]); return r; };

  return (
    <div className="ag-instr-grid">
      <section className="cfg-sec">
        <h3 className="cfg-h">Layers, applied in order</h3>
        <p className="muted small">Later layers add to earlier ones. A repo&apos;s guidelines never override the factory base.</p>
        <ol className="ag-layers">
          {layer(1, "Factory base", `v${base?.baseVersion ?? 0} · applies to every agent`, <p className="ag-layer-text">{base?.base}</p>,
            <Btn label="Edit base" small icon="page" id="ag-edit-base" guard={baseGuard} onClick={() => {
              ui_.open((close) => (
                <TextDialog close={close} o={{ title: "Factory base instructions", kicker: "Instructions · layer 1", label: `Base instructions (v${base?.baseVersion ?? 0})`, text: base?.base ?? "", guard: baseGuard, what: "Factory base instructions",
                  sub: `Every agent receives these first. Saving creates v${(base?.baseVersion ?? 0) + 1}.`,
                  save: async (v) => {
                    if (!v.trim()) return { ok: false, msg: "Base instructions cannot be empty." };
                    return refreshed(await ops.saveInstructions(v, { ifMatch: base?.baseVersion ?? 0 }));
                  } }} />
              ));
            }} />)}
          {layer(2, "Project overlay", project ? project.name + (project.regulated ? " · regulated" : "") : "no project",
            <div>
              <Field label="Preview for project" htmlFor="ag-ctx-project">
                <Select id="ag-ctx-project" value={ui.ctxProject} options={live.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { ui.ctxProject = v; ui.ctxRepo = null; rerender(); }} />
              </Field>
              <p className="ag-layer-text">{project ? (project as { overlay?: string }).overlay || "No overlay for this project." : ""}</p>
            </div>,
            project ? <Btn label="Edit overlay" small icon="page" id="ag-edit-overlay" guard={ovGuard} onClick={() => {
              ui_.open((close) => (
                <TextDialog close={close} o={{ title: `${project.name} overlay`, kicker: "Instructions · layer 2", label: "Overlay text", text: (project as { overlay?: string }).overlay ?? "", guard: ovGuard, what: "Project overlay",
                  sub: `Added after the factory base for every agent working on ${project.name}.`,
                  save: async (v) => refreshed(await ops.setProject(project.id, "overlay", v.trim(), { ifMatch: (project as { version?: number }).version })) }} />
              ));
            }} /> : null)}
          {layer(3, "Agent", `${d.name} · this agent only`, (
            <Field label="Agent instructions" htmlFor="ag-instr" hint="Saved with the agent. Unsaved edits show in the preview.">
              <textarea id="ag-instr" className="input" rows={5} disabled={ro} value={d.instructions || ""} onChange={(e) => edit(() => { d.instructions = e.target.value; })} />
            </Field>
          ))}
          {layer(4, "Repo guidelines", repo ? repo.name : "no repo in this project",
            <div>
              {repos.length ? (
                <Field label="Preview for repo" htmlFor="ag-ctx-repo">
                  <Select id="ag-ctx-repo" value={ui.ctxRepo} options={repos.map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => { ui.ctxRepo = v; rerender(); }} />
                </Field>
              ) : null}
              <pre className="ag-layer-text mono small">{repo ? repo.guidelines || "No AGENTS.md yet." : ""}</pre>
              {repoLayer?.commit ? <div className="small muted mono" id="ag-repo-commit">read at {repoLayer.commit.slice(0, 12)}</div> : null}
            </div>,
            repo ? <Btn label="Edit guidelines" small icon="page" id="ag-edit-guidelines" guard={repoGuard} onClick={() => {
              ui_.open((close) => (
                <TextDialog close={close} o={{ title: `${repo.name} AGENTS.md`, kicker: "Instructions · layer 4", label: "Repo guidelines", text: repo.guidelines, guard: repoGuard, what: "Repo guidelines",
                  save: async (v) => refreshed(await ops.configureRepo(repo.id, { guidelines: v }, { ifMatch: (repo as { version?: number }).version })) }} />
              ));
            }} /> : null)}
        </ol>
      </section>
      <section className="cfg-sec ag-eff-sec">
        <div className="ag-eff-head">
          <h3 className="cfg-h">Effective instructions</h3>
          <span className="mono small muted" id="ag-eff-count">{count}</span>
        </div>
        <p className="muted small">{`Exactly what ${d.name} receives for ${repo ? repo.name : project ? project.name : "this context"}, including skills and guardrails.`}</p>
        <pre className="ag-effective mono" id="ag-effective" tabIndex={0} aria-label="Effective instructions">{text}</pre>
      </section>
      <BindingsPanel />
    </div>
  );
}
