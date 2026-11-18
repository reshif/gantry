/**
 * The kill, restore and halt (andon) dialogs of legacy shared.js (G.killDialog, G.restoreDialog, G.haltDialog) as React.
 * The kill dialog shows what the kill would touch (GET /stops/impact, which needs the kill right) and who is told about it.
 * Every result comes from the API: a refusal is shown inline, never swallowed.
 */
import { qk } from "../api/keys";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { ops, type StopScope } from "../api/ops";
import { useKillImpact, useMe, useWorkOrder } from "../api/queries";
import { useProjectRepos } from "../views/floor/kit";
import { Dialog } from "../ui/Overlay";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { Field, LockNote, Segmented } from "../ui/primitives";
import { StepUpNotice, clearStepUpDraft, draftFor, isStepUp, registerStepUpDraft } from "../ui/stepup";
import type { CommandRefusal } from "../api/client";

type Scope = "factory" | "project" | "workorder";

interface PreviewItem {
  channel: string;
  target: string;
  deliverable: boolean;
  reason: string;
}

/** What the event would really reach, per project (GET .../routes/preview resolves each destination against the connected integrations, as the notifier does). */
function useNotifyPreview(event: "kill" | "restore", projectIds: string[]): PreviewItem[] {
  const qs = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: qk.notifyPreview(event, id),
      queryFn: () => get<{ items: PreviewItem[] }>(api(`projects/${encodeURIComponent(id)}/routes/preview`), { event }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const out = new Map<string, PreviewItem>();
  for (const q of qs) {
    for (const x of q.data?.items ?? []) {
      const k = `${x.channel} ${x.target}`;
      const prev = out.get(k);
      if (!prev || (!prev.deliverable && x.deliverable)) out.set(k, x);
    }
  }
  return [...out.values()].sort((a, b) => Number(b.deliverable) - Number(a.deliverable));
}

const missing = (x: PreviewItem): string => (/^no |removed/.test(x.reason) ? "not configured" : x.reason || "not configured");

function NotifyList({ items }: { items: PreviewItem[] }) {
  const live = items.filter((x) => x.deliverable);
  return (
    <div className="field" id="notify-list">
      <div className="field-label">Who gets notified</div>
      {items.length ? (
        <ul className="plain-list mono small">
          {items.map((x) => (
            <li key={`${x.channel} ${x.target}`} className={x.deliverable ? "" : "muted notify-off"} data-deliverable={x.deliverable ? "yes" : "no"}>
              {x.channel} {x.target}
              {x.deliverable ? null : (
                <>
                  {" "}
                  <span className="small">
                    {missing(x)} · <a href="#/integrations">set up in Integrations</a>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No notification routes are set for this event. Add one in Notifications.</p>
      )}
      {items.length && !live.length ? <p className="muted small">Nothing here is connected yet, so nobody will be told automatically. The event is still recorded in the audit log.</p> : null}
    </div>
  );
}

export function KillDialog({ scope, id, onClose }: { scope: Scope; id: string | null; onClose: () => void }) {
  const me = useMe();
  const ui = useUI();
  const wo = useWorkOrder(scope === "workorder" ? id : null).data;
  const projectId = scope === "project" ? id : scope === "workorder" ? (wo?.project ?? null) : null;
  const project = me?.projects.find((p) => p.id === projectId) ?? null;
  const d = useCan(`kill.${scope}`, projectId ? { project: projectId } : {});
  const imp = useKillImpact(scope, id, d.allowed && !d.pending && (scope === "factory" || !!id));
  const routes = useNotifyPreview("kill", scope === "factory" ? (me?.projects ?? []).map((p) => p.id) : projectId ? [projectId] : []);
  // a step-up round trip leaves what was typed in sessionStorage
  const saved = draftFor("kill", scope, id);
  const [reason, setReason] = useState(typeof saved?.reason === "string" ? saved.reason : "");
  const [mode, setMode] = useState<"hold" | "cancel">(saved?.mode === "cancel" ? "cancel" : "hold");
  const [confirm, setConfirm] = useState(typeof saved?.confirm === "string" ? saved.confirm : "");
  const [err, setErr] = useState("");
  const [step, setStep] = useState<CommandRefusal | null>(null);
  useEffect(() => registerStepUpDraft(() => ({ kind: "kill", scope, id, values: { reason, mode, confirm } })), [scope, id, reason, mode, confirm]);
  const close = () => {
    clearStepUpDraft();
    onClose();
  };
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  // The factory dialog asks for the prototype's short word; the server's own phrase for the factory goes with the request.
  const phrase = scope === "factory" ? "STOP" : scope === "project" ? (project?.name ?? "") : null;
  const sentPhrase = scope === "factory" ? "KILL FACTORY" : phrase;
  const label = scope === "factory" ? "the whole factory" : scope === "project" ? (project?.name ?? id ?? "") : (id ?? "");
  const impact = imp.data;
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < 5) {
      setErr("Give a reason of at least 5 characters.");
      return;
    }
    if (phrase && confirm !== phrase) {
      setErr(`Type ${phrase} exactly.`);
      return;
    }
    setBusy(true);
    const r = await ops.kill(scope as StopScope, scope === "factory" ? null : id, { reason: reason.trim(), mode, confirmText: phrase ? sentPhrase : null });
    setBusy(false);
    if (!r.ok) {
      if (isStepUp(r)) {
        setErr("");
        setStep(r);
      } else setErr(r.msg);
      return;
    }
    ui.toast(`Done: kill. ${r.msg}`, "error");
    close();
  };
  return (
    <Dialog
      title={scope === "workorder" ? `Kill ${id ?? ""}?` : scope === "factory" ? "Emergency stop the factory" : `Kill ${label}`}
      {...(scope === "workorder" ? { wide: true, sub: "The work order stops and cannot restart." } : {})}
      onClose={close}
      body={
        <div className="form-grid">
          <p style={{ marginBottom: 12 }}>{scope === "factory" ? "Every running agent is stopped immediately and no station will start new work. Work orders keep their place. Restoring needs two people." : `A kill is a hard stop. Agents stop, coding slots are freed, and new submissions are refused${scope === "workorder" ? " for this work order." : " until someone restores it."}`}</p>
          <LockNote decision={d.pending ? null : d} what="This kill switch" />
          <Field label="Reason" htmlFor="kill-reason" hint="Recorded in the audit ledger.">
            <input id="kill-reason" className="input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {phrase ? (
            <Field label={`Type ${phrase} to confirm`} htmlFor="kill-confirm">
              <input id="kill-confirm" className="input mono" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          ) : null}
          <details className="kill-more" id="kill-more">
            <summary className="small muted">What it reaches, in-flight work and who is told</summary>
            <p className="small" id="kill-impact">
              {`${scope === "factory" ? `${impact?.projects ?? "…"} projects, ` : ""}${impact?.workOrders ?? "…"} work orders in flight, ${impact?.running ?? "…"} running agents, ${impact?.slots ?? "…"} coding slots freed, ${impact?.prs ?? "…"} open PRs.`}
            </p>
            {scope !== "workorder" ? (
              <div className="field">
                <div className="field-label">In-flight work</div>
                <Segmented name="kill-mode" label="In-flight work" items={[{ id: "hold", label: "Hold in place (resumable)" }, { id: "cancel", label: "Cancel in-flight work" }]} value={mode} onChange={(v) => setMode(v === "cancel" ? "cancel" : "hold")} />
                <div className="field-hint">Hold keeps work where it is and resumes on restore. Cancel moves it to Killed, converts open PRs to drafts, and needs a restore per work order.</div>
              </div>
            ) : (
              <p className="muted small">The work order moves to Killed; its open PR becomes a draft. It stays killed unless someone permitted restores it.</p>
            )}
            <NotifyList items={routes} />
          </details>
          {step ? <StepUpNotice result={step} what="a kill" draft={{ kind: "kill", scope, id, values: { reason, mode, confirm } }} /> : null}
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: scope === "factory" ? "Stop everything" : scope === "workorder" ? "Kill" : "Kill project", kind: "danger", icon: "st-kill", submit: true, id: "kill-ok", guard: d.pending ? null : d, onClick: () => void submit() },
      ]}
    />
  );
}

export function RestoreDialog({ scope, id, onClose }: { scope: Scope; id: string | null; onClose: () => void }) {
  const me = useMe();
  const ui = useUI();
  const actor = useActors();
  const wo = useWorkOrder(scope === "workorder" ? id : null).data;
  const projectId = scope === "project" ? id : scope === "workorder" ? (wo?.project ?? null) : null;
  const project = me?.projects.find((p) => p.id === projectId) ?? null;
  const d = useCan(`restore.${scope}`, projectId ? { project: projectId } : {});
  const routes = useNotifyPreview("restore", scope === "factory" ? (me?.projects ?? []).map((p) => p.id) : projectId ? [projectId] : []);
  const saved = draftFor("restore", scope, id);
  const [reason, setReason] = useState(typeof saved?.reason === "string" ? saved.reason : "");
  const [err, setErr] = useState("");
  const [step, setStep] = useState<CommandRefusal | null>(null);
  useEffect(() => registerStepUpDraft(() => ({ kind: "restore", scope, id, values: { reason } })), [scope, id, reason]);
  const close = () => {
    clearStepUpDraft();
    onClose();
  };
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const k = scope === "factory" ? me.factory.killed : scope === "project" ? project?.killed : wo?.killed;
  const label = scope === "factory" ? "the factory" : scope === "project" ? (project?.name ?? id ?? "") : (id ?? "");
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < 5) {
      setErr("Give a reason of at least 5 characters.");
      return;
    }
    setBusy(true);
    const r = await ops.restore(scope as StopScope, scope === "factory" ? null : id, reason.trim());
    setBusy(false);
    if (!r.ok) {
      if (isStepUp(r)) {
        setErr("");
        setStep(r);
      } else setErr(r.msg);
      return;
    }
    ui.toast(`Done: restore. ${r.msg}`, "ok");
    close();
  };
  return (
    <Dialog
      title={scope === "factory" ? "Restore the factory" : `Restore ${label}`}
      onClose={close}
      body={
        <div className="form-grid">
          <p style={{ marginBottom: 12 }}>{`${k ? `Killed by ${actor(k.by).name} at ${fmt.stamp(k.at)}: ${k.reason}. ` : ""}Agents start picking up work again in station order.${scope === "factory" ? " Restoring the factory needs two Factory Admins." : ""}`}</p>
          <LockNote decision={d.pending ? null : d} what="Restoring" />
          <Field label="Reason" htmlFor="rsn-text">
            <textarea id="rsn-text" className="input" rows={3} placeholder="Why is it safe to restore?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <NotifyList items={routes} />
          <p className="muted small">Restoring always needs a fresh sign-in, and restoring the whole factory needs two Factory Admins when that is set in Security.</p>
          {step ? <StepUpNotice result={step} what="a restore" draft={{ kind: "restore", scope, id, values: { reason } }} /> : null}
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Restore", kind: "primary", submit: true, id: "rsn-ok", guard: d.pending ? null : d, onClick: () => void submit() }]}
    />
  );
}

export function HaltDialog({ scope, id, projectId, onClose }: { scope: "project" | "repo"; id: string; projectId: string; onClose: () => void }) {
  const me = useMe();
  const ui = useUI();
  const repos = useProjectRepos(scope === "repo" ? projectId : null);
  const d = useCan("line.halt", { project: projectId });
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const project = me.projects.find((p) => p.id === projectId);
  const name = scope === "repo" ? (repos.find((r) => r.id === id)?.name ?? id) : (project?.name ?? id);
  const min = scope === "project" && project?.regulated ? 20 : 4;
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < min) {
      setErr(`Give a reason of at least ${min} characters.`);
      return;
    }
    setBusy(true);
    const r = scope === "repo" ? await ops.haltRepo(id, reason.trim()) : await ops.haltProject(id, reason.trim());
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    ui.toast(`Done: halt. ${r.msg}`, "warn");
    onClose();
  };
  return (
    <Dialog
      title={scope === "project" ? "Halt the line" : `Halt ${name}`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <p style={{ marginBottom: 12 }}>{scope === "project" ? "Running agents finish their current step; nothing new starts until the line is resumed." : "A soft, resumable pause. Agents on this repo stop at their current step until someone resumes it."}</p>
          <LockNote decision={d.pending ? null : d} what="The andon cord" />
          <Field label={<>Reason<span className="muted"> (required)</span></>} htmlFor="rsn-text" hint="Recorded in the audit ledger.">
            <input id="rsn-text" className="input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: scope === "project" ? "Halt line" : "Halt repo", kind: "danger", submit: true, id: "rsn-ok", guard: d.pending ? null : d, onClick: () => void submit() }]}
    />
  );
}
