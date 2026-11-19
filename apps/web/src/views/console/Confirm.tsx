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
import { commands } from "../../api/commands";
import { useCommand } from "../../lib/useCommand";
import { runProposal } from "./api";
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

  const confirm = useCommand(commands.confirmProposal, { toastFail: false, ok: false });

  /** Shows an outcome. The server has already recorded done and failed on a saved card; only a dismissal is sent from here. */
  const finish = (status: "done" | "failed" | "dismissed", result: string, needs = ""): void => {
    const next: Proposal = { ...cur, status, result, ...(needs ? { needs } : {}) };
    setCur(next);
    onChange?.(next);
    if (serverId && status === "dismissed") void commands.dismissProposal(serverId, cur.id);
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
    // A saved card is run by the server (it calls the card's own endpoint as the person and records what happened); a slash-command card was never saved, so it is run directly.
    if (serverId) {
      setBusy(true);
      const r = await confirm.run(serverId, cur.id, { reason: reason.trim(), confirmText: typed, inFlight: mode });
      setBusy(false);
      if (!r) return;
      if (r.outcome === "done") {
        ui.toast(r.msg || "Done.", cur.danger ? "warn" : "ok");
        const id = r.result.id;
        if (typeof id === "string" && /^WO-/.test(id)) setWoId(id);
        finish("done", r.msg);
      } else if (r.outcome === "pending") {
        // Missing reason or phrase, 429, 5xx, or a confirm the server would not take: the card stays as it is so it can be fixed or tried again.
        setErr(r.retry ? `${r.msg}${r.needs ? ` (${r.needs})` : ""} You can try again.` : r.msg);
      } else {
        ui.toast(r.msg, "error");
        setFail({ msg: r.msg, needs: r.needs });
        finish("failed", r.msg, r.needs);
      }
      return;
    }
    setBusy(true);
    const r = await runProposal(cur, { reason: reason.trim(), confirmText: typed, inFlight: mode });
    setBusy(false);
    if (r.ok) {
      ui.toast(r.msg || "Done.", cur.danger ? "warn" : "ok");
      const id = (r as { id?: unknown }).id;
      if (typeof id === "string" && /^WO-/.test(id)) setWoId(id);
      finish("done", r.msg);
    } else {
      const needs = typeof r.needs === "string" ? r.needs : "";
      const st = r.status ?? 0;
      const transient = st === 0 || st === 409 || st === 429 || st >= 500;
      if (/reason|confirm/i.test(r.msg)) setErr(r.msg);
      else if (transient) setErr(`${r.msg}${needs ? ` (${needs})` : ""} You can try again.`);
      else {
        ui.toast(r.msg, "error");
        setFail({ msg: r.msg, needs });
        finish("failed", r.msg);
      }
    }
  };

  const retry = (): void => { setFail(null); setErr(""); { const { result: _old, ...rest } = cur; void _old; setCur({ ...rest, status: "pending" }); } };
  const first = cur.entities[0];
  const woOf = first?.type === "wo" ? first.id : /\/gate-instances\/(WO-[^:/]+)/.exec(cur.call.path)?.[1] ?? "";
  const staleBrief = cur.status === "failed" && /brief changed/i.test(cur.result ?? "") && !!woOf;
  const needsLine = fail?.needs || cur.needs || "";
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
          <span>{gate.allowed ? `You can do this. ${gate.reason}` : `You can't do this. ${gate.reason}${gate.needs ? ` Needs: ${gate.needs}.` : ""}`}</span>
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
          {needsLine ? <div className="perm neg" id={`con-cf-needs-${mid}-${cur.id}`}><Icon name="lock" /><span>{needsLine}</span></div> : null}
          <div className="ccard-actions">
            <Btn label="Try again" small kind="primary" icon="refresh" id={`con-cf-retry-${mid}-${cur.id}`} onClick={retry} />
            {staleBrief ? <Btn label={`Open the brief of ${woOf}`} small kind="primary" id={`con-cf-brief-${mid}-${cur.id}`} onClick={() => openTraveler(woOf, "brief")} /> : null}
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
          <Btn label={goVerb} kind={denied ? "quiet" : cur.danger ? "danger" : "primary"} small icon={denied ? "lock" : cur.danger ? "st-kill" : "check"} cls={denied ? "con-cf-locked" : undefined} id={`con-cf-ok-${mid}-${cur.id}`} guard={denied ? gate : null} disabledReason={busy ? "Working on it." : null} onClick={() => void run()} />
          <Btn label="Dismiss" small kind="ghost" id={`con-cf-no-${mid}-${cur.id}`} onClick={() => finish("dismissed", "")} />
        </div>
      ) : null}
    </div>
  );
}
