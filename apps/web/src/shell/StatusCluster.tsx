/** Factory state, IST clock and shift, release windows and freezes (legacy status cluster, without the simulation control). */
import { useEffect, useRef, useState } from "react";
import { useCanMany } from "../api/can";
import { useConnection } from "../lib/connection/store";
import { useFreezes, useMe, usePolicies, useRepos } from "../api/queries";
import { statusInfo, type StatusInfo } from "../lib/status";
import { usePrefs } from "../lib/prefs";
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
  const repos = useRepos(cp?.id).data ?? [];
  const checks = useCanMany([
    { action: cp?.halted ? "line.resume" : "line.halt", project: cp?.id },
    { action: killed ? "restore.factory" : "kill.factory" },
    { action: "line.halt", project: cp?.id },
    { action: "line.resume", project: cp?.id },
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
        ? { label: cp.halted ? "Resume line" : "Halt line (pause the project)", icon: cp.halted ? "right" : "pause", guard: guardOf(0), onClick: () => (cp.halted ? void stop.resume(cp.id) : stop.halt(cp.id)) }
        : { label: "Halt line", icon: "pause", guard: { allowed: false, reason: "No project to halt.", needs: "" } },
      ...(cp && repos.length ? [{ head: "Pause one repo" }] : []),
      ...(cp ? repos.map((r) => ({ label: r.halted ? `Resume ${r.name}` : `Pause ${r.name}`, icon: r.halted ? "right" : "pause", guard: guardOf(r.halted ? 3 : 2), onClick: () => (r.halted ? void stop.resumeRepo(r.id) : stop.haltRepo(r.id, cp.id)) })) : []),
      { head: "Whole factory" },
      { label: killed ? "Restore factory" : "Emergency stop", icon: "stop", guard: guardOf(1), onClick: () => (killed ? stop.restore("factory", null) : stop.kill("factory", null)) },
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
