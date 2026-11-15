/**
 * Governed web research in the workspace (Phase 2): the research plan a station proposes and a person decides, and the sources the agents read.
 * The plan says what the research will answer, which web hosts it may read and what it may spend; nothing on the web is read until it is
 * approved, and then only those hosts. A host off the factory's research allow-list needs someone who manages security.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { decideResearchPlan, useWoSource, type ResearchState, type Source } from "./api";

const station = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function ResearchPlanCard({ woId, r }: { woId: string; r: ResearchState }) {
  const ui = useUI();
  const plan = r.plan;
  const [hosts, setHosts] = useState<string[]>(plan?.hosts ?? []);
  const [web, setWeb] = useState(plan?.web ?? false);
  const [budget, setBudget] = useState(plan?.budgetUsd ? String(plan.budgetUsd) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!plan) return null;
  const listed = new Set(r.allowList);
  const open = plan.status === "proposed";
  const blocked = web ? hosts.filter((h) => !listed.has(h) && !r.canApproveUnlisted) : [];
  const budgetN = budget.trim() ? Number(budget) : null;
  const budgetBad = budget.trim() !== "" && (!Number.isFinite(budgetN) || (budgetN ?? 0) <= 0 || (budgetN ?? 0) > 100);
  const run = async (decision: "approve" | "reject") => {
    setBusy(true);
    const res = await decideResearchPlan(woId, decision === "approve" ? { decision, web, hosts: web ? hosts : [], budgetUsd: budgetN, ...(note.trim() ? { note: note.trim() } : {}) } : { decision, note: note.trim() });
    setBusy(false);
    ui.toast(res.msg, res.ok ? "ok" : "error");
  };
  return (
    <article className={`osx-card rp-card is-${plan.status}`} id="rp-card" aria-label="Research plan">
      <header className="osx-card-h">
        <strong>{`Research plan from ${station(plan.station)}`}</strong>
        <span className="osx-status">{open ? "Waiting for approval" : plan.status === "approved" ? "Approved" : "Rejected"}</span>
      </header>
      {plan.why ? <p className="small rp-why">{plan.why}</p> : null}
      <div className="rp-sec">
        <span className="kicker">Questions it will answer</span>
        <ol className="small rp-qs">{plan.questions.map((q) => <li key={q}>{q}</li>)}</ol>
      </div>
      <div className="rp-sec">
        <span className="kicker">Web hosts</span>
        {open && r.canDecide ? (
          <>
            <label className="small rp-web"><input type="checkbox" id="rp-web" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Allow reading the web</label>
            {web ? (
              <ul className="rp-hosts">
                {plan.hosts.map((h) => {
                  const on = hosts.includes(h);
                  const ok = listed.has(h) || r.canApproveUnlisted;
                  return (
                    <li key={h}>
                      <label className="small"><input type="checkbox" checked={on} onChange={() => setHosts(on ? hosts.filter((x) => x !== h) : [...hosts, h])} /> <span className="mono">{h}</span></label>
                      <span className={`small rp-host-note${listed.has(h) ? "" : " is-unlisted"}`}>{listed.has(h) ? "on the factory list" : ok ? "not on the factory list: you may approve it" : "not on the factory list: needs someone who manages security"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="small muted">Repository only: the agent reads no web pages.</p>}
          </>
        ) : plan.web && plan.hosts.length ? <p className="small mono rp-host-list">{plan.hosts.join(" · ")}</p> : <p className="small muted">No web: repository only.</p>}
      </div>
      <div className="rp-sec">
        <span className="kicker">Budget</span>
        {open && r.canDecide ? (
          <label className="small rp-budget">US$ <input className="input" id="rp-budget" inputMode="decimal" value={budget} placeholder="no cap of its own" onChange={(e) => setBudget(e.target.value)} aria-invalid={budgetBad} /></label>
        ) : <p className="small">{plan.budgetUsd ? fmt.money(plan.budgetUsd) : "The agent's own budget"}</p>}
      </div>
      {open ? (
        r.canDecide ? (
          <div className="osx-ask">
            <label className="small" htmlFor="rp-note">Note (needed to reject)</label>
            <textarea id="rp-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="osx-actions">
              <Btn kind="primary" small id="rp-approve" label="Approve plan" disabled={busy || budgetBad || (web && !hosts.length) || blocked.length > 0} disabledReason={blocked.length ? `${blocked.join(", ")} needs someone who manages security.` : web && !hosts.length ? "Pick at least one host, or untick the web." : budgetBad ? "Budget is a positive amount up to 100." : undefined} onClick={() => void run("approve")} />
              <Btn small id="rp-reject" label="Reject" disabled={busy || note.trim().length < 3} disabledReason={note.trim().length < 3 ? "Say why in the note." : undefined} onClick={() => void run("reject")} />
            </div>
          </div>
        ) : <p className="small muted">Someone who may approve gates on this project decides the plan.</p>
      ) : (
        <p className="small rp-decided">{plan.status === "approved" ? "Approved" : "Rejected"}<span className="muted">{" — "}</span><Who id={plan.decidedBy} />{plan.decidedAt ? <span className="muted">{`, ${fmt.stamp(plan.decidedAt)}`}</span> : null}{plan.note ? <span>{`: ${plan.note}`}</span> : null}</p>
      )}
    </article>
  );
}

/** One source: where it came from, when, why it was read, and the text the agent saw (the snapshot). */
export function SourceDetail({ woId, refId, onClose }: { woId: string; refId: string; onClose?: () => void }) {
  const q = useWoSource(woId, refId);
  const s = q.data;
  const [full, setFull] = useState(false);
  if (!s) return <Async query={q} what="the source" id="src-detail">{() => null}</Async>;
  return (
    <section className="src-detail" id="src-detail" aria-label={`Source ${s.ref}`}>
      <header className="src-detail-h">
        <span className="md-cite is-static">{s.ref}</span>
        <strong className="src-title">{s.title || s.host}</strong>
        {onClose ? <Btn small kind="ghost" icon="x" label="Close source" onClick={onClose} /> : null}
      </header>
      <p className="small src-url"><a href={s.finalUrl} target="_blank" rel="noopener noreferrer nofollow">{s.finalUrl}</a></p>
      <p className="small muted">{`Read by ${station(s.station)} · ${fmt.stamp(s.fetchedAt)} · HTTP ${s.httpStatus ?? "?"} · ${fmt.num(s.size)} bytes${s.truncated ? " · cut at the size limit" : ""}`}</p>
      {s.why ? <p className="small"><span className="muted">Why: </span>{s.why}</p> : null}
      <button type="button" className="linkish small" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Hide what the agent saw" : "Show what the agent saw"}</button>
      {full ? <pre className="src-excerpt" aria-label="Text the agent read">{s.excerpt}</pre> : null}
    </section>
  );
}

export function SourceList({ items, pick }: { items: Source[]; pick: (ref: string) => void }) {
  if (!items.length) return <p className="small muted">No web pages were read on this work order.</p>;
  return (
    <ul className="src-list" id="src-list">
      {items.map((s) => (
        <li key={s.ref}>
          <button type="button" className="md-cite" onClick={() => pick(s.ref)} aria-label={`Source ${s.ref}`}>{s.ref}</button>
          <span className="src-li-t">{s.title || s.host}</span>
          <span className="small muted mono src-li-h">{s.host}</span>
        </li>
      ))}
    </ul>
  );
}
