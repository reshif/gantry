/**
 * Draft a proposal from a finding (legacy draftDialog). The fields change with the kind of change; "Fill in from finding" writes a plain starting text from the finding
 * (there is no model call here, so "Draft with Claude" is not offered). Every draft declares its metric and window before anything is applied (spec 13.4).
 */
import { useState } from "react";
import { flowOf, type LearningFinding } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useAgents, useProjects, useSkills, useSuites } from "../../api/queries";
import { Btn, Field, LockNote, Select } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { useCatalog } from "../projects/kit";
import { KINDS, SIGNALS, WordDiff, useLn } from "./kit";

const DEFAULT_KIND: Record<string, string> = { rejection: "skill", sendback: "guardrail", revert: "guideline", incident: "approver", override: "eval", miss: "skill", regression: "eval" };

interface D {
  kind: string; title: string; expected: string; skill: string; after: string; suite: string; caseName: string; project: string; text: string; required: boolean;
  agent: string; path: string; gate: string; condText: string; condPath: string; condRole: string; cls: string; skip: string; target: string; window: string;
}

export function DraftDialog({ f, close, onDrafted }: { f: LearningFinding; close: () => void; onDrafted?: (id: string) => void }) {
  const ui = useUI();
  const { projName, agName } = useLn();
  const perm = dec(useCan("learning.apply", f.project ? { project: f.project } : {}));
  const skills = useSkills().data ?? [];
  const suites = useSuites().data ?? [];
  const agents = useAgents().data ?? [];
  const projects = (useProjects().data ?? []).filter((p) => p.status !== "archived");
  const cat = useCatalog();
  const ag = agents.find((a) => a.id === f.agent);
  const skillBody = (id: string): string => skills.find((s) => s.id === id)?.body ?? "";
  const [d, setD] = useState<D>(() => {
    const skill = ag?.skills[0] ?? skills[0]?.id ?? "";
    return {
      kind: DEFAULT_KIND[f.signal] ?? "skill", title: "", expected: "", skill, after: skillBody(skill), suite: ag?.suite ?? suites[0]?.id ?? "", caseName: "", project: f.project ?? projects[0]?.id ?? "", text: "", required: true,
      agent: f.agent || "ag-build", path: "", gate: "", condText: "", condPath: "", condRole: "reviewer", cls: "", skip: "", target: String(Math.max(0, Math.floor(f.count / 2))), window: "14",
    };
  });
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const set = (patch: Partial<D>): void => setD((x) => ({ ...x, ...patch }));
  const off = !perm.allowed;
  const proj = projects.find((p) => p.id === d.project);
  const flow = cat && proj ? flowOf(cat, proj) : null;
  const gates = flow ? flow.gates.filter((g) => g.enabled && g.mode !== "auto") : [];
  const gate = gates.some((g) => g.id === d.gate) ? d.gate : gates[0]?.id ?? "";
  const roles = (cat?.roles ?? []).filter((r) => r.level === "project" && (!r.custom || !(r as { project?: string }).project || (r as { project?: string }).project === d.project));
  const classes = flow?.classes ?? [];
  const cls = classes.some((c) => c.id === d.cls) ? d.cls : classes[0]?.id ?? "";
  // A route change may not skip a station a person's gate follows, nor intake, verify, review or close: only offer what the server accepts.
  const skippable = (flow?.stations ?? []).filter((s) => !["intake", "verify", "review", "close"].includes(s.id) && !(flow?.gates ?? []).some((g) => g.after === s.id && g.mode !== "auto"));
  const skip = skippable.some((s) => s.id === d.skip) ? d.skip : skippable[0]?.id ?? "";
  const kinds = Object.keys(KINDS).map((k) => ({ value: k, label: KINDS[k]!.name }));
  const sig = (SIGNALS[f.signal] ?? [f.signal])[0]!.toLowerCase();

  const input = (id: string, key: keyof D, ph?: string, rows?: number, mono = false) => {
    const common = { id, className: `input${mono ? " mono" : ""}`, placeholder: ph ?? "", value: String(d[key] ?? ""), disabled: off, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ [key]: e.target.value } as Partial<D>) };
    return rows ? <textarea {...common} rows={rows} /> : <input {...common} />;
  };

  const changeObj = (): Record<string, unknown> => {
    if (d.kind === "skill") return { skill: d.skill, after: d.after };
    if (d.kind === "eval") return { suite: d.suite, case: { name: d.caseName || d.title } };
    if (d.kind === "guideline") return { project: d.project, item: { text: d.text.trim(), required: !!d.required } };
    if (d.kind === "guardrail") return { agent: d.agent, path: d.path.trim() };
    if (d.kind === "approver") return { project: d.project, gate, condition: { when: { type: "path", value: d.condPath.trim() }, needs: { roles: [d.condRole], people: [], oncall: false }, text: d.condText || `Changes under ${d.condPath} need ${roles.find((r) => r.id === d.condRole)?.name ?? d.condRole}` } };
    return { project: d.project, cls, addSkip: skip };
  };
  const validate = (): string | null => {
    if (!d.title.trim()) return "Give the proposal a title.";
    if (d.kind === "skill" && d.after.trim() === skillBody(d.skill).trim()) return "Change the skill text.";
    if (d.kind === "guideline" && d.text.trim().length < 6) return "Write the guideline.";
    if (d.kind === "guardrail" && !d.path.trim()) return "Name the path.";
    if (d.kind === "approver" && (!gate || !d.condPath.trim())) return "Pick a gate and a path.";
    if (d.kind === "route" && (!cls || !skip)) return "Pick a class and a station.";
    const t = Number(d.target);
    const w = Number(d.window);
    if (!Number.isInteger(t) || t < 0) return "State the target: how many signals at most.";
    if (!Number.isInteger(w) || w < 1 || w > 90) return "State the window in days, from 1 to 90.";
    return null;
  };
  /** A plain starting text from the finding, for the person to edit. */
  const fill = (): void => {
    const lower = f.title.replace(/^[A-Z]/, (c) => c.toLowerCase());
    const sk = skills.find((s) => s.id === d.skill);
    const patch: Partial<D> = { expected: `Fewer ${sig} signals like ${f.id} (${f.count} in the window).` };
    if (d.kind === "skill") { patch.title = `${sk?.name ?? "Skill"}: address ${lower}`; patch.after = `${skillBody(d.skill).replace(/\s*$/, "")} Check for this before finishing: ${lower}.`; }
    else if (d.kind === "eval") { patch.title = `Eval case for ${lower}`; patch.caseName = f.title; }
    else if (d.kind === "guideline") { patch.title = `${projName(d.project)} guideline: ${lower}`; patch.text = `Repos must cover this before work starts: ${lower}.`; }
    else if (d.kind === "guardrail") { patch.title = `${agName(d.agent)} guardrail from ${f.id}`; patch.path = d.path || ".github/workflows/**"; }
    else if (d.kind === "approver") { patch.title = `${projName(d.project)}: second approver for ${lower}`; patch.condText = `Changes like ${f.id} need a ${roles.find((r) => r.id === d.condRole)?.name ?? "Reviewer"}`; }
    else patch.title = `Route change from ${f.id}`;
    set(patch);
    setNote(`Filled in from ${f.id}. Review every field before saving.`);
  };
  const submit = async () => {
    const v = validate();
    if (v) return setErr(v);
    const r = await ops.draftLearning(f.id, { kind: d.kind, title: d.title.trim(), change: changeObj(), expected: d.expected.trim(), metric: { target: Number(d.target) }, windowDays: Number(d.window) });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    onDrafted?.((r as unknown as { proposal: { id: string } }).proposal.id);
    close();
  };

  return (
    <Dialog title={`Draft a proposal from ${f.id}`} kicker={`Learning · ${f.title}`} wide onClose={close}
      sub={`Evidence: ${f.count} ${sig} signals. A draft is only a proposal; accepting it later applies the change.`}
      actions={[{ label: "Cancel" }, { label: "Save draft", kind: "primary", submit: true, id: "ln-d-ok", guard: perm, onClick: () => void submit() }]}
      body={(
        <div className="ln-draft">
          <div className="ln-askbar">
            <span className="ln-askbtn"><Btn label="Fill in from finding" small icon="sparkle" id="ln-d-local" guard={perm} onClick={fill} /></span>
            <div className="ln-stream small" id="ln-draft-stream" aria-live="polite">{note}</div>
          </div>
          <div className="form-grid" id="ln-draft-form">
            <LockNote decision={perm} what="Drafting proposals" />
            <div className="form-row">
              <Field label="Kind of change" htmlFor="ln-d-kind"><Select id="ln-d-kind" options={kinds} value={d.kind} disabled={off} onChange={(v) => set({ kind: v })} /></Field>
              <Field label="Title" htmlFor="ln-d-title">{input("ln-d-title", "title", "What the change does")}</Field>
            </div>
            {d.kind === "skill" ? (
              <>
                <Field label="Skill" htmlFor="ln-d-skill"><Select id="ln-d-skill" options={skills.map((s) => ({ value: s.id, label: `${s.name} v${s.version}` }))} value={d.skill} disabled={off} onChange={(v) => set({ skill: v, after: skillBody(v) })} /></Field>
                <Field label="New skill text" htmlFor="ln-d-after" hint="Accepting saves this as the next version of the skill.">{input("ln-d-after", "after", "", 4, true)}</Field>
                <WordDiff a={skillBody(d.skill)} b={d.after} />
              </>
            ) : null}
            {d.kind === "eval" ? (
              <div className="form-row">
                <Field label="Suite" htmlFor="ln-d-suite"><Select id="ln-d-suite" options={suites.map((s) => ({ value: s.id, label: `${s.id} · ${s.name}` }))} value={d.suite} disabled={off} onChange={(v) => set({ suite: v })} /></Field>
                <Field label="Case name" htmlFor="ln-d-case">{input("ln-d-case", "caseName", "e.g. Regression described as a feature")}</Field>
              </div>
            ) : null}
            {d.kind === "guideline" ? (
              <>
                <Field label="Project" htmlFor="ln-d-proj"><Select id="ln-d-proj" options={projects.map((x) => ({ value: x.id, label: x.name }))} value={d.project} disabled={off} onChange={(v) => set({ project: v })} /></Field>
                <Field label="Guideline text" htmlFor="ln-d-text">{input("ln-d-text", "text", "What every repo must have", 2)}</Field>
                <label className="check" htmlFor="ln-d-req"><input type="checkbox" id="ln-d-req" checked={d.required} disabled={off} onChange={(e) => set({ required: e.target.checked })} />Required for Ready</label>
              </>
            ) : null}
            {d.kind === "guardrail" ? (
              <div className="form-row">
                <Field label="Agent" htmlFor="ln-d-agent"><Select id="ln-d-agent" options={agents.map((a) => ({ value: a.id, label: a.name }))} value={d.agent} disabled={off} onChange={(v) => set({ agent: v })} /></Field>
                <Field label="Path it must not touch" htmlFor="ln-d-path">{input("ln-d-path", "path", "e.g. infra/prod/**")}</Field>
              </div>
            ) : null}
            {d.kind === "approver" ? (
              <>
                <div className="form-row">
                  <Field label="Project" htmlFor="ln-d-proj"><Select id="ln-d-proj" options={projects.map((x) => ({ value: x.id, label: x.name }))} value={d.project} disabled={off} onChange={(v) => set({ project: v })} /></Field>
                  <Field label="Gate" htmlFor="ln-d-gate"><Select id="ln-d-gate" options={gates.map((g) => ({ value: g.id, label: `${g.label} ${g.name}` }))} value={gate} disabled={off} onChange={(v) => set({ gate: v })} /></Field>
                </div>
                <div className="form-row">
                  <Field label="When the change touches path" htmlFor="ln-d-cpath">{input("ln-d-cpath", "condPath", "e.g. ingest/")}</Field>
                  <Field label="Also needs" htmlFor="ln-d-role"><Select id="ln-d-role" options={roles.map((r) => ({ value: r.id, label: r.name }))} value={d.condRole} disabled={off} onChange={(v) => set({ condRole: v })} /></Field>
                </div>
                <Field label="Condition in words" htmlFor="ln-d-ctext">{input("ln-d-ctext", "condText", "e.g. Ingest changes need a Reviewer")}</Field>
              </>
            ) : null}
            {d.kind === "route" ? (
              <div className="form-row">
                <Field label="Project" htmlFor="ln-d-proj"><Select id="ln-d-proj" options={projects.map((x) => ({ value: x.id, label: x.name }))} value={d.project} disabled={off} onChange={(v) => set({ project: v })} /></Field>
                <Field label="Class" htmlFor="ln-d-cls"><Select id="ln-d-cls" options={classes.map((c) => ({ value: c.id, label: c.name }))} value={cls} disabled={off} onChange={(v) => set({ cls: v })} /></Field>
                <Field label="Skip station" htmlFor="ln-d-skip" hint="Only stations that no gate decided by a person follows."><Select id="ln-d-skip" options={skippable.map((s) => ({ value: s.id, label: `${s.no ?? ""} ${s.name}`.trim() }))} value={skip} disabled={off} onChange={(v) => set({ skip: v })} /></Field>
              </div>
            ) : null}
            <Field label="Expected effect" htmlFor="ln-d-exp">{input("ln-d-exp", "expected", "What should change, and how you will know", 2)}</Field>
            <div className="form-row">
              <Field label={`At most this many ${sig} signals`} htmlFor="ln-d-metric" hint="The metric, stated before the change. Verified means the count stayed at or under it.">
                <input id="ln-d-metric" className="input mono" type="number" min="0" step="1" value={d.target} disabled={off} onChange={(e) => set({ target: e.target.value })} />
              </Field>
              <Field label="In the days after it is applied" htmlFor="ln-d-window" hint="The window, stated before the change.">
                <input id="ln-d-window" className="input mono" type="number" min="1" max="90" step="1" value={d.window} disabled={off} onChange={(e) => set({ window: e.target.value })} />
              </Field>
            </div>
            <div className="form-err" role="alert">{err}</div>
          </div>
        </div>
      )} />
  );
}
