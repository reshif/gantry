/** The bell's drawer (prototype: eyebrow Notifications, title Recent activity): what waits for the person, then the latest activity events. */
import { useMemo } from "react";
import { fmt } from "@gantry/domain";
import { useActivity, useHome } from "../api/queries";
import type { HomeFull } from "../views/home/data";
import { useCatalog } from "../views/projects/kit";
import { eventRows, eventText, eventTone } from "../lib/eventText";
import { navigate } from "../lib/router";
import { CrIcon, Lamp } from "../ui/cr";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { markNotificationsRead, useSeenSignature } from "./notifRead";
import { useOpenTraveler } from "./useTraveler";

/** What the bell shows: gate approvals and questions waiting for this person, the 14 latest events, and whether any of it is unread. */
export function useNotifications() {
  const home = useHome().data as HomeFull | undefined;
  const activity = useActivity();
  const events = useMemo(() => eventRows(activity.data), [activity.data]);
  const seen = useSeenSignature();
  const approvals = home?.approvals ?? [];
  const conversations = home?.conversations ?? [];
  const latest = events[0]?.id ?? 0;
  const signature = `${approvals.length}:${conversations.length}:${latest}`;
  const any = approvals.length + conversations.length + events.length > 0;
  return { approvals, conversations, events: events.slice(0, 14), signature, unread: any && seen !== signature };
}

export function NotificationsDrawer({ close }: { close: () => void }) {
  const ui = useUI();
  const n = useNotifications();
  const cat = useCatalog();
  const actors = useActors();
  const openTraveler = useOpenTraveler();
  const go = (fn: () => void) => () => { close(); fn(); };
  const nameOf = (id: string | null | undefined) => actors(id).name.replace(" (agent)", "");
  const waiting = [...n.approvals.slice(0, 3)];
  void ui;
  return (
    <>
      <div className="drawer-h">
        <div>
          <div className="label">Notifications</div>
          <h2 id="notif-title">Recent activity</h2>
        </div>
        <button type="button" className="iconbtn drawer-close" aria-label="Close" onClick={close}><CrIcon name="x" /></button>
      </div>
      <div className="drawer-b">
        <div className="card">
          <div className="card-b flush">
            {waiting.map((a, i) => (
              <div key={`a${i}`} className="li click" role="button" tabIndex={0} onClick={go(() => navigate("inbox"))} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(() => navigate("inbox"))(); } }}>
                <Lamp tone="warn" />
                <div className="main1">
                  <span className="t1">{a.repo ? `Onboarding ${a.repoName ?? a.repo}` : `${a.wo ?? ""} · ${a.gateLabel ?? a.gate ?? ""} ${a.gateName ?? ""}`.trim()}</span>
                  <span className="t2">{`Waiting for a person${a.waitMs ? ` · ${fmt.dur(a.waitMs)}` : ""}`}</span>
                </div>
              </div>
            ))}
            {n.events.map((e) => (
              <div key={e.id} className={`li${e.wo ? " click" : ""}`} {...(e.wo ? { role: "button", tabIndex: 0, onClick: go(() => (e.project ? navigate("record", e.wo, e.project) : openTraveler(e.wo!))), onKeyDown: (ev: React.KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(() => (e.project ? navigate("record", e.wo, e.project) : openTraveler(e.wo!)))(); } } } : {})}>
                <Lamp tone={eventTone(e)} />
                <div className="main1">
                  <span className="t1">{eventText(e, cat, nameOf)}</span>
                  <span className="t2 mono">{fmt.ago(e.at, Date.now())}</span>
                </div>
              </div>
            ))}
            {!waiting.length && !n.events.length ? <div className="empty" style={{ padding: 24 }}><div className="empty-title">Nothing new</div></div> : null}
          </div>
        </div>
      </div>
      <div className="drawer-f">
        <a className="btn" href="#notifications" onClick={close}>Notification settings</a>
        <button type="button" className="btn" onClick={close}>Close</button>
      </div>
    </>
  );
}

/** Opens the drawer and marks the bell read (the prototype marks on open). */
export function useOpenNotifications(): () => void {
  const ui = useUI();
  const n = useNotifications();
  return () => {
    markNotificationsRead(n.signature);
    ui.drawer.open("notifications", (close) => <NotificationsDrawer close={close} />);
  };
}
