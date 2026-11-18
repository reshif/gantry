/** Factory state, IST clock and shift, release windows and freezes (legacy status cluster, without the simulation control). */
import { FACTORY_READ } from "../lib/routes";
import { useEffect, useRef, useState } from "react";
import { fmt } from "@gantry/domain";
import { useCanMany } from "../api/can";
import { useConnection } from "../lib/connection/store";
import { useFreezes, useMe, usePolicies } from "../api/queries";
import { statusInfo, type StatusInfo } from "../lib/status";
import { setReplay, usePrefs } from "../lib/prefs";
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
    policies: Array.isArray(policies) ? policies : [],
    freezes: Array.isArray(freezes) ? freezes : [],
    killed: !!me.factory.killed,
    replay: !!prefs.replay,
  });
}

/** The LIVE chip of the top bar (prototype): Live, Halted, Stopped, plus the stream states folded in. Click opens the Line control menu. */
export function StatusCluster() {
  const s = useStatus();
  const me = useMe();
  const ui = useUI();
  const btn = useRef<HTMLButtonElement>(null);
  const prefs = usePrefs();
  const conn = useConnection().state;
  const cp = me?.projects.find((p) => p.id === prefs.project) ?? me?.projects[0] ?? null;
  const killed = !!me?.factory.killed;
  const checks = useCanMany([
    { action: cp?.halted ? "line.resume" : "line.halt", project: cp?.id },
    { action: killed ? "restore.factory" : "kill.factory" },
  ]);
  if (!s || !me) return null;
  const anyHalted = me.projects.some((p) => p.halted);
  const guardOf = (i: number) => (checks[i]?.pending ? undefined : checks[i]);
  const [label, tone] = killed ? ["Stopped", "bad"] : anyHalted ? ["Halted", "warn"] : conn === "reconnecting" ? ["Reconnecting", "warn"] : conn === "offline" ? ["Offline", "warn"] : s.factory === "replay" ? ["Replay", "info"] : ["Live", "ok"];
  const hint = conn === "live" ? "" : conn === "reconnecting" ? "Live updates dropped. Reconnecting; screens refresh on a timer meanwhile." : "No network. Showing the last information we had.";
  const stop = makeStopActions(ui, me);
  const open = () => {
    if (!btn.current) return;
    const anchor = btn.current;
    ui.menu(anchor, null, [
      { head: "Line control" },
      cp
        ? { label: cp.halted ? "Resume line" : "Halt line", icon: cp.halted ? "right" : "pause", hint: cp.key, guard: guardOf(0), onClick: () => (cp.halted ? void stop.resume(cp.id) : stop.halt(cp.id)) }
        : { label: "Halt line", icon: "pause", guard: { allowed: false, reason: "No project to halt.", needs: "" } },
      { label: killed ? "Restore factory" : "Emergency stop", icon: "stop", kind: killed ? undefined : "andon", guard: guardOf(1), onClick: () => (killed ? stop.restore("factory", null) : stop.kill("factory", null)) },
      { sep: true },
      { label: "Windows and freezes", icon: "clock", hint: s.activeFreezes.length ? `${s.activeFreezes.length} freeze` : "", onClick: () => ui.popover(anchor, (close) => <StatusPopover s={s} replayAt={prefs.replay?.at} close={close} />) },
    ]);
  };
  return (
    <button
      ref={btn}
      type="button"
      className={`btn sm ghost status-cluster is-${s.factory}`}
      id="status-cluster"
      aria-haspopup="menu"
      aria-expanded="false"
      title={hint || undefined}
      aria-label={`Line control. Factory ${label.toLowerCase()}. ${s.clock} IST, ${s.shift}.${hint ? ` ${hint}` : ""}`}
      onClick={open}
    >
      <span id="conn-indicator" className={`chip ${tone}`}>{label}</span>
    </button>
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
      {canAccess ? (
        <a href="#access" className="small" onClick={close}>
          Manage windows and freezes in Access
        </a>
      ) : null}
    </div>
  );
}
