/** The bell's right-hand drawer (prototype notesDrawer): gate requests with Review, recent events, and the two footer actions. */
import { gateLabelOf } from "../lib/gate-label";
import { useActivity, useHome } from "../api/queries";
import { navigate } from "../lib/router";
import { setProject } from "../lib/prefs";
import { Avatar, Btn } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { eventSentence, useCatalog } from "../views/projects/kit";
import { useUI } from "../ui/overlay-context";
import { Async } from "../ui/async";
import { markSeen } from "./NotificationsDrawer";

/** One unit, like the prototype: 5m ago, 3h ago, 7d ago, in 2h. */
function ago(at: number, now = Date.now()): string {
  if (!at) return "—";
  const d = Math.abs(now - at) / 1000;
  const [n, u] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "m"] : d < 86400 ? [Math.round(d / 3600), "h"] : [Math.round(d / 86400), "d"];
  return now - at < 0 ? `in ${n}${u}` : `${n}${u} ago`;
}

export function NotificationsBody({ close }: { close: () => void }) {
  const home = useHome();
  const act = useActivity();
  const ui = useUI();
  const actor = useActors();
  const cat = useCatalog();
  const name = (id: string | null | undefined) => actor(id).name.replace(" (agent)", "");
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
                <div key={`${a.wo}-${a.gate}`} className="callout nt-unread" style={{ marginBottom: 8 }}>
                  <b>{`${a.wo} needs your approval`}</b>
                  {`${a.title ?? ""} · ${gateLabelOf(a.gateLabel, a.gate)}`}
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
                        <div>{eventSentence(e, { cat, name })}</div>
                        <div className="small muted">{ago(e.at)}</div>
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
