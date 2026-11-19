/** The thread list: grouped Needs you / Active / Done, each row a station avatar, "WO-id · time", the full title and why it is there. Search and filter live in the URL. */
import { fmt } from "@gantry/domain";
import { Empty, Segmented, SearchBox } from "../../ui/primitives";
import { groupThreads, initialsOf, reasonOf, type ThreadFilter } from "./chat";
import type { WoSessionRow } from "./session-api";

/** The station as a letter badge: no '?' for an agent the people list does not know. */
export function StationAvatar({ name }: { name: string | null | undefined }) {
  return <span className="avatar av av-agent cv-st-av" aria-hidden="true">{initialsOf(name ?? "")}</span>;
}

const FILTERS: Array<{ id: ThreadFilter; label: string }> = [{ id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "active", label: "Active" }, { id: "done", label: "Done" }];

export function ThreadList({ rows, picked, q, filter, setQ, setFilter, href }: { rows: WoSessionRow[]; picked: string | null; q: string; filter: ThreadFilter; setQ: (v: string) => void; setFilter: (f: ThreadFilter) => void; href: (id: string, project: string) => string }) {
  const groups = groupThreads(rows, q, filter);
  return (
    <div className="cv-list-wrap">
      <div className="cv-list-tools">
        <SearchBox id="conv-search" value={q} onChange={setQ} placeholder="Search conversations" caption="Search" />
        <Segmented pressed name="conv-filter" label="Show" items={FILTERS} value={filter} onChange={(id) => setFilter(id as ThreadFilter)} />
      </div>
      {groups.length ? (
        <div className="cv-list" data-keep-scroll="conv-list">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label} className={`cv-group is-${g.id}`}>
              <h3 className="cv-group-h">{g.label}<span className="mono">{g.rows.length}</span></h3>
              <ul className="list" aria-label={`${g.label}: work-order conversations`}>
                {g.rows.map((w) => {
                  const why = reasonOf(w);
                  return (
                    <li key={w.id} id={`conv-item-${w.id}`} className={`cv-row${w.id === picked ? " is-on" : ""}`} aria-current={w.id === picked ? "true" : undefined}>
                      <StationAvatar name={w.agentName ?? w.stationName} />
                      <a className="cv-row-main" href={href(w.id, w.project)}>
                        <span className="cv-row-title" title={w.title}><span className="mono cv-row-id">{w.id}</span>{` · ${w.title}`}</span>
                        <span className="cv-row-last small muted">{w.latest?.text.replace(/\s+/g, " ") ?? ""}</span>
                      </a>
                      <span className="cv-row-side">
                        <span className={`chip ${why.tone}`.trim()}>{why.text}</span>
                        <span className="cv-row-meta">{w.unread ? <span className="cv-unread" role="img" aria-label="Unread messages" /> : null}<span className="muted small cv-row-t">{w.latest ? fmt.ago(w.latest.at, Date.now()) : ""}</span></span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : <Empty id="conv-empty" title={q || filter !== "all" ? "No conversations match" : "No conversations"} text={q || filter !== "all" ? "Clear the search or the filter." : ""} />}
    </div>
  );
}

