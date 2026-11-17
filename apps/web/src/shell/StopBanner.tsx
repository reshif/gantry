/** Banner for a factory or project kill, or a project halt (legacy G.stopBanner). Null when running normally. */
import { fmt, type KillInfo } from "@gantry/domain";
import { useMe } from "../api/queries";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";

export function StopBanner({ projectId }: { projectId?: string | null }) {
  const me = useMe();
  const actor = useActors();
  if (!me) return null;
  const f = me.factory.killed as (KillInfo & { restoreApprovals?: unknown[] }) | null;
  const p = projectId ? me.projects.find((x) => x.id === projectId) : undefined;
  if (f) {
    const approvals = f.restoreApprovals?.length ?? 0;
    return (
      <div className="banner stop-banner is-kill" role="alert">
        <Icon name="st-kill" />
        <div>
          <strong>FACTORY KILLED</strong>
          {` · ${f.reason} · ${actor(f.by).name}, ${fmt.stamp(f.at)} · in-flight work ${f.mode === "cancel" ? "cancelled" : "held"}${approvals ? ` · restore approvals ${approvals}/2` : ""}`}
        </div>
      </div>
    );
  }
  if (p?.killed) {
    return (
      <div className="banner stop-banner is-kill" role="alert">
        <Icon name="st-kill" />
        <div>
          <strong>PROJECT KILLED</strong>
          {` · ${p.name}: ${p.killed.reason} · ${actor(p.killed.by).name}, ${fmt.stamp(p.killed.at)} · ${p.killed.mode === "cancel" ? "work cancelled" : "work held in place"}`}
        </div>
      </div>
    );
  }
  if (p?.halted) {
    return (
      <div className="banner stop-banner is-halt" role="status">
        <Icon name="halt" />
        <div>
          <strong>HALTED</strong>
          {` · ${p.name}: ${p.halted.reason} · ${actor(p.halted.by).name}, ${fmt.ist(p.halted.at)} IST`}
        </div>
      </div>
    );
  }
  return null;
}
