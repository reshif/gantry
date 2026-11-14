/**
 * Who may approve this gate (spec 9.3), in the traveler and in the work-order session: the rule in plain words, the progress with who approved, the people the rule actually
 * reaches, a warning when the gate cannot pass as configured, and the ways out (edit the rule, grant a role, approve as a Factory Admin override). Read from
 * GET /work-orders/{id}/gates/{gate}/approvers (default deny: project.view).
 */
import { useQuery } from "@tanstack/react-query";
import type { GateApprovers } from "@gantry/domain";
import { api, get } from "../../api/client";
import { ops } from "../../api/ops";
import { Btn } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";

export interface ApproversRead extends GateApprovers {
  viewerCanOverride: boolean;
  can: { editRule: boolean; editWhy: string; grantRole: boolean; grantWhy: string };
}
export const useGateApprovers = (woId: string, gate: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "approvers", woId, gate ?? ""], queryFn: () => get<ApproversRead>(api(`work-orders/${encodeURIComponent(woId)}/gates/${encodeURIComponent(gate ?? "")}/approvers`)), enabled: !!gate });

export function ApproversPanel({ woId, gate, project, onNavigate }: { woId: string; gate: string; project: string; onNavigate?: () => void }) {
  const q = useGateApprovers(woId, gate);
  const ui = useUI();
  const a = q.data;
  if (!a) return q.isError ? null : <p className="muted small" role="status">Loading approvers…</p>;
  const go = (route: string, param?: string) => { onNavigate?.(); navigate(route, param ?? null, route === "project-config" ? project : undefined); };
  return (
    <section className="apr-panel" id="apr-panel" aria-label={`Who may approve ${a.label}`}>
      <h3 className="sub-h">{`Who may approve ${a.label}`}</h3>
      <p className="small" id="apr-rule">{a.rule.text}</p>
      {a.rule.conditions.length ? <p className="small muted">{`Also: ${a.rule.conditions.join("; ")}`}</p> : null}
      <p className="small" id="apr-progress"><strong>{`${a.progress.have}/${a.progress.need}`}</strong>{a.progress.approvals.length ? ` approved by ${a.progress.approvals.map((x) => x.name).join(", ")}` : " approved so far"}{a.progress.unmet.length ? `; still needs: ${a.progress.unmet.join("; ")}` : ""}</p>
      {!a.satisfiable ? <div className="callout callout-warn small" role="alert" id="apr-warning">{a.warning}</div> : null}
      <p className="small"><strong>{`Eligible (${a.eligible.length})`}</strong></p>
      {a.eligible.length ? <ul className="small apr-list" id="apr-eligible">{a.eligible.map((e) => <li key={e.id}>{e.name}{e.away ? <span className="muted"> · away</span> : null}{e.oncall ? <span className="muted"> · on call</span> : null}<span className="muted">{` · ${e.why}`}</span></li>)}</ul> : <p className="small muted">Nobody is eligible today.</p>}
      {a.overrides.length ? <p className="small muted">{`Factory Admins may approve as an override with a reason (audited): ${a.overrides.map((o) => o.name).join(", ")}.`}</p> : null}
      <div className="osx-actions">
        <Btn small id="apr-edit-rule" label="Edit rule" disabled={!a.can.editRule} disabledReason={!a.can.editRule ? a.can.editWhy || "You may not edit approver rules." : undefined} onClick={() => go("project-config", `approvers/${gate}`)} />
        <Btn small id="apr-grant" label="Grant a role" disabled={!a.can.grantRole} disabledReason={!a.can.grantRole ? a.can.grantWhy || "You may not grant roles." : undefined} onClick={() => go("people")} />
        {a.viewerCanOverride ? <Btn small kind="primary" id="apr-override" label="Approve as override" onClick={async () => { const r = await ops.approveGate(woId, gate); ui.toast(r.msg, r.ok ? "ok" : "error"); }} /> : null}
      </div>
    </section>
  );
}
