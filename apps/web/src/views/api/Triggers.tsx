/**
 * The Triggers tab (legacy triggersTab, newTriggerDialog, triggerDetail, simulateDialog): triggers open work orders from events on connected source control, issue
 * trackers and CI, and from schedules, through the same intake as a submission. A trigger starts disabled, the organisation has a master switch (Limits tab), and
 * work from a source user who does not map to a person allowed to submit is held as a proposal for a person to release (spec 11.7).
 * Changed from legacy: "Simulate incoming" evaluates the real rules and creates nothing unless asked; "Anyone with repo access" is "Everyone held for a person";
 * rate and budget limits are editable; held proposals have Release and Decline.
 */
import { useState } from "react";
import { classesOf, fmt, type Trigger, type TriggerProposal, type TriggerRun } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useProjects, useRepos, useTriggerProposals } from "../../api/queries";
import { DataTable } from "../../ui/DataTable";
import { Btn, Empty, Field, FilterBar, SearchBox, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useOpenTraveler } from "../../shell/useTraveler";
import { usePrefs } from "../../lib/prefs";
import { useCatalog } from "../projects/kit";
import { useOutcome } from "../govern/data";
import { TTYPES, dec, hookUrl, kindsFor, srcName, srcOptions, srcState, useCanAny, whoOptions, type ApiData } from "./kit";

interface SimResult { outcome: string; msg: string; wo: string; created: boolean; notes: string[]; at: number }
const outcomeClass = (o: string): string => (o === "created" ? "ok" : o === "refused" ? "denied" : "warn");
const outcomeMark = (c: string): string => (c === "ok" ? "✓ " : c === "denied" ? "⊘ " : "◆ ");

function useClassOptions(projectId: string): Array<{ value: string; label: string }> {
  const cat = useCatalog();
  const d = usePrefsProject(projectId);
  return cat && d ? classesOf(cat, d).map((c) => ({ value: c.id, label: c.name })) : [];
}
function usePrefsProject(id: string) {
  return (useProjects().data ?? []).find((p) => p.id === id) ?? null;
}

/* ---------- new trigger ---------- */

export function NewTrigger({ d, close, onCreated }: { d: ApiData; close: () => void; onCreated: (id: string) => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const [project, setProject] = useState(() => (prefs.project && d.visIds.includes(prefs.project) ? prefs.project : d.vis[0]?.id ?? ""));
  const [type, setType] = useState("issue");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [err, setErr] = useState("");
  const perm = dec(useCan("triggers.edit", { project }));
  const classes = useClassOptions(project).map((c) => c.value);
  const opts = srcOptions(project, null, null, d);
  const src = opts.some((o) => o.value === source) ? source : opts[0]?.value ?? "";
  const kinds = kindsFor(src, d);
  const ty = kinds.includes(type) ? type : kinds[0]!;
  const inst = d.insts.find((i) => i.id === src);
  const go = async () => {
    if (!name.trim()) { setErr("Name the trigger."); return; }
    if (!src) { setErr("Pick a source. Connect one in Integrations first."); return; }
    const base: Record<string, unknown> = { project, type: ty, name: name.trim(), source: src };
    if (ty === "schedule") Object.assign(base, { cls: classes.includes("chore") ? "chore" : classes[0] });
    if (ty === "ci") Object.assign(base, { cls: classes.includes("hotfix") ? "hotfix" : classes[0] });
    const r = await ops.saveTrigger(null, base);
    if (!r.ok) { setErr(r.msg); return; }
    ui.toast(`${r.msg.replace(/ It starts disabled.*$/, "")} It starts disabled; review it, then turn it on.`, "ok");
    onCreated((r as unknown as { trigger: { id: string } }).trigger.id);
    close();
  };
  return (
    <Dialog
      title="New trigger" kicker="API & triggers" onClose={close}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what={`Triggers on ${d.pname(project)}`} />
          <Field label="Project" htmlFor="api-tr-new-project"><Select id="api-tr-new-project" options={d.vis.map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={(v) => { setProject(v); setSource(""); }} /></Field>
          <Field label="Source" htmlFor="api-tr-new-source" hint="Connected source-control, issue-tracker, CI and custom source connections open to this project. Add more in Integrations.">
            <Select id="api-tr-new-source" options={opts} value={src} onChange={setSource} />
          </Field>
          <Field label="Type" htmlFor="api-tr-new-type"><Select id="api-tr-new-type" options={kinds.map((k) => ({ value: k, label: TTYPES[k]?.name ?? k }))} value={ty} onChange={setType} /></Field>
          {inst && srcState(inst.id, d) !== "healthy" ? <div className="callout callout-warn"><Icon name="alert" /><span>{`${inst.name} is ${srcState(inst.id, d)}. The trigger saves, but events from it will not arrive until it is healthy.`}</span></div> : null}
          <Field label="Name" htmlFor="api-tr-new-name"><input id="api-tr-new-name" className="input" value={name} placeholder="Issues labelled factory" onChange={(e) => setName(e.target.value)} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Create trigger", kind: "primary", submit: true, id: "api-tr-new-go", guard: perm, onClick: () => void go() }]}
    />
  );
}

/* ---------- simulate incoming ---------- */

function Simulate({ t, d, close, onResult }: { t: Trigger; d: ApiData; close: () => void; onResult: (r: SimResult) => void }) {
  const ui = useUI();
  const perm = dec(useCan("triggers.edit", { project: t.project }));
  const repos = useRepos(t.project).data ?? [];
  const [st, setSt] = useState({
    repo: (repos.find((r) => r.onboarding?.stage === "ready") ?? repos[0])?.id ?? "",
    title: t.type === "issue" ? "Refund endpoint returns 500 for partial refunds" : t.type === "comment" ? "Fix flaky ledger reconciliation test" : t.type === "ci" ? "Main is red: fix failing ci/test" : t.title || "Weekly dependency updates",
    labels: t.type === "issue" ? `${t.label ?? ""}, bug` : "", author: "", comment: `${t.command || "/factory fix"} the flaky reconciliation test`, create: false,
  });
  const [err, setErr] = useState("");
  const repo = repos.some((r) => r.id === st.repo) ? st.repo : repos[0]?.id ?? "";
  const set = (k: keyof typeof st) => (v: string | boolean) => setSt((x) => ({ ...x, [k]: v }));
  const what = t.type === "issue" ? "issue" : t.type === "comment" ? "PR comment" : t.type === "ci" ? "check failure on main" : "schedule tick";
  const go = async () => {
    if (t.type === "comment" && !st.comment.trim().startsWith(t.command ?? "")) { setErr(`The comment must start with ${t.command} or the trigger ignores it.`); return; }
    const input: Record<string, unknown> = { ...(t.type === "schedule" ? {} : { repo }), ...(st.title.trim() ? { title: st.title.trim() } : {}), create: st.create };
    if (t.type === "issue") input.labels = st.labels.split(",").map((x) => x.trim()).filter(Boolean);
    if (t.type === "issue" || t.type === "comment") input.author = st.author.trim();
    if (t.type === "comment") input.comment = st.comment;
    if (t.type === "ci") input.check = st.title.trim();
    const r = await ops.simulateTrigger(t.id, input);
    if (!r.ok) { setErr(r.msg); return; }
    const x = r as unknown as { run: { outcome: string; wo: string }; created: boolean; notes: string[] };
    onResult({ outcome: x.run.outcome, msg: r.msg, wo: x.run.wo, created: x.created, notes: x.notes ?? [], at: Date.now() });
    ui.toast(x.created ? `Created ${x.run.wo}.` : x.run.outcome === "created" ? "Would create a work order. Nothing was created." : r.msg, x.run.outcome === "created" ? "ok" : "warn");
    close();
  };
  return (
    <Dialog
      title={`Simulate: ${t.name}`} kicker={`${TTYPES[t.type]?.name ?? t.type} · ${srcName(t.source, d)}`} onClose={close}
      sub={`Sends a sample ${what} through this trigger's real rules. Nothing is sent to ${srcName(t.source, d)}, and nothing is created unless you ask.`}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what={`Triggers on ${d.pname(t.project)}`} />
          {t.type !== "schedule" ? <Field label="Repo" htmlFor="api-sim-repo"><Select id="api-sim-repo" options={repos.map((r) => ({ value: r.id, label: r.name + (r.onboarding?.stage === "ready" ? "" : " (not ready)") }))} value={repo} onChange={set("repo") as (v: string) => void} /></Field> : null}
          <Field label={t.type === "comment" ? "Work order title" : t.type === "schedule" ? "Title of the scheduled work" : t.type === "ci" ? "Failing check" : "Issue title"} htmlFor="api-sim-title"><input id="api-sim-title" className="input" value={st.title} onChange={(e) => set("title")(e.target.value)} /></Field>
          {t.type === "issue" ? <Field label="Labels" htmlFor="api-sim-labels" hint={`Comma separated. The trigger fires on '${t.label}'; other labels map to a class.`}><input id="api-sim-labels" className="input mono" value={st.labels} onChange={(e) => set("labels")(e.target.value)} /></Field> : null}
          {t.type === "comment" ? <Field label="Comment" htmlFor="api-sim-comment"><input id="api-sim-comment" className="input mono" value={st.comment} onChange={(e) => set("comment")(e.target.value)} /></Field> : null}
          {t.type === "issue" || t.type === "comment" ? <Field label="Author" htmlFor="api-sim-author" hint={`The ${srcName(t.source, d)} login. It must map to a Gantry person allowed to submit here, or the work is held as a proposal.`}><input id="api-sim-author" className="input mono" value={st.author} placeholder="octocat" onChange={(e) => set("author")(e.target.value)} /></Field> : null}
          <label className="check" htmlFor="api-sim-create">
            <input type="checkbox" id="api-sim-create" checked={st.create} onChange={(e) => set("create")(e.target.checked)} />
            <span>Also create it (a real work order or proposal, through the same path). Needs the trigger and the organisation switch to be on.</span>
          </label>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Simulate incoming", kind: "primary", submit: true, id: "api-sim-go", guard: perm, onClick: () => void go() }]}
    />
  );
}

/* ---------- held proposals ---------- */

function Proposals({ t }: { t: Trigger }) {
  const ui = useUI();
  const out = useOutcome();
  const q = useTriggerProposals("held");
  const perm = dec(useCan("wo.submit", { project: t.project }));
  const openTraveler = useOpenTraveler();
  const mine = (q.data ?? []).filter((p: TriggerProposal) => p.trigger === t.id);
  if (!mine.length) return null;
  const decline = (p: TriggerProposal) =>
    ui.reasonDialog({ title: `Decline ${p.title}?`, kicker: `Held proposal ${p.id}`, label: "Reason", ok: "Decline", kind: "danger", min: 5, guard: perm, onOk: async (reason) => { const r = await ops.declineProposal(p.id, reason); out(r); return r.ok ? undefined : { ok: false, msg: r.msg }; } });
  return (
    <Panel title="Held for a person">
      <div className="form-grid" id="api-tr-held">
        <p className="muted small">The source user did not map to a Gantry person allowed to submit here, or this trigger always asks. Nothing starts until a person with the right to submit releases it.</p>
        <LockNote decision={perm} what="Releasing work" />
        <ul className="plain-list">
          {mine.map((p) => (
            <li key={p.id} className="api-held">
              <div><strong>{p.title}</strong><div className="small muted">{`${p.source}${p.actor ? ` · ${p.actor}` : ""} · ${fmt.stamp(p.at)}`}</div><div className="small">{p.reason}</div></div>
              <div className="form-actions">
                <Btn label="Release" kind="primary" small id={`api-tr-rel-${p.id}`} guard={perm} onClick={async () => { const r = out(await ops.releaseProposal(p.id)); const wo = (r as unknown as { wo?: string }).wo; if (r.ok && wo) openTraveler(wo); }} />
                <Btn label="Decline" small kind="ghost" id={`api-tr-dec-${p.id}`} guard={perm} onClick={() => decline(p)} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/* ---------- detail ---------- */

interface Draft { source: string; name: string; label: string; command: string; schedule: string; title: string; cls: string; who: string; reply: string; dedupe: boolean; perHour: string; perDay: string; labelMap: Array<{ label: string; cls: string }> }

function Detail({ t, d, res, setRes }: { t: Trigger; d: ApiData; res: SimResult | undefined; setRes: (r: SimResult) => void }) {
  const ui = useUI();
  const out = useOutcome();
  const openTraveler = useOpenTraveler();
  const perm = dec(useCan("triggers.edit", { project: t.project }));
  const ro = !perm.allowed;
  const clsOpts = useClassOptions(t.project);
  const [x, setX] = useState<Draft>(() => ({
    source: t.source ?? "", name: t.name, label: t.label ?? "", command: t.command ?? "", schedule: t.schedule ?? "", title: t.title ?? "", cls: t.cls ?? "", who: t.who, reply: t.reply, dedupe: t.dedupe,
    perHour: String(t.limits?.perHour ?? 6), perDay: String(t.limits?.perDay ?? 20), labelMap: Object.entries(t.labelMap ?? {}).map(([label, cls]) => ({ label, cls })),
  }));
  const [revertKey, setRevertKey] = useState(0);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setX((p) => ({ ...p, [k]: v }));
  const ver = t.version !== undefined ? { ifMatch: t.version } : undefined;
  const inp = (id: string, k: "name" | "label" | "command" | "schedule" | "title", ph?: string, mono?: boolean) => (
    <input id={id} className={`input${mono ? " mono" : ""}`} value={x[k]} placeholder={ph ?? ""} disabled={ro} onChange={(e) => set(k, e.target.value)} />
  );
  const save = async () => {
    if (!x.name.trim()) { ui.toast("Name the trigger.", "error"); return; }
    if (!x.source) { ui.toast("Pick a source.", "error"); return; }
    const hr = Number(x.perHour), dy = Number(x.perDay);
    if (!(Number.isInteger(hr) && hr >= 1) || !(Number.isInteger(dy) && dy >= 1)) { ui.toast("Limits are whole numbers of at least 1.", "error"); return; }
    const patch: Record<string, unknown> = { name: x.name.trim(), who: x.who, reply: x.reply, dedupe: x.dedupe, source: x.source, limits: { perHour: hr, perDay: dy } };
    if (t.type === "issue") {
      if (!/^[a-z0-9:_ .-]{1,40}$/i.test(x.label.trim())) { ui.toast("Enter the label that fires the trigger.", "error"); return; }
      const lm: Record<string, string> = {};
      for (const m of x.labelMap) { const l = m.label.trim(); if (!l) { ui.toast("Every mapping needs a label.", "error"); return; } lm[l] = m.cls; }
      patch.label = x.label.trim();
      patch.labelMap = lm;
    }
    if (t.type === "comment") { if (!/^\/\S+/.test(x.command.trim())) { ui.toast("Commands start with a slash, like /factory fix.", "error"); return; } patch.command = x.command.trim(); }
    if (t.type === "schedule") { if (!x.schedule.trim()) { ui.toast("Say when the schedule runs.", "error"); return; } patch.schedule = x.schedule.trim(); patch.cls = x.cls || "chore"; patch.title = x.title.trim(); }
    if (t.type === "ci") patch.cls = x.cls || "hotfix";
    out(await ops.saveTrigger(t.id, patch, ver));
  };
  const toggle = async (v: boolean) => { out(await ops.saveTrigger(t.id, { enabled: v }, ver)); };
  const runs = [...t.runs].reverse().slice(0, 8);
  const simWord = t.type === "issue" ? "issue" : t.type === "comment" ? "comment" : t.type === "ci" ? "CI failure" : "schedule tick";
  const shown = res ? (!res.created && res.outcome === "created" ? "would create" : !res.created && res.outcome === "held" ? "would hold" : res.outcome) : "";
  return (
    <div className="api-tdetail" key={revertKey}>
      <Panel title={<span className="api-th"><Icon name={TTYPES[t.type]?.icon ?? "api"} />{t.name}</span>}>
        <div className="form-grid">
          <LockNote decision={perm} what={`Triggers on ${d.pname(t.project)}`} />
          {d.cfg && d.cfg.triggersEnabled !== true ? <div className="callout callout-warn" id="api-tr-master"><Icon name="alert" /><span>Triggers are switched off for the organisation, so no trigger fires. Turn them on under Limits.</span></div> : null}
          <div className="toggle-row api-enabled">
            <span><strong>{t.enabled ? "Enabled" : "Disabled"}</strong>{` · ${TTYPES[t.type]?.name ?? t.type} from ${srcName(t.source, d)} · ${d.pname(t.project)}`}</span>
            <Toggle id="api-tr-enabled" checked={t.enabled} onChange={(v) => void toggle(v)} decision={perm} label="Trigger enabled" />
          </div>
          <Field label="Name" htmlFor="api-tr-name">{inp("api-tr-name", "name")}</Field>
          <Field label="Source" htmlFor="api-tr-source" hint={srcState(x.source, d) !== "healthy" ? `${srcName(x.source, d)} is ${srcState(x.source, d)}: events from it will not arrive.` : hookUrl(x.source, d) ? <>Events arrive when the system posts a signed JSON event to <span className="mono">{hookUrl(x.source, d)}</span> (header X-Gantry-Signature, signed with the connection's secret).</> : "Events arrive from this connection."}>
            <Select id="api-tr-source" options={srcOptions(t.project, x.source, t.type, d)} value={x.source} onChange={(v) => set("source", v)} disabled={ro} />
          </Field>
          {t.type === "issue" ? (
            <>
              <Field label="Label that fires it" htmlFor="api-tr-label">{inp("api-tr-label", "label", "factory", true)}</Field>
              <fieldset className="api-fs">
                <legend className="field-label">Label to class</legend>
                <ul className="api-lmap">
                  {x.labelMap.map((m, i) => (
                    <li key={i}>
                      <input id={`api-tr-lm-l-${i}`} className="input mono" value={m.label} disabled={ro} aria-label="Label" onChange={(e) => set("labelMap", x.labelMap.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                      <span aria-hidden="true">→</span>
                      <Select id={`api-tr-lm-c-${i}`} options={clsOpts} value={m.cls} disabled={ro} aria-label="Class" onChange={(v) => set("labelMap", x.labelMap.map((y, j) => (j === i ? { ...y, cls: v } : y)))} />
                      <Btn label="" small kind="ghost" icon="x" aria={`Remove mapping ${m.label}`} id={`api-tr-lm-rm-${i}`} guard={perm} onClick={() => set("labelMap", x.labelMap.filter((_, j) => j !== i))} />
                    </li>
                  ))}
                </ul>
                <Btn label="Add mapping" small icon="plus" id="api-tr-lm-add" guard={perm} onClick={() => set("labelMap", [...x.labelMap, { label: "", cls: clsOpts.find((c) => c.value === "feature")?.value ?? clsOpts[0]?.value ?? "" }])} />
                <p className="field-hint">Intake still classifies; a mapped label is passed as the requested class.</p>
              </fieldset>
            </>
          ) : null}
          {t.type === "comment" ? <Field label="Command" htmlFor="api-tr-command" hint="Comment on a PR starting with this command opens a work order linked to the PR.">{inp("api-tr-command", "command", "/factory fix", true)}</Field> : null}
          {t.type === "schedule" ? (
            <>
              <div className="form-row">
                <Field label="When" htmlFor="api-tr-schedule" hint={t.nextRun ? `Next run ${fmt.stamp(t.nextRun)}.` : "Like Mon 06:00 IST, Weekdays 09:30 UTC or Daily 06:00."}>{inp("api-tr-schedule", "schedule", "Mon 06:00 IST", true)}</Field>
                <Field label="Class" htmlFor="api-tr-cls"><Select id="api-tr-cls" options={clsOpts} value={x.cls || "chore"} onChange={(v) => set("cls", v)} disabled={ro} /></Field>
              </div>
              <Field label="Work order title" htmlFor="api-tr-title" hint="Each run files a work order with this title.">{inp("api-tr-title", "title", t.name)}</Field>
            </>
          ) : null}
          {t.type === "ci" ? (
            <div className="form-row">
              <Field label="Proposed class" htmlFor="api-tr-cls"><Select id="api-tr-cls" options={clsOpts} value={x.cls || "hotfix"} onChange={(v) => set("cls", v)} disabled={ro} /></Field>
              <p className="field-hint">By default this opens a proposal and asks a person to confirm it before any work starts.</p>
            </div>
          ) : null}
          <Field label={t.type === "issue" || t.type === "comment" ? "Who may trigger" : "Who creates the work"} htmlFor="api-tr-who" hint={t.type === "issue" || t.type === "comment" ? "A source user who does not map to a Gantry person allowed to submit gets a held proposal, never a work order." : undefined}>
            <Select id="api-tr-who" options={whoOptions(t.type)} value={x.who} onChange={(v) => set("who", v)} disabled={ro} />
          </Field>
          <div className="form-row">
            <Field label="Rate limit (per hour)" htmlFor="api-tr-lim-hour"><input id="api-tr-lim-hour" className="input mono" type="number" min="1" value={x.perHour} disabled={ro} onChange={(e) => set("perHour", e.target.value)} /></Field>
            <Field label="Budget (per 24 hours)" htmlFor="api-tr-lim-day" hint="Work orders and proposals this trigger may make."><input id="api-tr-lim-day" className="input mono" type="number" min="1" value={x.perDay} disabled={ro} onChange={(e) => set("perDay", e.target.value)} /></Field>
          </div>
          {t.type !== "schedule" ? <Field label="Auto-reply" htmlFor="api-tr-reply" hint={`The reply for this trigger. {wo} becomes the work order id (or the proposal id when held). Shown in Simulate; posting it back to ${srcName(x.source, d)} is not built yet.`}><textarea id="api-tr-reply" className="input" rows={2} value={x.reply} disabled={ro} onChange={(e) => set("reply", e.target.value)} /></Field> : null}
          <label className="toggle-row api-dedupe" htmlFor="api-tr-dedupe">
            <span><strong>Dedupe</strong><span className="muted small"> Skip when an open work order or held proposal on this project has the same title.</span></span>
            <Toggle id="api-tr-dedupe" checked={x.dedupe} onChange={(v) => set("dedupe", v)} decision={ro ? perm : null} />
          </label>
          <div className="form-actions">
            <Btn label="Revert" id="api-tr-revert" onClick={() => setRevertKey((k) => k + 1)} />
            <Btn label="Save trigger" kind="primary" id="api-tr-save" guard={perm} onClick={() => void save()} />
          </div>
        </div>
      </Panel>
      <Proposals t={t} />
      <Panel title="Simulate and history">
        <div className="form-grid">
          <div className="toolbar">
            <p className="muted small">Send a sample event through this rule: label or command check, author mapping, dedupe and limits. Nothing is created unless you ask.</p>
            <Btn label={`Simulate incoming ${simWord}`} icon="play" id="api-tr-sim" guard={perm} onClick={() => ui.open((c) => <Simulate t={t} d={d} close={c} onResult={setRes} />)} />
          </div>
          {res ? (
            <div className={`callout ${res.outcome === "created" ? "callout-ok" : "callout-warn"}`} role="status" id="api-tr-simres">
              <Icon name={res.outcome === "created" ? "check" : "alert"} />
              <span>
                {shown.startsWith("would ") ? <strong>{res.msg}</strong> : <><strong>{shown}</strong>{res.msg ? `: ${res.msg}` : ""}</>}{" "}
                {res.wo ? <button type="button" className="linkish mono" id="api-tr-simwo" onClick={() => openTraveler(res.wo)}>{`Open ${res.wo}`}</button> : null}
                {res.notes.map((n) => <span key={n} className="small muted"> {n}</span>)}
              </span>
            </div>
          ) : null}
          {runs.length ? (
            <div className="table-scroll">
              <table className="table table-compact">
                <thead><tr><th>Time (IST)</th><th>Source</th><th>Outcome</th><th>Work order</th></tr></thead>
                <tbody>
                  {runs.map((r: TriggerRun, i) => {
                    const oc = outcomeClass(r.outcome);
                    return (
                      <tr key={r.id ?? i} title={r.msg}>
                        <td className="mono">{`${fmt.istDate(r.at)} ${fmt.ist(r.at)}`}</td>
                        <td className="mono small">{r.source}</td>
                        <td><span className={`outcome o-${oc}`}>{outcomeMark(oc) + r.outcome}</span></td>
                        <td>{r.wo ? <button type="button" className="linkish mono" id={`api-tr-run-${i}`} onClick={() => openTraveler(r.wo)}>{r.wo}</button> : r.proposal ? <span className="mono" title="Held proposal">{r.proposal}</span> : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <Empty title="No runs yet" text="Simulate an event to see it here." />}
        </div>
      </Panel>
    </div>
  );
}

/* ---------- the tab ---------- */

export function TriggersTab({ d }: { d: ApiData }) {
  const ui = useUI();
  const guard = useCanAny("triggers.edit", d.vis);
  const [sel, setSel] = useState<string | null>(null);
  const [sims, setSims] = useState<Record<string, SimResult>>({});
  const [q, setQ] = useState("");
  const list = d.triggers;
  const needle = q.trim().toLowerCase();
  const shown = list.filter((x) => !needle || `${x.name} ${x.type} ${srcName(x.source, d)}`.toLowerCase().includes(needle));
  const cur = list.find((t) => t.id === sel) ?? list[0] ?? null;
  return (
    <div className="form-grid">
      <FilterBar label="Triggers" count={`${list.length} triggers`} actions={<Btn label="New trigger" kind="primary" icon="plus" id="api-tr-new" guard={guard} onClick={() => ui.open((c) => <NewTrigger d={d} close={c} onCreated={setSel} />)} />}>
        <SearchBox id="api-tr-q" label="Search triggers" placeholder="Search triggers" value={q} onChange={setQ} />
      </FilterBar>
      <DataTable
        id="api-tr-list"
        caption="Triggers"
        rows={shown}
        rowKey={(x) => x.id}
        rowId={(x) => `api-tr-open-${x.id}`}
        rowLabel={(x) => `Open ${x.name}`}
        onRow={(x) => setSel(x.id)}
        pageSize={10}
        empty={{ title: "No trigger matches", text: "Change the search." }}
        columns={[
          { key: "name", label: "Trigger", sort: (x) => x.name.toLowerCase(), render: (x) => <b className={`ell${x.id === cur?.id ? " sel-mark" : ""}`}>{x.name}</b> },
          { key: "source", label: "Source", render: (x) => <><span className="tag">{srcName(x.source, d)}</span>{srcState(x.source, d) === "healthy" ? null : <div className="small neg">{`✕ source ${srcState(x.source, d)}`}</div>}</> },
          { key: "type", label: "Type", hideSmall: true, render: (x) => <span className="tag">{TTYPES[x.type]?.name ?? x.type}</span> },
          { key: "project", label: "Project", render: (x) => <span className="tag">{d.pname(x.project)}</span> },
          { key: "runs", label: "Runs", align: "end", sort: (x) => x.runs.length, render: (x) => <span className="mono">{x.runs.length}</span> },
          { key: "last", label: "Last fired", render: (x) => { const last = x.runs[x.runs.length - 1]; return <span className="mono dim">{last ? fmt.ago(last.at, Date.now()) : "never"}</span>; } },
          { key: "en", label: "Enabled", render: (x) => <>{x.enabled ? <span className="chip ok">on</span> : <span className="chip idle">off</span>}{x.held ? <span className="chip warn" title="Proposals waiting for a person">{`${x.held} held`}</span> : null}</> },
        ]}
      />
      <div className="api-tdetail">
        {cur ? <Detail key={`${cur.id}:${cur.version ?? 0}`} t={cur} d={d} res={sims[cur.id]} setRes={(r) => setSims((s) => ({ ...s, [cur.id]: r }))} /> : <Empty title="No triggers" text="Create a trigger to open work orders from a connected source." />}
      </div>
    </div>
  );
}
