/** The left pane of the Conversations screen: work-order sessions grouped by what needs the person, each with its station avatar, the full title and the reason. */
import { Fragment } from "react";
import { agoShort } from "./ago";
import { StationAvatar } from "./StationAvatar";
import { groupSessions, reasonOf } from "./thread-model";
import type { WoSessionRow } from "./session-api";

export function ThreadList({ rows, projectId, current, onOpen }: { rows: WoSessionRow[]; projectId: string; current: string | null; onOpen: (id: string) => void }) {
  return (
    <>
      {groupSessions(rows).map((g) => (
        <Fragment key={g.id}>
          <h3 className={`conv-grp is-${g.id}`} id={`conv-grp-${g.id}`}>{g.label}<span className="badge tab-count">{g.rows.length}</span></h3>
          {g.rows.map((w) => {
            const why = reasonOf(w);
            return (
              <a key={w.id} className={`li click conv-row${current === w.id ? " is-cur" : ""}`} id={`conv-item-${w.id}`} href={`#/p/${projectId}/conversations/${w.id}`} aria-label={`${w.id} ${w.title}`} aria-current={current === w.id ? "true" : undefined}
                onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); onOpen(w.id); }}>
                <StationAvatar id={w.agent} fallback={w.stationName} />
                <div className="main1">
                  <span className="t1 conv-row-t"><span className="mono conv-row-id">{w.id}</span>{w.unread ? <span className="badge hot" role="img" aria-label="Unread">1</span> : null}</span>
                  <span className="conv-row-title" title={w.title}>{w.title}</span>
                  <span className="t2"><span className={`chip conv-why is-${why.tone}`}>{why.text}</span>{` ${agoShort(w.latest?.at ?? w.createdAt)}`}</span>
                </div>
              </a>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}
