/** New project wizard (legacy projects.js openWizard): template, name and owner, repos, approvers, notifications, review. */
import { qk } from "../../api/keys";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmt, gateExplain, route as domainRoute, type ApproverRule, type Catalog } from "@gantry/domain";
import { api, get } from "../../api/client";
import { ops } from "../../api/ops";
import { getQueryClient } from "../../api/keys";
import { useCan } from "../../api/can";
import { useMe, usePeople, useTemplates } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Btn, Field, IconBtn, LockNote, Segmented, Select, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { evName, goProject, roleName, useCatalog, useTeams, type PView } from "./kit";
import { TplBelt } from "./templates";
import { tplCustom, tplCustomCount, tplCustomText, tplFlowProject, catalogWithCustom, type Presets, type Tpl } from "./templates-kit";

const STEPS: Array<[string, string]> = [["template", "Template"], ["basics", "Name and owner"], ["repos", "Repos"], ["approvers", "Approvers"], ["notify", "Notifications"], ["review", "Review"]];
const PRESET: Record<string, string> = {
  standard: "Standard: one approver per human gate, author cannot approve, hotfix needs an on-call Release Manager.",
  light: "Light: engineers may approve reviews, no path conditions.",
  strict: "Strict: two approvers on Spec and Review, high-risk changes need Security, compliance copy of every decision.",
};
const idFor = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function useProjectPresets(): Presets | null {
  return useQuery({ queryKey: qk.presets(), queryFn: () => get<Presets>(api("project-presets")), staleTime: 60_000 }).data ?? null;
}

interface Wz {
  step: number;
  tpl: string;
  name: string;
  key: string;
  desc: string;
  owner: string;
  teams: string[];
  budget: number;
  repos: Record<string, string>;
  extraRepo: string;
  approverPreset: "standard" | "light" | "strict";
  fallback: string;
  notifyPreset: "standard" | "light" | "strict";
  routesOff: Record<string, boolean>;
  err: string | null;
}

export function NewProjectWizard({ tplId, projects, close }: { tplId?: string | undefined; projects: PView[]; close: () => void }) {
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const tpls = (useTemplates().data ?? []) as Tpl[];
  const people = usePeople().data ?? [];
  const teams = useTeams();
  const presets = useProjectPresets();
  const d = useCan("project.create");
  const first = tpls.find((t) => t.id === tplId) ?? tpls[0];
  const [wz, setWz] = useState<Wz>(() => ({
    step: 0, tpl: first?.id ?? "", name: "", key: "", desc: "", owner: me?.person.id ?? "", teams: [], budget: 2000, repos: {}, extraRepo: "",
    approverPreset: first?.approverPreset ?? "standard", fallback: "", notifyPreset: first?.notify ?? "standard", routesOff: {}, err: null,
  }));
  const [busy, setBusy] = useState(false);
  if (!cat || !first || !presets) return <Dialog title="New project" kicker="Projects · from a template" wide body={<p className="muted small">Loading…</p>} onClose={close} actions={[{ label: "Cancel", id: "prj-wz-cancel" }]} />;
  const T = tpls.find((t) => t.id === wz.tpl) ?? first;
  const upd = (p: Partial<Wz>) => setWz((x) => ({ ...x, ...p }));
  const focus = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 40);
  const active = people.filter((x) => x.status === "active");

  const check = (step: number): string | null => {
    if (step === 1) {
      if (wz.name.trim().length < 3) return "Name the project (3+ characters).";
      if (projects.some((p) => p.id === idFor(wz.name))) return `A project called ${wz.name.trim()} already exists.`;
      if (!wz.teams.length) return "Pick at least one owning team.";
    }
    if (step === 2) {
      const bad = Object.keys(wz.repos).filter((n) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(n));
      if (bad.length) return `Repo names look like acme/name: ${bad.join(", ")}`;
    }
    return null;
  };
  const routes = () => presets.routes[wz.notifyPreset].filter((r) => !wz.routesOff[r.event]);
  const approvers = (): Record<string, ApproverRule> => {
    const a = JSON.parse(JSON.stringify(presets.approvers[wz.approverPreset])) as Record<string, ApproverRule>;
    if (wz.fallback) for (const k of Object.keys(a)) if (a[k]!.roles.length) a[k]!.fallback = wz.fallback;
    return a;
  };
  const go = (n: number) => {
    const e = n > wz.step ? check(wz.step) : null;
    if (e) return upd({ err: e });
    upd({ err: null, step: n });
    setTimeout(() => document.querySelector<HTMLElement>(".prj-wz input,.prj-wz select,.prj-wz button.prj-wz-focus")?.focus(), 40);
  };
  const tplCat = (t: Tpl): Catalog => catalogWithCustom(cat, t);

  const create = async () => {
    for (let i = 1; i < 3; i++) {
      const e = check(i);
      if (e) return upd({ err: e, step: i });
    }
    setBusy(true);
    const r = await ops.createProject({ name: wz.name.trim(), key: wz.key || null, templateId: wz.tpl, owner: wz.owner, teams: wz.teams, desc: wz.desc.trim() || null, budget: wz.budget || 1000, approvers: approvers(), notifications: routes() });
    if (!r.ok) {
      setBusy(false);
      return upd({ err: r.msg });
    }
    const project = (r as unknown as { project: { id: string } }).project;
    const custom = (r as unknown as { custom?: { failed: string[] } }).custom ?? { failed: [] };
    const failedRepos: string[] = [];
    for (const [name, team] of Object.entries(wz.repos)) {
      const c = await ops.connectRepo(project.id, name, team || wz.teams[0] || "platform");
      if (!c.ok) failedRepos.push(`${name}: ${c.msg}`);
    }
    const n = Object.keys(wz.repos).length - failedRepos.length;
    ui.toast(`${r.msg} ${n} repo${n === 1 ? "" : "s"} onboarding.${failedRepos.length ? ` Not connected: ${failedRepos.join("; ")}.` : ""}`, custom.failed.length || failedRepos.length ? "warn" : "ok");
    close();
    // the shell keeps the stored project to one in `me`: wait until `me` lists the new project before switching to it
    await getQueryClient()?.refetchQueries({ queryKey: qk.me() });
    goProject(project.id, "project-config");
  };

  let body;
  const step = STEPS[wz.step]![0];
  if (step === "template") {
    body = (
      <div className="radio-cards prj-wz-tpls" role="radiogroup" aria-label="Template">
        {tpls.map((t) => {
          const id = `prj-wz-tpl-${t.id}`;
          return (
            <label key={t.id} className={`radio-card prj-wz-tpl${wz.tpl === t.id ? " is-on" : ""}`} htmlFor={id}>
              <input type="radio" name="prj-wz-tpl" id={id} checked={wz.tpl === t.id} onChange={() => { upd({ tpl: t.id, approverPreset: t.approverPreset, notifyPreset: t.notify }); focus(id); }} />
              <span className="rc-t">{t.name}</span>
              <span className="rc-d">{t.desc}</span>
              <TplBelt cat={cat} t={t} />
              <span className="rc-d mono">{`${t.slots} slot${t.slots > 1 ? "s" : ""} · ${t.approverPreset} approvers`}</span>
            </label>
          );
        })}
      </div>
    );
  } else if (step === "basics") {
    const keyHint = (idFor(wz.name).replace(/-/g, "").slice(0, 3) || "KEY").toUpperCase();
    body = (
      <div className="form-grid">
        <div className="form-row">
          <Field label="Project name" htmlFor="prj-wz-name"><input id="prj-wz-name" className="input" value={wz.name} placeholder="Checkout Platform" autoComplete="off" onChange={(e) => upd({ name: e.target.value })} /></Field>
          <Field label="Key" htmlFor="prj-wz-key" hint="Short prefix, 2 to 5 letters."><input id="prj-wz-key" className="input mono" value={wz.key} maxLength={5} placeholder={keyHint} onChange={(e) => upd({ key: e.target.value.toUpperCase() })} /></Field>
        </div>
        <Field label="Description" htmlFor="prj-wz-desc"><input id="prj-wz-desc" className="input" value={wz.desc} placeholder="What this project builds" onChange={(e) => upd({ desc: e.target.value })} /></Field>
        <div className="form-row">
          <Field label="Owner" htmlFor="prj-wz-owner" hint="Becomes Project Admin unless they hold a factory role."><Select id="prj-wz-owner" options={active.map((x) => ({ value: x.id, label: `${x.name} · ${x.title}` }))} value={wz.owner} onChange={(v) => upd({ owner: v })} /></Field>
          <Field label="Monthly budget (USD)" htmlFor="prj-wz-budget"><input id="prj-wz-budget" type="number" min={100} className="input mono" value={String(wz.budget)} onChange={(e) => upd({ budget: parseInt(e.target.value, 10) || 0 })} /></Field>
        </div>
        <Field label="Owning teams" htmlFor="prj-wz-team-add" hint="A project can have more than one owning team.">
          <Select id="prj-wz-team-add" options={[{ value: "", label: "Add an owning team" }, ...teams.filter((t) => !wz.teams.includes(t.id)).map((t) => ({ value: t.id, label: t.name }))]} value="" onChange={(v) => { if (v) { upd({ teams: [...wz.teams, v] }); focus("prj-wz-team-add"); } }} />
          {wz.teams.length ? (
            <div className="chips prj-wz-teams">
              {wz.teams.map((id) => (
                <span key={id} className="chip">
                  {teams.find((t) => t.id === id)?.name ?? id}
                  <IconBtn icon="x" id={`prj-wz-team-rm-${id}`} label={`Remove ${teams.find((t) => t.id === id)?.name ?? id}`} onClick={() => upd({ teams: wz.teams.filter((x) => x !== id) })} />
                </span>
              ))}
            </div>
          ) : null}
        </Field>
      </div>
    );
  } else if (step === "repos") {
    const picked = Object.keys(wz.repos);
    const teamOpts = teams.map((t) => ({ value: t.id, label: t.name }));
    body = (
      <div className="form-grid">
        <p className="small muted">Each repo is connected through the source-control integration and starts onboarding: the Onboarding agent assesses it and opens a PR. Work orders can target a repo once it is Ready. You can also add repos later.</p>
        <div className="inline-form">
          <Field label="Repo" htmlFor="prj-wz-repo-add"><input id="prj-wz-repo-add" className="input mono" value={wz.extraRepo} placeholder="acme/new-service" onChange={(e) => upd({ extraRepo: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const n = wz.extraRepo.trim(); if (n) upd({ repos: { ...wz.repos, [n]: wz.teams[0] || "platform" }, extraRepo: "" }); } }} /></Field>
          <Btn small icon="plus" id="prj-wz-repo-go" label="Add repo" onClick={() => { const n = wz.extraRepo.trim(); if (!n) return; upd({ repos: { ...wz.repos, [n]: wz.teams[0] || "platform" }, extraRepo: "" }); focus("prj-wz-repo-add"); }} />
        </div>
        {picked.length ? (
          <ul className="plain-list prj-wz-repos">
            {picked.map((n) => (
              <li key={n} className="prj-wz-repo">
                <span className="mono">{n}</span>
                <Select id={`prj-wz-repo-${n.replace(/[^a-z0-9]/gi, "-")}-team`} options={teamOpts} value={wz.repos[n]!} aria-label={`Owning team for ${n}`} onChange={(v) => upd({ repos: { ...wz.repos, [n]: v } })} />
                <Btn small kind="ghost" icon="x" id={`prj-wz-rm-${n.replace(/[^a-z0-9]/gi, "-")}`} label="Remove" onClick={() => { const r = { ...wz.repos }; delete r[n]; upd({ repos: r }); }} />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="small">{`${picked.length} repo${picked.length === 1 ? "" : "s"} selected.`}</p>
      </div>
    );
  } else if (step === "approvers") {
    const a = approvers();
    const fc = tplCat(T);
    const flowProj = tplFlowProject(fc, T);
    const gatesShown = fc.gates.filter((g) => flowProj.flow.gates[g.id] && !flowProj.flow.gates[g.id]!.absent && (flowProj.flow.gates[g.id]!.mode ?? g.kind) !== "auto" && !T.gatesOff.includes(g.id));
    body = (
      <div className="form-grid">
        <div className="radio-cards" role="radiogroup" aria-label="Approver preset">
          {(["standard", "light", "strict"] as const).map((k) => {
            const id = `prj-wz-ap-${k}`;
            return (
              <label key={k} className={`radio-card${wz.approverPreset === k ? " is-on" : ""}`} htmlFor={id}>
                <input type="radio" name="prj-wz-ap" id={id} checked={wz.approverPreset === k} onChange={() => { upd({ approverPreset: k }); focus(id); }} />
                <span className="rc-t">{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                <span className="rc-d">{PRESET[k]!.split(": ")[1]}</span>
              </label>
            );
          })}
        </div>
        <Field label="Escalation fallback" htmlFor="prj-wz-fallback" hint="Who gets a gate when it waits past its SLA.">
          <Select id="prj-wz-fallback" options={[{ value: "", label: "Project owner" }, ...active.map((x) => ({ value: x.id, label: x.name }))]} value={wz.fallback} onChange={(v) => upd({ fallback: v })} />
        </Field>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr><th>Gate</th><th>Who</th><th className="num">Needs</th><th>Author can approve</th><th>Conditions</th></tr></thead>
            <tbody>
              {gatesShown.map((g) => {
                const cg = tplCustom(T).gates.find((x) => x.id === g.id);
                const r = cg ? { roles: cg.roles ?? [], required: cg.required ?? 1, sod: true, conditions: [] as ApproverRule["conditions"] } : a[g.id];
                if (!r) return null;
                return (
                  <tr key={g.id}>
                    <td title={gateExplain(g)}>{g.name}<span className="mono muted small">{` ${g.label}`}</span></td>
                    <td className="small">{r.roles.map((x) => roleName(cat, x)).join(", ")}</td>
                    <td className="num mono">{String(r.required)}</td>
                    <td>{r.sod ? "no" : "yes"}</td>
                    <td className="small">{r.conditions.map((c) => c.text).join("; ") || <span className="muted">none</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {T.approverPreset === "strict" && T.gatesOff.length ? <p className="small" role="alert">{`${T.name} turns ${T.gatesOff.map((x) => fc.gates.find((g) => g.id === x)?.name ?? x).join(", ")} off, but regulated projects keep every gate on. The server will refuse it; pick another template.`}</p> : null}
        <p className="small muted">Named approvers, N of M and conditions can be edited per gate in Project config after creation.</p>
      </div>
    );
  } else if (step === "notify") {
    const all = presets.routes[wz.notifyPreset];
    body = (
      <div className="form-grid">
        <Field label="Preset">
          <Segmented name="prj-wz-np" items={[{ id: "standard", label: "Standard" }, { id: "light", label: "Light" }, { id: "strict", label: "Strict" }]} value={wz.notifyPreset} onChange={(v) => { upd({ notifyPreset: v as Wz["notifyPreset"] }); focus(`prj-wz-np-${v}`); }} label="Notification preset" />
        </Field>
        <ul className="plain-list prj-wz-routes">
          {all.map((r) => {
            const locked = r.event === "kill" || r.event === "restore";
            return (
              <li key={r.id} className="toggle-row">
                <span>
                  <strong>{evName(r.event)}</strong>
                  <span className="muted small mono">{` → ${r.dest.map((x) => `${x.channel} ${x.target}`).join(", ")}`}</span>
                </span>
                <Toggle id={`prj-wz-nr-${r.event.replace(".", "-")}`} checked={!wz.routesOff[r.event]} label={evName(r.event)} decision={locked ? { allowed: false, reason: "Kill and restore notices are always on.", needs: "" } : null} onChange={(v) => { const o = { ...wz.routesOff }; if (v) delete o[r.event]; else o[r.event] = true; upd({ routesOff: o }); }} />
              </li>
            );
          })}
        </ul>
        <p className="small muted">Destinations and card templates can be changed later in Notifications.</p>
      </div>
    );
  } else {
    const rp = Object.keys(wz.repos);
    const fc = tplCat(T);
    const fp = tplFlowProject(fc, T);
    const person = people.find((x) => x.id === wz.owner);
    body = (
      <div className="form-grid">
        <dl className="titleblock prj-wz-review">
          <div><dt>Name</dt><dd>{wz.name.trim() || "missing"}</dd></div>
          <div><dt>Key</dt><dd className="mono">{(wz.key || idFor(wz.name).replace(/-/g, "").slice(0, 3)).toUpperCase()}</dd></div>
          <div><dt>Template</dt><dd>{T.name}</dd></div>
          <div><dt>Owner</dt><dd>{person?.name ?? wz.owner}</dd></div>
          <div><dt>Teams</dt><dd>{wz.teams.map((x) => teams.find((t) => t.id === x)?.name ?? x).join(", ")}</dd></div>
          <div><dt>Budget</dt><dd>{fmt.money0(wz.budget)}</dd></div>
          <div><dt>Approvers</dt><dd>{wz.approverPreset}</dd></div>
          <div><dt>Routes</dt><dd>{`${routes().length} notification routes`}</dd></div>
        </dl>
        <div>
          <div className="sub-h">Flow</div>
          <TplBelt cat={cat} t={T} />
          <p className="small muted">{`Feature route: ${domainRoute(fc, fp, "feature").map((s) => fc.stations.find((x) => x.id === s)?.name ?? s).join(" → ")}`}</p>
          {tplCustomCount(T) ? <p className="small"><span className="kv-k">Custom entries carried </span>{tplCustomText(T)}. They are added through the flow ops after the project is created; people still need any custom approver roles granted.</p> : null}
        </div>
        <div>
          <div className="sub-h">Repos to onboard</div>
          {rp.length ? <ul className="plain-list small">{rp.map((n) => <li key={n} className="mono">{`${n} · ${teams.find((t) => t.id === wz.repos[n])?.name ?? wz.repos[n]}`}</li>)}</ul> : <p className="small muted">None. The project starts as New until a repo is connected.</p>}
        </div>
        <LockNote decision={d} what="Creating projects" />
      </div>
    );
  }
  const last = wz.step === STEPS.length - 1;
  return (
    <Dialog
      title="New project" kicker="Projects · from a template" wide onClose={close}
      actions={[{ label: "Cancel", id: "prj-wz-cancel" }]}
      body={
        <div className="prj-wz">
          <ol className="stepper prj-wz-steps">
            {STEPS.map((s, i) => (
              <li key={s[0]} className={i === wz.step ? "is-on" : i < wz.step ? "is-done" : ""} aria-current={i === wz.step ? "step" : undefined}>
                <span>{i < wz.step ? "✓" : String(i + 1)}</span>
                {s[1]}
              </li>
            ))}
          </ol>
          <div className="prj-wz-body">{body}</div>
          {wz.err ? <div className="form-err" role="alert">{wz.err}</div> : null}
          <div className="prj-wz-nav">
            {wz.step ? <Btn kind="ghost" icon="back" id="prj-wz-back" label="Back" onClick={() => go(wz.step - 1)} /> : <span />}
            {last ? (
              <Btn kind="primary" icon="check" id="prj-wz-create" guard={d} disabledReason={busy ? "Creating the project…" : null} label="Create project" onClick={create} />
            ) : (
              <Btn kind="primary" icon="chevron" id="prj-wz-next" cls="prj-wz-focus" label={`Next: ${STEPS[wz.step + 1]![1]}`} onClick={() => go(wz.step + 1)} />
            )}
          </div>
        </div>
      }
    />
  );
}
