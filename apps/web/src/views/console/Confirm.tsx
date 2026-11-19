import { useState } from "react";
import { Btn, Field, Segmented } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useOpenRecordRoute } from "../record/nav";
import { EntityChip } from "./Chips";
import { ExplainDenial } from "./ExplainDenial";
import { runProposal, saveProposal } from "./api";
import type { Proposal } from "./types";

const pill = (label: string, on: boolean) => <span key={label} className={`step-pill${on ? " is-on" : ""}`}>{label}</span>;

/**
 * A proposed action as a confirm card (legacy G.proposalCard and the console's confirm cards). Nothing has run: confirming calls the ordinary endpoint
 * under the person's own permissions. A card the decision point already refuses shows why, offers "Explain", and cannot be confirmed.
 */
export function ProposalCard({ p, mid, serverId, onChange }: { p: Proposal; mid: string; serverId?: string | undefined; onChange?: (p: Proposal) => void }) {
  const ui = useUI();
  const openTraveler = useOpenTraveler();
  const openRecord = useOpenRecordRoute();
  const [cur, setCur] = useState<Proposal>(p);
  const [reason, setReason] = useState(String(p.call.body.reason ?? ""));
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState("hold");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [woId, setWoId] = useState("");
  /** Why the server refused, and what it says would let it through; kept after the card fails so the way forward is shown. */
  const [fail, setFail] = useState<{ msg: string; needs: string } | null>(null);
  const pending = cur.status === "pending";
  const gate = pending ? cur.check : null;
  const denied = !!gate && !gate.allowed;

  const finish = (status: "done" | "failed" | "dismissed", result: string): void => {
    const next = { ...cur, status, result };
    setCur(next);
    onChange?.(next);
    if (serverId) void saveProposal(serverId, cur, status, result);
  };

  const run = async (): Promise<void> => {
    if (!pending || denied) return;
    if (cur.needsReason !== null && reason.trim().length < cur.needsReason) {
      setErr(`Give a reason of at least ${cur.needsReason} characters.`);
      return;
    }
    if (cur.phrase && typed !== cur.phrase) {
      setErr(`Type ${cur.phrase} exactly to confirm.`);
      return;
    }
    setErr("");
    setBusy(true);
    const r = await runProposal(cur, { reason: reason.trim(), confirmText: typed, inFlight: mode });
    setBusy(false);
    if (r.ok) {
      ui.toast(r.msg || "Done.", cur.danger ? "warn" : "ok");
      const id = (r as { id?: unknown }).id;
      if (typeof id === "string" && /^WO-/.test(id)) setWoId(id);
      finish("done", r.msg);
    } else {
      // A reason or confirmation the server wants more of stays on the card so it can be fixed; any other refusal ends it.
      const needs = !r.ok && typeof r.needs === "string" ? r.needs : "";
      const status = r.status ?? 0;
      const transient = status === 0 || status === 409 || status === 429 || status >= 500;
      if (/reason|confirm/i.test(r.msg)) setErr(r.msg);
      else if (transient) setErr(`${r.msg}${needs ? ` (${needs})` : ""} You can try again.`);
      else {
        ui.toast(r.msg, "error");
        setFail({ msg: r.msg, needs });
        finish("failed", r.msg);
      }
    }
  };

  const retry = (): void => { setFail(null); setErr(""); setCur({ ...cur, status: "pending" }); };
  const first = cur.entities[0];
  const openIt = first?.type === "wo" ? () => openRecord(first.id, first.project ?? null) : first?.type === "project" ? () => { setProject(first.id); navigate("floor"); } : cur.perm.project ? () => { setProject(cur.perm.project ?? ""); navigate("floor"); } : null;
  const steps = cur.steps.filter(Boolean);
  const goVerb = cur.kind === "kill" ? `Kill ${cur.title.replace(/^Kill /, "")}` : cur.kind === "restore" ? "Restore" : "Confirm and run";
  return (
    <div className={`ccard ccard-confirm is-${cur.status}${cur.danger ? " is-danger" : ""}`} id={`prop-${mid}-${cur.id}`}>
      <div className="ccard-steps">{pill("Plan", true)}{pill("Confirm", cur.status !== "pending" && cur.status !== "dismissed")}{pill("Done", cur.status === "done")}</div>
      <div className="ccard-title">{cur.danger ? <Icon name="st-kill" /> : null}{cur.title}</div>
      {cur.summary ? <p className="prop-sum">{cur.summary}</p> : null}
      {cur.entities.length ? <div className="chips">{cur.entities.map((e) => <EntityChip key={`${e.type}:${e.id}`} e={e} />)}</div> : null}
      {steps.length ? <ol className="bullets">{steps.map((x) => <li key={x}>{x}</li>)}</ol> : null}
      {gate ? (
        <div className={`perm ${gate.allowed ? "pos" : "neg"}`}>
          <Icon name={gate.allowed ? "check" : "lock"} />
          <span>{gate.allowed ? `You can do this. ${gate.reason}` : `You can't do this: ${gate.needs ? `${gate.needs}. ` : ""}${gate.reason}`}</span>
        </div>
      ) : null}
      {denied ? <ExplainDenial id={`con-cf-explain-${mid}-${cur.id}`} action={cur.perm.action} project={cur.perm.project ?? null} /> : null}
      {pending && !denied && (cur.needsReason !== null || cur.phrase || cur.kind === "kill") ? (
        <div className="con-cf-fields">
          {cur.needsReason !== null ? <Field label="Reason (required)" htmlFor={`con-cf-reason-${mid}-${cur.id}`}><input id={`con-cf-reason-${mid}-${cur.id}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={cur.kind === "kill" ? "What is happening? Posted to the kill routes." : "Reason"} autoComplete="off" /></Field> : null}
          {cur.kind === "kill" && cur.call.body.scope !== "workorder" ? <div className="field"><div className="field-label">In-flight work</div><Segmented name={`con-cf-mode-${mid}-${cur.id}`} items={[{ id: "hold", label: "Hold in place" }, { id: "cancel", label: "Cancel to Killed" }]} value={mode} onChange={setMode} label="In-flight work" /></div> : null}
          {cur.phrase ? <Field label={`Type ${cur.phrase} to confirm`} htmlFor={`con-cf-confirm-${mid}-${cur.id}`}><input id={`con-cf-confirm-${mid}-${cur.id}`} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={cur.phrase} autoComplete="off" /></Field> : null}
        </div>
      ) : null}
      {err ? <div className="form-err" role="alert">{err}</div> : null}
      {cur.result ? <div className={`perm ${cur.status === "done" ? "pos" : "neg"}`}><Icon name={cur.status === "done" ? "check" : "x"} /><span>{cur.result}</span></div> : null}
      {cur.status === "failed" ? (
        <>
          {fail?.needs ? <div className="perm neg" id={`con-cf-needs-${mid}-${cur.id}`}><Icon name="lock" /><span>{fail.needs}</span></div> : null}
          <div className="ccard-actions">
            <Btn label="Try again" small kind="primary" icon="refresh" id={`con-cf-retry-${mid}-${cur.id}`} onClick={retry} />
            {openIt ? <Btn label={first?.type === "wo" ? `Open ${first.id}` : "Open the screen"} small id={`con-cf-open-${mid}-${cur.id}`} onClick={openIt} /> : null}
          </div>
        </>
      ) : null}
      {cur.status === "done" && woId ? (
        <div className="ccard-actions">
          <Btn label={`Open ${woId}`} small id={`con-cf-wo-${mid}-${cur.id}`} onClick={() => openTraveler(woId)} />
          <Btn label="Answer the intake questions" small kind="primary" icon="chat" id={`con-cf-conv-${mid}-${cur.id}`} onClick={() => { if (cur.perm.project) setProject(cur.perm.project); navigate("conversations", woId); }} />
        </div>
      ) : null}
      {cur.status === "dismissed" ? <div className="muted small">Dismissed. Nothing changed.</div> : null}
      {pending ? (
        <div className="ccard-actions">
          <Btn label={goVerb} kind={cur.danger ? "danger" : "primary"} small icon={cur.danger ? "st-kill" : "check"} id={`con-cf-ok-${mid}-${cur.id}`} guard={denied ? gate : null} disabledReason={busy ? "Working on it." : null} onClick={() => void run()} />
          <Btn label="Dismiss" small kind="ghost" id={`con-cf-no-${mid}-${cur.id}`} onClick={() => finish("dismissed", "")} />
        </div>
      ) : null}
    </div>
  );
}
