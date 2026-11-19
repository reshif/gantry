/**
 * Banners of the blueprint shell: factory emergency stop (with Restore), a halted line (on every screen),
 * and the read-only note. Null when the line runs normally.
 */
import { fmt, type KillInfo } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { Icon } from "../ui/Icon";
import { Btn } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { makeStopActions } from "./stopActions";
import { useReadOnly } from "./Nav";
import { updatePrefs, usePrefs } from "../lib/prefs";

export function StopBanner({ projectId }: { projectId?: string | null }) {
  const me = useMe();
  const actor = useActors();
  const ui = useUI();
  const restore = useCan("restore.factory");
  if (!me) return null;
  const f = me.factory.killed as (KillInfo & { restoreApprovals?: unknown[] }) | null;
  const p = projectId ? me.projects.find((x) => x.id === projectId) : undefined;
  if (f) {
    const approvals = f.restoreApprovals?.length ?? 0;
    return (
      <div className="banner stop-banner is-kill" role="alert">
        <Icon name="stop" />
        <div>
          <strong>Factory emergency stop is active.</strong>
          {` ${f.reason} · ${actor(f.by).name}, ${fmt.stamp(f.at)} · in-flight work ${f.mode === "cancel" ? "cancelled" : "held"}${approvals ? ` · restore approvals ${approvals}/2` : ""}`}
        </div>
        {!restore.pending && restore.allowed ? <Btn label="Restore" small id="banner-restore" onClick={() => makeStopActions(ui, me).restore("factory", null)} /> : null}
      </div>
    );
  }
  if (p?.killed) {
    return (
      <div className="banner stop-banner is-kill" role="alert">
        <Icon name="stop" />
        <div>
          <strong>PROJECT KILLED</strong>
          {` · ${p.name}: ${p.killed.reason} · ${actor(p.killed.by).name}, ${fmt.stamp(p.killed.at)} · ${p.killed.mode === "cancel" ? "work cancelled" : "work held in place"}`}
        </div>
      </div>
    );
  }
  // a halted line shows on every screen: the scoped project first, else the first halted project the person sees
  const h = p?.halted ? p : me.projects.find((x) => x.halted);
  if (h?.halted) {
    return (
      <div className="banner stop-banner is-halt" role="status">
        <Icon name="pause" />
        <div>
          {`The line is halted: ${h.halted.reason}`}
          <span className="muted small">{` · ${h.name} · ${actor(h.halted.by).name}, ${fmt.ist(h.halted.at)} IST`}</span>
        </div>
      </div>
    );
  }
  return null;
}

/** Accent banner shown when the server allows this session no mutating action. */
export function ReadOnlyBanner() {
  if (!useReadOnly()) return null;
  return (
    <div className="banner banner-readonly">
      <Icon name="lock" />
      Read-only viewer: mutating controls are disabled.
    </div>
  );
}

const VIEW_AS_LABEL: Record<string, string> = { approver: "Approver", viewer: "Read-only viewer" };

/** Shown on every screen while a "View as" preview is on, so a preview (which is kept in prefs) can never pass for the person's real rights. */
export function ViewAsBanner() {
  const viewAs = usePrefs().viewAs;
  if (!viewAs) return null;
  return (
    <div className="banner banner-readonly banner-viewas" id="viewas-banner" role="status">
      <Icon name="user" />
      <div>
        <strong>{`Viewing as ${VIEW_AS_LABEL[viewAs] ?? viewAs}.`}</strong>
        {" You are previewing fewer rights than you hold; the server still decides every command."}
      </div>
      <Btn label="Stop viewing as" small id="viewas-stop" onClick={() => updatePrefs({ viewAs: "" })} />
    </div>
  );
}
