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
import { CrIcon } from "../ui/cr";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { Field, LockNote } from "../ui/primitives";
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
  // a step-up round trip leaves what was typed in sessionStorage
  const saved = draftFor("kill", scope, id);
  const [reason, setReason] = useState(typeof saved?.reason === "string" ? saved.reason : "");
  const mode = "hold" as const; // the prototype offers no cancel mode: in-flight work is held in place and resumes on restore
  const [confirm, setConfirm] = useState(typeof saved?.confirm === "string" ? saved.confirm : "");
  const [err, setErr] = useState("");
  const [fe, setFe] = useState<{ reason?: string; confirm?: string }>({});
  const [step, setStep] = useState<CommandRefusal | null>(null);
  useEffect(() => registerStepUpDraft(() => ({ kind: "kill", scope, id, values: { reason, mode, confirm } })), [scope, id, reason, mode, confirm]);
  const close = () => {
    clearStepUpDraft();
    onClose();
  };
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  // The person types the prototype's word; the API's own confirmation (the factory phrase, the project name) is sent with it.
  const CONFIRM_WORD = "STOP";
  const apiPhrase = scope === "factory" ? "KILL FACTORY" : scope === "project" ? (project?.name ?? "") : null;
  const label = scope === "factory" ? "the whole factory" : scope === "project" ? (project?.name ?? id ?? "") : (id ?? "");
  const impact = imp.data;
  const submit = async () => {
    if (busy) return;
    // the prototype's checks: every invalid field is named at once and focus goes to the first
    const bad: { reason?: string; confirm?: string } = {};
    if (!reason.trim()) bad.reason = "Reason is required.";
    else if (reason.trim().length < 10) bad.reason = "Reason needs at least 10 characters.";
    if (!confirm) bad.confirm = "Type STOP to confirm is required.";
    else if (confirm !== CONFIRM_WORD) bad.confirm = "Type STOP in capitals.";
    setFe(bad);
    if (bad.reason || bad.confirm) {
      setErr("");
      setTimeout(() => document.getElementById(bad.reason ? "kill-reason" : "kill-confirm")?.focus(), 0);
      return;
    }
    setBusy(true);
    const r = await ops.kill(scope as StopScope, scope === "factory" ? null : id, { reason: reason.trim(), mode, confirmText: apiPhrase });
    setBusy(false);
    if (!r.ok) {
      if (isStepUp(r)) {
        setErr("");
        setStep(r);
      } else setErr(r.msg);
      return;
    }
    ui.toast(`Emergency stop applied to ${label}`, "error");
    close();
  };
  return (
    <Dialog
      title={`Emergency stop: ${label}`}
      cls="dlg-plain"
      sub={`Stops agents immediately and blocks new work. Restoring needs ${scope === "factory" ? "two Factory Admins" : scope === "project" ? "a Project Admin" : "someone permitted to restore it"}.`}
      onClose={close}
      body={
        <>
          <LockNote decision={d.pending ? null : d} what="This emergency stop" />
          <div className="banner bad" id="kill-banner">
            <CrIcon name="stop" />
            <div className="grow">
              {impact?.workOrders != null ? `${impact.workOrders} work order${impact.workOrders === 1 ? "" : "s"} in flight ` : "Work orders in flight "}
              will pause at their current station. Nothing is deleted.
            </div>
          </div>
          <Field label="Reason" required error={fe.reason} hint="Recorded in the audit ledger." htmlFor="kill-reason">
            <textarea id="kill-reason" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Type STOP to confirm" required error={fe.confirm} htmlFor="kill-confirm">
            <input id="kill-confirm" className="input mono" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {step ? <StepUpNotice result={step} what="a kill" draft={{ kind: "kill", scope, id, values: { reason, mode, confirm } }} /> : null}
          <div className="form-err" role="alert">
            {err}
          </div>
        </>
      }
      actions={[
        { label: "Cancel" },
        { label: "Stop now", kind: "danger solid", submit: true, id: "kill-ok", guard: d.pending ? null : d, onClick: () => void submit() },
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
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog
      title={`Restore ${label}`}
      kicker="Kill switch · restore"
      sub={`${k ? `Killed by ${actor(k.by).name} at ${fmt.stamp(k.at)}: ${k.reason}. ` : ""}${scope === "factory" ? "Restoring the factory needs two Factory Admins." : ""}`}
      onClose={close}
      body={
        <div className="form-grid">
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
    ui.toast(r.msg, "warn");
    onClose();
  };
  return (
    <Dialog
      title={`Pull the andon cord on ${name}`}
      kicker={`Andon · ${scope}`}
      sub={`A soft, resumable pause. Agents on this ${scope} stop at their current step until someone resumes it. Use a kill for a hard stop.`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d.pending ? null : d} what="The andon cord" />
          <Field label="Reason" htmlFor="rsn-text">
            <textarea id="rsn-text" className="input" rows={3} placeholder="What did you see?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: `Halt ${scope}`, kind: "danger", submit: true, id: "rsn-ok", guard: d.pending ? null : d, onClick: () => void submit() }]}
    />
  );
}
