/** Factory state, IST clock and shift, release windows and freezes (legacy status cluster, without the simulation control). */
import { FACTORY_READ } from "../lib/routes";
import { useEffect, useRef, useState } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useFreezes, useMe, usePolicies } from "../api/queries";
import { statusInfo, type StatusInfo } from "../lib/status";
import { setReplay, usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { Btn } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { makeStopActions } from "./stopActions";

export function useStatus(): StatusInfo | null {
  const me = useMe();
  const prefs = usePrefs();
  const policies = usePolicies().data;
  const freezes = useFreezes().data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);
  if (!me) return null;
  return statusInfo(now, {
    visibleProjectIds: me.projects.map((p) => p.id),
    policies: policies ?? [],
    freezes: freezes ?? [],
    killed: !!me.factory.killed,
    replay: !!prefs.replay,
  });
}

export function StatusCluster() {
  const s = useStatus();
  const ui = useUI();
  const btn = useRef<HTMLButtonElement>(null);
  const prefs = usePrefs();
  if (!s) return null;
  const stateText = s.factory === "replay" ? "Replay" : s.factory === "killed" ? "Killed" : "Running";
  return (
    <button
      ref={btn}
      type="button"
      className={`status-cluster is-${s.factory}`}
      id="status-cluster"
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={`Factory ${stateText.toLowerCase()}. ${s.clock} IST, ${s.shift}. ${s.activeFreezes.length ? `${s.activeFreezes.length} freeze active. ` : ""}Show change windows and freezes.`}
      onClick={() => btn.current && ui.popover(btn.current, (close) => <StatusPopover s={s} replayAt={prefs.replay?.at} close={close} />)}
    >
      <span className="sc-state">
        <span className="sc-dot" aria-hidden="true" />
        <span className="sc-label">{stateText}</span>
        {s.activeFreezes.length ? <Icon name="lock" /> : null}
      </span>
    </button>
  );
}

/**
 * Kill and restore the factory: here and in the Ctrl K palette, nowhere on Home. Shown only to people who hold the right (no locked copy for anyone else);
 * the dialogs and their step-up are the shared ones in StopDialogs.
 */
function FactoryStop({ close }: { close: () => void }) {
  const me = useMe();
  const ui = useUI();
  const kill = useCan("kill.factory");
  const restore = useCan("restore.factory");
  if (!me) return null;
  const killed = me.factory.killed as { restoreApprovals?: Array<{ by: string }> } | null;
  const stop = makeStopActions(ui, me);
  if (killed) {
    if (restore.pending || !restore.allowed) return null;
    const have = killed.restoreApprovals ?? [];
    const already = have.some((a) => a.by === me.person.id);
    return (
      <div className="sp-stop" id="sp-stop">
        <h3 className="sp-h">Restore the factory</h3>
        <p className="small muted">{have.length ? `${have.length} restore ${have.length === 1 ? "approval" : "approvals"} so far.` : "No restore approval yet."}</p>
        <Btn label={have.length ? "Approve restore…" : "Restore factory…"} kind="primary" icon="power" id="sp-restore" disabledReason={already ? "You approved this restore already. A second Factory Admin must approve." : null} onClick={() => { close(); stop.restore("factory", null); }} />
      </div>
    );
  }
  if (kill.pending || !kill.allowed) return null;
  return (
    <div className="sp-stop" id="sp-stop">
      <h3 className="sp-h">Kill the factory</h3>
      <p className="small muted">Stops every agent in every project and refuses new submissions. Needs a reason and a typed phrase.</p>
      <Btn label="Kill factory…" kind="danger" icon="st-kill" id="sp-kill" onClick={() => { close(); stop.kill("factory", null); }} />
    </div>
  );
}

function StatusPopover({ s, replayAt, close }: { s: StatusInfo; replayAt: number | undefined; close: () => void }) {
  const me = useMe();
  const canAccess = !!me && me.person.roles.some((g) => g.scope === "factory" && (FACTORY_READ as readonly string[]).includes(g.role));
  return (
    <div className="status-pop">
      <div className="pop-head">
        <strong>{`Factory ${s.factory === "replay" ? "in replay" : s.factory}`}</strong>
        <span className="muted small">{`${s.date} ${s.clock} IST · ${s.shift} · ${s.windows.filter((w) => w.open).length} windows open${s.activeFreezes.length ? ` · ${s.activeFreezes.length} freeze active` : ""}`}</span>
      </div>
      {s.factory === "replay" ? (
        <div className="sp-row">
          <span>{`Showing the floor at ${fmt.stamp(replayAt || Date.now())}.`}</span>
          <Btn label="Exit replay" small id="sp-exit-replay" onClick={() => { setReplay(null); close(); }} />
        </div>
      ) : null}
      <h3 className="sp-h">Release windows</h3>
      {s.windows.length ? (
        <ul className="plain-list sp-list">
          {s.windows.map((w) => (
            <li key={w.id}>
              <span className={`sp-dot ${w.open ? "is-open" : "is-closed"}`} aria-hidden="true" />
              <span>
                <strong>{w.name}</strong>
                {` · ${w.text}${w.projects.length ? ` · ${w.projects.map((p) => me?.projects.find((x) => x.id === p)?.name ?? p).join(", ")}` : " · all projects"}`}
              </span>
              <span className="muted small">{w.open ? "open now" : "closed"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No release windows apply to your projects.</p>
      )}
      <h3 className="sp-h">Freezes</h3>
      {s.freezes.length ? (
        <ul className="plain-list sp-list">
          {s.freezes.map((f) => (
            <li key={f.id}>
              <span className={`sp-dot ${f.active ? "is-freeze" : "is-closed"}`} aria-hidden="true" />
              <span>
                <strong>{f.name}</strong>
                {` · ${f.repos === "all" ? "all repos" : f.repos.join(", ")}`}
              </span>
              <span className="muted small">{`${f.active ? "until " : "from "}${fmt.stamp(f.active ? f.to : f.from)}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No freezes active or scheduled.</p>
      )}
      <FactoryStop close={close} />
      {canAccess ? (
        <a href="#access" className="small" onClick={close}>
          Manage windows and freezes in Access
        </a>
      ) : null}
    </div>
  );
}
