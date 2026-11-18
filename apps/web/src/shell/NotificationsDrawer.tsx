/** The bell's right-hand drawer (prototype notesDrawer): gate requests with Review, recent events, and the two footer actions. */
import { useSyncExternalStore } from "react";
import { fmt } from "@gantry/domain";
import { useActivity, useHome } from "../api/queries";
import { navigate } from "../lib/router";
import { setProject } from "../lib/prefs";
import { Avatar, Btn } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { Async } from "../ui/async";

/** Local read marker: how many waiting items the person has already seen. Cleared by opening the drawer; never sent anywhere. */
let seen = 0;
const listeners = new Set<() => void>();
const markSeen = (n: number) => {
  seen = n;
  listeners.forEach((l) => l());
};
/** Number of waiting items not yet seen in the drawer. */
export function useUnread(waiting: number): number {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l); }, () => seen);
  return Math.max(0, waiting - s);
}

export function NotificationsBody({ close }: { close: () => void }) {
  const home = useHome();
  const act = useActivity();
  const actor = useActors();
  const ui = useUI();
  const gates = (home.data?.approvals ?? []).filter((a) => a.wo).slice(0, 4);
  const waiting = (home.data?.approvals.length ?? 0) + (home.data?.conversations.length ?? 0);
  const events = (Array.isArray(act.data) ? act.data : (act.data?.items ?? [])).slice(0, 14);
  return (
    <>
      <header>
        <div style={{ minWidth: 0 }}>
          <h2>Notifications</h2>
          <div className="muted small">Gate requests, questions and system messages</div>
        </div>
        <Btn kind="ghost" icon="x" aria="Close" cls="icon drawer-close" onClick={close} />
      </header>
      <div className="body">
        <Async query={home} what="notifications" id="notes">
          {() => (
            <div>
              {gates.map((a) => (
                <div key={`${a.wo}-${a.gate}`} className="callout warn" style={{ marginBottom: 8 }}>
                  <b>{`${a.wo} needs your approval`}</b>
                  {`${a.title ?? ""} · ${a.gateLabel ?? a.gate ?? ""}`}
                  <div style={{ marginTop: 6 }}>
                    <Btn label="Review" small kind="primary" onClick={() => { close(); if (a.project) setProject(a.project); if (a.wo) navigate("record", a.wo); }} />
                  </div>
                </div>
              ))}
              {events.length ? (
                <ul className="list" style={{ marginTop: 12 }}>
                  {events.map((e) => (
                    <li key={e.id}>
                      <Avatar id={e.by} size="sm" />
                      <div className="grow">
                        <div className="trunc">{(e as { text?: string }).text ?? e.type}</div>
                        <div className="small muted">{`${e.type} · ${e.wo ?? ""} · ${fmt.ago(e.at, Date.now())} · ${e.by ? actor(e.by).name : "system"}`}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : !gates.length ? <p className="muted small">Nothing waiting for you.</p> : null}
            </div>
          )}
        </Async>
      </div>
      <footer>
        <Btn label="Notification routes" onClick={() => { close(); navigate("notifications"); }} />
        <Btn label="Mark all read" onClick={() => { markSeen(waiting); close(); ui.toast("All caught up", "ok"); }} />
      </footer>
    </>
  );
}

export function openNotifications(ui: ReturnType<typeof useUI>, waiting: number): void {
  markSeen(waiting);
  ui.drawer.open("notifications", (close) => <NotificationsBody close={close} />);
}
