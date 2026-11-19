/** Shared pieces of the Learning screen (legacy js/views/learning.js): kinds, signals, statuses, the word diff, what a change does, the status pipeline and evidence chips. */
import { fmt, type LearningProposal } from "@gantry/domain";
import { useAgents, useProjects, useSkills, useSuites } from "../../api/queries";
import { Icon } from "../../ui/Icon";
import { useOpenRecordRoute } from "../record/nav";
import { useCatalog } from "../projects/kit";

export const KINDS: Record<string, { name: string; icon: string }> = {
  skill: { name: "Skill edit", icon: "skill" }, guideline: { name: "Guideline change", icon: "page" }, eval: { name: "New eval case", icon: "eval" },
  guardrail: { name: "Guardrail", icon: "shield" }, approver: { name: "Approver rule", icon: "gate" }, route: { name: "Route change", icon: "branch" },
};
export const SIGNALS: Record<string, [string, string]> = {
  rejection: ["Gate rejection", "x"], sendback: ["Send-back", "undo"], revert: ["Revert", "alert"], incident: ["Incident", "alert"], override: ["Class override", "swap"], miss: ["Intake miss", "chat"], regression: ["Eval regression", "eval"],
};
export const sigName = (signal: string): string => (SIGNALS[signal]?.[0] ?? signal).toLowerCase();
export const STATUS: Record<string, string> = { proposed: "Proposed", accepted: "Accepted and applied", verified: "Verified", declined: "Declined", rolled_back: "Rolled back" };

/** Where a finding or proposal sits in the data the viewer loaded. */
export function useLn() {
  const projects = useProjects().data ?? [];
  const agents = useAgents().data ?? [];
  return {
    projName: (id: string | null | undefined): string => (id ? projects.find((p) => p.id === id)?.name ?? id : "All projects"),
    agName: (id: string | null | undefined): string => agents.find((a) => a.id === id)?.name ?? (id || "agent"),
  };
}

/** Evidence chip for a work order record; other evidence (an eval run) is shown as plain text. */
export function WoChip({ id, project }: { id: string; project?: string | null }) {
  const open = useOpenRecordRoute();
  if (!/^WO-/.test(id)) return <span className="chip entity-chip is-plain" data-entity={`run:${id}`}><Icon name="eval" /><span className="mono">{id}</span></span>;
  return (
    <a className="chip entity-chip entity-wo" href="#record" data-entity={`wo:${id}`} onClick={(e) => { e.preventDefault(); open(id, project ?? undefined); }}>
      <Icon name="page" /><span>{id}</span>
    </a>
  );
}

export function ChipList({ ids, max = 8, project }: { ids: string[]; max?: number; project?: string | null }) {
  return (
    <span className="ln-chips">
      {ids.slice(0, max).map((id) => <WoChip key={id} id={id} project={project} />)}
      {ids.length > max ? <span className="small muted">{`+${ids.length - max} more`}</span> : null}
    </span>
  );
}

/** Word-level diff between two strings: common prefix and suffix kept, the middle shown removed and added. */
export function WordDiff({ a, b }: { a: string; b: string }) {
  const x = String(a || "").split(/(\s+)/);
  const y = String(b || "").split(/(\s+)/);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const pre = x.slice(0, i).join("");
  const del = x.slice(i, x.length - j).join("");
  const ins = y.slice(i, y.length - j).join("");
  const post = x.slice(x.length - j).join("");
  return (
    <div className="ln-diff mono small" role="group" aria-label="Skill text change">
      <div className="ln-diff-line is-del"><span className="ln-diff-sign" aria-hidden="true">−</span><span className="sr-only">Before: </span>{pre}{del ? <del>{del}</del> : null}{post}</div>
      <div className="ln-diff-line is-ins"><span className="ln-diff-sign" aria-hidden="true">+</span><span className="sr-only">After: </span>{pre}{ins ? <ins>{ins}</ins> : null}{post}</div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a proposal's change is free-form JSON from the agent
type Change = Record<string, any>;

/** What a proposal changes, in plain terms. */
export function ChangeView({ lp }: { lp: LearningProposal }) {
  const c = (lp.change ?? {}) as Change;
  const skills = useSkills().data ?? [];
  const suites = useSuites().data ?? [];
  const agents = useAgents().data ?? [];
  const cat = useCatalog();
  const { projName, agName } = useLn();
  if (lp.kind === "skill") {
    const sk = skills.find((s) => s.id === c.skill);
    return (
      <div>
        <div className="small">Skill <strong>{sk ? sk.name : c.skill}</strong>{sk ? <span className="mono muted">{` v${sk.version}${lp.status === "proposed" ? " → next minor version" : ""}`}</span> : null}</div>
        <WordDiff a={c.before} b={c.after} />
      </div>
    );
  }
  if (lp.kind === "eval") {
    const su = suites.find((s) => s.id === c.suite);
    return <p className="small">Add case <strong>{`“${c.case?.name || lp.title}”`}</strong> to <span className="mono">{c.suite}</span>{su ? ` (${su.cases.length} cases now, gate ${fmt.pct(su.threshold)})` : ""}</p>;
  }
  if (lp.kind === "guideline") return <p className="small">{`Add to ${projName(c.project)} onboarding guidelines${c.item?.required ? " (required)" : ""}: `}<strong>{`“${c.item?.text || ""}”`}</strong></p>;
  if (lp.kind === "guardrail") {
    const a = agents.find((x) => x.id === c.agent);
    return <p className="small">{`${agName(c.agent)} must not touch `}<span className="mono">{c.path}</span>{a?.guardrails ? <span className="muted">{` (now: ${a.guardrails.paths.join(", ") || "none"})`}</span> : null}</p>;
  }
  if (lp.kind === "approver") {
    const g = cat?.gates.find((x) => x.id === c.gate);
    return <p className="small">{`${projName(c.project)} ${g ? g.label : c.gate}: add condition `}<strong>{`“${c.condition?.text || ""}”`}</strong></p>;
  }
  if (lp.kind === "route") {
    const st = cat?.stations.find((s) => s.id === c.addSkip);
    return <p className="small">{`${cat?.classes.find((k) => k.id === c.cls)?.name ?? c.cls} on ${projName(c.project)} skips `}<strong>{st ? st.name : c.addSkip}</strong></p>;
  }
  return <p className="small muted">No change details.</p>;
}

export function Pipeline({ lp }: { lp: LearningProposal }) {
  const steps = lp.status === "declined" ? ["proposed", "declined"] : lp.status === "rolled_back" ? ["proposed", "accepted", "rolled_back"] : ["proposed", "accepted", "verified"];
  const at = steps.indexOf(lp.status);
  return (
    <ol className="ln-pipe" aria-label={`Status: ${STATUS[lp.status] ?? lp.status}`}>
      {steps.map((s, i) => (
        <li key={s} className={`${i < at ? "is-done" : i === at ? "is-on" : ""}${s === "declined" || s === "rolled_back" ? " is-declined" : ""}`}>
          <span className="ln-pipe-dot" aria-hidden="true">{i < at ? "✓" : s === "declined" || s === "rolled_back" ? "×" : String(i + 1)}</span>
          {STATUS[s]}
        </li>
      ))}
    </ol>
  );
}


/** The prototype's plain before/after block for a skill edit. */
export function PlainDiff({ lp }: { lp: LearningProposal }) {
  const c = (lp.change ?? {}) as { before?: string; after?: string };
  return <div className="diff pre"><div className="d">{`− ${c.before ?? ""}`}</div><div className="a">{`+ ${c.after ?? ""}`}</div></div>;
}

/** The prototype's evidence link: the bare work order id in mono, a link to its record. */
export function WoLink({ id, project }: { id: string; project?: string | null }) {
  const open = useOpenRecordRoute();
  if (!/^WO-/.test(id)) return <span className="mono">{id}</span>;
  return <a className="pri mono" href="#record" onClick={(e) => { e.preventDefault(); open(id, project ?? undefined); }}>{id}</a>;
}
