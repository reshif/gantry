/**
 * The kill, restore and halt (andon) dialogs of legacy shared.js (G.killDialog, G.restoreDialog, G.haltDialog) as React.
 * The kill dialog shows what the kill would touch (GET /stops/impact, which needs the kill right) and who is told about it.
 * Every result comes from the API: a refusal is shown inline, never swallowed.
 */
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
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

type Scope = "factory" | "project" | "workorder";

interface KillRoute {
  enabled?: boolean;
  event?: string;
  dest?: Array<{ channel: string; target: string }>;
}

/** Notification routes for the kill event of the projects a kill touches. A project whose routes cannot be read adds none. */
function useKillRoutes(projectIds: string[]): string[] {
  const qs = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ["notifications", "kill-routes", id],
      queryFn: () => get<KillRoute[] | { items: KillRoute[] }>(api(`projects/${encodeURIComponent(id)}/routes`)),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const out: string[] = [];
  for (const q of qs) {
    const d = q.data;
    const rows = Array.isArray(d) ? d : (d?.items ?? []);
    for (const r of rows) {
      if (!r.enabled || r.event !== "kill") continue;
      for (const x of r.dest ?? []) {
        const s = `${x.channel} ${x.target}`;
        if (!out.includes(s)) out.push(s);
      }
    }
  }
  return out;
}

const Impact = ({ label, value }: { label: string; value: number | undefined }) => (
  <div>
    <dt>{label}</dt>
    <dd>{value === undefined ? "…" : String(value)}</dd>
  </div>
);

export function KillDialog({ scope, id, onClose }: { scope: Scope; id: string | null; onClose: () => void }) {
  const me = useMe();
  const ui = useUI();
  const wo = useWorkOrder(scope === "workorder" ? id : null).data;
  const projectId = scope === "project" ? id : scope === "workorder" ? (wo?.project ?? null) : null;
  const project = me?.projects.find((p) => p.id === projectId) ?? null;
  const d = useCan(`kill.${scope}`, projectId ? { project: projectId } : {});
  const imp = useKillImpact(scope, id, d.allowed && !d.pending && (scope === "factory" || !!id));
  const routes = useKillRoutes(scope === "factory" ? (me?.projects ?? []).map((p) => p.id) : projectId ? [projectId] : []);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"hold" | "cancel">("hold");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const phrase = scope === "factory" ? "KILL FACTORY" : scope === "project" ? (project?.name ?? "") : null;
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
    const r = await ops.kill(scope as StopScope, scope === "factory" ? null : id, { reason: reason.trim(), mode, confirmText: phrase ? confirm : null });
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
      title={`Kill ${label}`}
      kicker={`Kill switch · ${scope}`}
      wide
      sub={`A kill is a hard stop. Agents stop, coding slots are freed, and new submissions are refused${scope === "workorder" ? " for this work order." : " until someone restores it."}`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d.pending ? null : d} what="This kill switch" />
          <dl className="titleblock kill-impact">
            {scope === "factory" ? <Impact label="Projects" value={impact?.projects} /> : null}
            <Impact label="Work orders in flight" value={impact?.workOrders} />
            <Impact label="Running agents" value={impact?.running} />
            <Impact label="Coding slots freed" value={impact?.slots} />
            <Impact label="Open PRs" value={impact?.prs} />
          </dl>
          <Field label="Reason (required)" htmlFor="kill-reason">
            <textarea id="kill-reason" className="input" rows={3} placeholder="What is happening? This is posted to the notification routes." value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {scope !== "workorder" ? (
            <div className="field">
              <div className="field-label">In-flight work</div>
              <Segmented name="kill-mode" label="In-flight work" items={[{ id: "hold", label: "Hold in place (resumable)" }, { id: "cancel", label: "Cancel in-flight work" }]} value={mode} onChange={(v) => setMode(v === "cancel" ? "cancel" : "hold")} />
              <div className="field-hint">Hold keeps work where it is and resumes on restore. Cancel moves it to Killed, converts open PRs to drafts, and needs a restore per work order.</div>
            </div>
          ) : (
            <p className="muted small">The work order moves to Killed; its open PR becomes a draft. It stays killed unless someone permitted restores it.</p>
          )}
          <div className="field">
            <div className="field-label">Who gets notified</div>
            {routes.length ? (
              <ul className="plain-list mono small">
                {routes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No kill routes configured. Add one in Notifications.</p>
            )}
          </div>
          {phrase ? (
            <Field label={`Type ${phrase} to confirm`} htmlFor="kill-confirm">
              <input id="kill-confirm" className="input mono" autoComplete="off" placeholder={phrase} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          ) : null}
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: `Kill ${scope === "workorder" ? (id ?? "") : scope === "project" ? "project" : "factory"}`, kind: "danger", icon: "st-kill", submit: true, id: "kill-ok", guard: d.pending ? null : d, onClick: () => void submit() },
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
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
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
      setErr(r.msg);
      return;
    }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Restore ${label}`}
      kicker="Kill switch · restore"
      sub={`${k ? `Killed by ${actor(k.by).name} at ${fmt.stamp(k.at)}: ${k.reason}. ` : ""}${scope === "factory" ? "Restoring the factory needs two Factory Admins." : ""}`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d.pending ? null : d} what="Restoring" />
          <Field label="Reason" htmlFor="rsn-text">
            <textarea id="rsn-text" className="input" rows={3} placeholder="Why is it safe to restore?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
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
