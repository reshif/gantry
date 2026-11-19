/** Per-repo settings (legacy onboarding.js settings form): shared by the connect wizard and the "Repo settings" dialog. */
import { useState } from "react";
import { CARD_TEMPLATES, NOTIFY_EVENTS, type Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useCardTemplates, useMcpServers, useTriggers } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Btn, Field, LockNote, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useTeams } from "../projects/kit";
import { defaultTemplate, draftFrom, healthWord, instLabel, patchFrom, useIntegrationsFor, type Draft, type RepoV, type SourceInfo } from "./kit";

type Set = (p: Partial<Draft>) => void;

const eventList = NOTIFY_EVENTS.map((e) => ({ value: e.id, label: e.name }));
const MERGE = [{ value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }];
const TAGGING = [{ value: "semver-patch", label: "Semver, patch bump" }, { value: "semver-minor", label: "Semver, minor bump" }, { value: "calver", label: "Calendar version" }, { value: "none", label: "No tags" }];

function Text({ id, value, onChange, mono, rows, placeholder }: { id: string; value: string; onChange: (v: string) => void; mono?: boolean; rows?: number; placeholder?: string }) {
  const cls = `input${mono ? " mono" : ""}`;
  return rows ? (
    <textarea id={id} className={cls} rows={rows} value={value} autoComplete="off" placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <input id={id} className={cls} value={value} autoComplete="off" placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Where the repo lives: the GitHub App itself, or one of the project's source integrations. Only GitHub can be onboarded in this build. */
export function SecSource({ d, set, sources, project }: { d: Draft; set: Set; sources: SourceInfo[]; project: Project; wizard?: boolean; onPick?: (id: string) => void }) {
  return (
    <div className="radio-cards onb-src">
      {[{ id: "", name: "GitHub App", sub: "gantry-github · the repositories the App is installed on", disabled: null as string | null }, ...sources.map((s) => ({ id: s.inst.id, name: s.inst.name, sub: `${s.type.name ?? s.inst.type} · ${s.inst.config.host || s.inst.config.site || s.inst.config.url || s.inst.config.org || ""}${s.inst.status !== "healthy" ? ` · ${healthWord(s.inst.status)}` : ""}`, disabled: s.inst.type !== "github" ? `${s.type.name ?? s.inst.type} sources cannot be onboarded yet. Only GitHub can.` : s.inst.status === "offline" ? `${s.inst.name} is offline. Fix it under Integrations.` : null }))].map((s) => (
        <label key={s.id || "app"} className="radio-card" htmlFor={`onb-w-src-${s.id || "app"}`} title={s.disabled ?? undefined}>
          <input type="radio" name="onb-w-src" id={`onb-w-src-${s.id || "app"}`} value={s.id} checked={d.source === s.id} disabled={!!s.disabled} onChange={() => set({ source: s.id })} />
          <span className="rc-t">{s.name}</span>
          <span className="rc-d">{s.sub}</span>
        </label>
      ))}
      <span hidden>{project.id}</span>
    </div>
  );
}

export function SecOwnership({ d, set, project }: { d: Draft; set: Set; project: Project }) {
  const teams = useTeams();
  const { dests } = useIntegrationsFor(project.id);
  const customTpls = useCardTemplates().data;
  const tplOptions = (cur: string) => {
    const out = [...Object.keys(CARD_TEMPLATES).map((k) => ({ value: k, label: CARD_TEMPLATES[k]!.name })), ...(Array.isArray(customTpls) ? customTpls : []).map((t) => ({ value: t.id, label: `${t.name} (custom)` }))];
    if (cur && !out.some((o) => o.value === cur)) out.push({ value: cur, label: `${cur} (older template)` });
    return out;
  };
  const upd = (i: number, p: Partial<Draft["notify"][number]>) => set({ notify: d.notify.map((n, k) => (k === i ? { ...n, ...p } : n)) });
  return (
    <div className="form-grid">
      <Field label="Owning team" htmlFor="onb-w-team" hint="Gets CODEOWNERS entries and is asked first about this repo.">
        <Select id="onb-w-team" options={teams.map((t) => ({ value: t.id, label: t.name }))} value={d.team} onChange={(v) => set({ team: v })} />
      </Field>
      <div className="field">
        <div className="field-label">Notification routes for this repo (override project routes)</div>
        {d.notify.length ? (
          <div className="onb-nrows">
            {d.notify.map((n, i) => {
              const opts = dests.map((x) => ({ value: x.inst.id, label: instLabel(x.inst) }));
              if (!n.integration) opts.unshift({ value: "", label: "Pick a destination" });
              const inst = dests.find((x) => x.inst.id === n.integration);
              return (
                <div className="onb-nrow" key={i}>
                  <Select id={`onb-n-ev-${i}`} aria-label="Event" options={eventList} value={n.event} onChange={(v) => upd(i, { event: v, ...(n.template === defaultTemplate(n.event) ? { template: defaultTemplate(v) } : {}) })} />
                  <Select id={`onb-n-ch-${i}`} aria-label="Destination integration" options={opts} value={n.integration ?? ""} onChange={(v) => { const x = dests.find((y) => y.inst.id === v); upd(i, { integration: x ? x.inst.id : null, channel: x ? x.inst.type : n.channel }); }} />
                  <input id={`onb-n-tg-${i}`} className="input mono" value={n.target} placeholder={inst?.type.targetLabel || "#channel or address"} aria-label={inst?.type.targetLabel || "Destination"} onChange={(e) => upd(i, { target: e.target.value })} />
                  <Select id={`onb-n-tp-${i}`} aria-label="Card template" options={tplOptions(n.template)} value={n.template} onChange={(v) => upd(i, { template: v })} />
                  <button type="button" className="icon-btn icon-btn-sm" id={`onb-n-rm-${i}`} aria-label="Remove route" onClick={() => set({ notify: d.notify.filter((_, k) => k !== i) })}>
                    <Icon name="x" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted small">No overrides. The project's routes apply.</p>
        )}
        <Btn label="Add route" small icon="plus" id="onb-n-add" disabledReason={dests.length ? null : "No notification integration is connected for this project. Add one under Integrations"}
          onClick={() => { const x = dests.find((y) => y.inst.status === "healthy") ?? dests[0]; if (x) set({ notify: [...d.notify, { event: "question", integration: x.inst.id, channel: x.inst.type, target: "", template: defaultTemplate("question") }] }); }} />
        <div className="field-hint">Destinations are this project's connected integrations, custom ones included. Card templates come from Notifications.</div>
      </div>
    </div>
  );
}

export function SecMCP({ d, set }: { d: Draft; set: Set }) {
  const all = useMcpServers().data;
  const list = Array.isArray(all) ? all : [];
  return (
    <div className="form-grid">
      <p className="muted small">Servers the agents need on this repo. They are declared in .gantry/factory.yml by the onboarding PR.</p>
      {list.length ? (
        <div className="check-grid">
          {list.map((m) => (
            <label key={m.id} className="check" htmlFor={`onb-w-mcp-${m.id}`}>
              <input type="checkbox" id={`onb-w-mcp-${m.id}`} checked={d.mcp.includes(m.id)} onChange={(e) => set({ mcp: e.target.checked ? (d.mcp.includes(m.id) ? d.mcp : [...d.mcp, m.id]) : d.mcp.filter((x) => x !== m.id) })} />
              <span>{m.name}<span className="muted small">{` · ${m.sensitivity}${m.health !== "healthy" ? ` · ${m.health}` : ""}`}</span></span>
            </label>
          ))}
        </div>
      ) : (
        <p className="muted small">No MCP servers are registered yet. Add them under MCP.</p>
      )}
    </div>
  );
}

export function SecTriggers({ d, set, project }: { d: Draft; set: Set; project: Project }) {
  const all = useTriggers().data;
  const rules = (Array.isArray(all) ? all : []).filter((t) => t.project === project.id);
  return (
    <div className="form-grid">
      <div className="toggle-row">
        <Toggle id="onb-w-trig" checked={d.triggers} onChange={(v) => set({ triggers: v })} label="Issue triggers" />
        <label htmlFor="onb-w-trig">Let issues and comments from this project's trigger sources create work orders for this repo</label>
      </div>
      {rules.length ? (
        <ul className="plain-list small">
          {rules.map((t) => (
            <li key={t.id}><span className="mono">{t.id}</span>{` ${t.name} · ${t.label ? `label ${t.label}` : t.type}${t.enabled ? "" : " · disabled"}`}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">This project has no trigger rules yet. Add them under API and triggers.</p>
      )}
      <p className="field-hint">Issues only create work orders once the repo is Ready.</p>
    </div>
  );
}

export function SecConventions({ d, set }: { d: Draft; set: Set }) {
  return (
    <div className="form-grid onb-conv">
      <div className="form-row">
        <Field label="Default branch" htmlFor="onb-w-branch"><Text id="onb-w-branch" mono value={d.defaultBranch} onChange={(v) => set({ defaultBranch: v })} /></Field>
        <Field label="Agent branch prefix" htmlFor="onb-w-prefix"><Text id="onb-w-prefix" mono value={d.branchPrefix} onChange={(v) => set({ branchPrefix: v })} /></Field>
      </div>
      <div className="form-row">
        <Field label="Merge method" htmlFor="onb-w-merge"><Select id="onb-w-merge" options={MERGE} value={d.merge} onChange={(v) => set({ merge: v })} /></Field>
        <Field label="Release tagging" htmlFor="onb-w-tag"><Select id="onb-w-tag" options={TAGGING} value={d.tagging} onChange={(v) => set({ tagging: v })} /></Field>
      </div>
      <Field label="Required checks" htmlFor="onb-w-checks" hint="Comma separated. Gate G4 waits for these."><Text id="onb-w-checks" mono value={d.requiredChecks} onChange={(v) => set({ requiredChecks: v })} placeholder="ci/test, ci/lint" /></Field>
      <Field label="Protected paths" htmlFor="onb-w-paths" hint="One per line. Agents may not change these without an extra approval."><Text id="onb-w-paths" mono rows={3} value={d.protectedPaths} onChange={(v) => set({ protectedPaths: v })} placeholder="infra/prod/**" /></Field>
    </div>
  );
}

/** "Repo settings" dialog: the same sections as the wizard, saved with the repo's version as If-Match. */
export function SettingsDialog({ repo, project, close }: { repo: RepoV; project: Project; close: () => void }) {
  const ui = useUI();
  const dec = useCan("onboarding.manage", { project: repo.project, repo: repo.id });
  const { sources, dests } = useIntegrationsFor(repo.project);
  const [d, setD] = useState<Draft>(() => draftFrom(repo, project, dests));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set: Set = (p) => setD((x) => ({ ...x, ...p }));
  const save = async (done: () => void) => {
    setBusy(true);
    const x = await ops.configureRepo(repo.id, patchFrom(d), repo.version !== undefined ? { ifMatch: repo.version } : undefined);
    setBusy(false);
    if (!x.ok) return setErr(x.msg);
    ui.toast(x.msg, "ok");
    done();
  };
  return (
    <Dialog
      title={`Settings for ${repo.name}`} wide onClose={close}
      body={
        <div className="onb-settings">
          <LockNote decision={dec} what="Repo settings" />
          <h3 className="sub-h">Source</h3>
          <SecSource d={d} set={set} sources={sources} project={project} />
          <h3 className="sub-h">Ownership and notifications</h3>
          <SecOwnership d={d} set={set} project={project} />
          <h3 className="sub-h">MCP servers</h3>
          <SecMCP d={d} set={set} />
          <h3 className="sub-h">Issue triggers</h3>
          <SecTriggers d={d} set={set} project={project} />
          <h3 className="sub-h">Branch, merge and release conventions</h3>
          <SecConventions d={d} set={set} />
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: busy ? "Saving…" : "Save settings", kind: "primary", submit: true, id: "onb-set-save", guard: dec, onClick: (done) => void save(done) }]}
    />
  );
}
