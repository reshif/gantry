/** Per-project routing policy (spec 10.4): the project's own default, the vendors, regions and retention modes it allows, and its opt-in to a different-model fallback. */
import { useEffect, useState } from "react";
import type { Project, ProjectRouting, Routing, Vendor } from "@gantry/domain";
import { useCan } from "../../api/can";
import { Btn, Field, Select, Toggle } from "../../ui/primitives";
import { dec, RETENTION } from "./kit";

type Change = (fn: (x: Routing) => void, msg: string, label?: string) => Promise<{ ok: boolean }>;

export function ProjectPolicy({ routing, vendors, projects, enabled, change }: { routing: Routing; vendors: Vendor[]; projects: Project[]; enabled: Array<{ value: string; label: string }>; change: Change }) {
  const perm = dec(useCan("model.edit"));
  const ro = !perm.allowed;
  const live = projects.filter((p) => p.status !== "archived");
  const [pid, setPid] = useState(live[0]?.id ?? "");
  const cur: ProjectRouting = routing.projects?.[pid] ?? {};
  const [model, setModel] = useState(cur.defaultModel ?? "");
  const [allowed, setAllowed] = useState<string[]>(cur.allowedVendors ?? []);
  const [regions, setRegions] = useState((cur.allowedRegions ?? []).join(", "));
  const [ret, setRet] = useState<string[]>(cur.allowedRetention ?? []);
  const [crossOpt, setCrossOpt] = useState(cur.crossModelFallback === true);
  const factoryCross = routing.crossModelFallback === true;
  // Load the form from the saved policy when the project (or the saved routing) changes.
  const saved = JSON.stringify(routing.projects?.[pid] ?? {});
  useEffect(() => {
    const p: ProjectRouting = JSON.parse(saved) as ProjectRouting;
    setModel(p.defaultModel ?? "");
    setAllowed(p.allowedVendors ?? []);
    setRegions((p.allowedRegions ?? []).join(", "));
    setRet(p.allowedRetention ?? []);
    setCrossOpt(p.crossModelFallback === true);
  }, [pid, saved]);
  const flip = (list: string[], v: string, on: boolean): string[] => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const project = live.find((p) => p.id === pid);

  const save = () => {
    const next: ProjectRouting = {};
    if (model) next.defaultModel = model;
    if (cur.overrides && Object.keys(cur.overrides).length) next.overrides = cur.overrides;
    if (cur.classOverrides && Object.keys(cur.classOverrides).length) next.classOverrides = cur.classOverrides;
    if (allowed.length) next.allowedVendors = allowed;
    const rg = regions.split(",").map((x) => x.trim()).filter(Boolean);
    if (rg.length) next.allowedRegions = rg;
    if (ret.length) next.allowedRetention = ret;
    if (crossOpt) next.crossModelFallback = true;
    void change((x) => {
      const ps = { ...(x.projects ?? {}) };
      if (Object.keys(next).length) ps[pid] = next; else delete ps[pid];
      if (Object.keys(ps).length) x.projects = ps; else delete x.projects;
    }, `Routing policy for ${project?.name ?? pid} saved.`, `Project policy: ${project?.name ?? pid}`);
  };

  return (
    <div className="md-policy" id="rt-policy">
      <p className="muted small">What this project allows. Empty means no restriction. These apply before any fallback.</p>
      <Field label="Project" htmlFor="rt-proj"><Select id="rt-proj" options={live.map((p) => ({ value: p.id, label: p.name }))} value={pid} onChange={setPid} /></Field>
      <Field label="Project default model" htmlFor="rt-proj-model"><Select id="rt-proj-model" disabled={ro} options={[{ value: "", label: "Use the factory default" }, ...enabled]} value={model} onChange={setModel} /></Field>
      <fieldset className="md-policy-set">
        <legend className="small">Allowed vendors</legend>
        {vendors.map((v) => (
          <label key={v.id} className="check" htmlFor={`rt-proj-v-${v.id}`}>
            <input type="checkbox" id={`rt-proj-v-${v.id}`} disabled={ro} checked={allowed.includes(v.id)} onChange={(e) => setAllowed((l) => flip(l, v.id, e.target.checked))} />
            <span>{v.name}</span>
          </label>
        ))}
      </fieldset>
      <Field label="Allowed regions" htmlFor="rt-proj-regions" hint="Comma-separated, matched against each vendor's region."><input id="rt-proj-regions" className="input mono" value={regions} disabled={ro} placeholder="eu-central-1, on-prem" onChange={(e) => setRegions(e.target.value)} /></Field>
      <fieldset className="md-policy-set">
        <legend className="small">Allowed data retention</legend>
        {RETENTION.map((o) => (
          <label key={o.value} className="check" htmlFor={`rt-proj-r-${o.value}`}>
            <input type="checkbox" id={`rt-proj-r-${o.value}`} disabled={ro} checked={ret.includes(o.value)} onChange={(e) => setRet((l) => flip(l, o.value, e.target.checked))} />
            <span>{o.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="md-cross">
        <Toggle id="rt-proj-cross" checked={crossOpt} label="Allow fallback to a different model for this project" decision={ro ? perm : !factoryCross ? { allowed: false, reason: "Cross-model fallback is switched off for the factory. Turn it on under Fallback order first." } : null} onChange={setCrossOpt} />
        <span className="small">Allow a different model when the pinned one cannot be served. Flagged on the run.</span>
      </div>
      <Btn label="Save project policy" kind="primary" id="rt-proj-save" guard={perm} onClick={save} />
    </div>
  );
}
