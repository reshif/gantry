import { Panel } from "../../ui/primitives";
import { fmt } from "@gantry/domain";
import { useMe } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import type { HomeFull } from "./data";

/** Where approvals wait on people, and what Trust and Learning have for them to review (legacy humanPanel). */
export function HumanPanel({ human }: { human: NonNullable<HomeFull["human"]> }) {
  const me = useMe();
  const link = (route: string, label: string, id: string) =>
    me && canSeeRoute(route, me, {}) ? <a href={`#${route}`} className="linkish small" id={id}>{label}</a> : <span className="muted small" data-tip="You can't open this with your role.">{label}</span>;
  const { gates, waiting, trust, learning } = human;
  return (
    <Panel title="Human attention" cls="hm-hu-panel" tools={<span className="mono small muted">{trust.proposals.length + learning.length + " to review"}</span>}>
      <div className="hm-hu">
        <div className="hm-hu-sec">
          <div className="hm-hu-head"><span className="sub-h">Approvals waiting</span>{link("workload", "Workload", "hm-hu-workload")}</div>
          <dl className="hm-hu-kpis">
            <div><dt>Waiting</dt><dd>{String(gates.count)}</dd></div>
            <div><dt>Oldest</dt><dd>{gates.count ? fmt.dur(gates.oldestMs) : "none"}</dd></div>
            <div className={gates.sole ? "is-warn" : ""} data-tip="Waiting gates that only one person (besides Factory Admins) may approve" tabIndex={0}><dt>One approver</dt><dd>{String(gates.sole)}</dd></div>
          </dl>
          {waiting.length ? (
            <ul className="hm-hu-list">
              {waiting.map((r) => (
                <li key={r.person}>
                  <span>{r.name}</span>
                  <span className="mono small">{`${r.waiting} waiting${r.sole ? ` · sole on ${r.sole}` : ""}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nobody has approvals waiting.</p>
          )}
        </div>
        <div className="hm-hu-sec">
          <div className="hm-hu-head"><span className="sub-h">Trust</span>{link("trust", "Trust ladder", "hm-hu-trust")}</div>
          <p className="small">
            <strong>{String(trust.proposals.length)}</strong>{` promotion proposal${trust.proposals.length === 1 ? "" : "s"} pending · `}
            <strong>{String(trust.demotions.length)}</strong>{` demotion${trust.demotions.length === 1 ? "" : "s"} in 7 days`}
          </p>
          {trust.proposals.length || trust.demotions.length ? (
            <ul className="hm-hu-list">
              {trust.proposals.slice(0, 2).map((x) => (
                <li key={x.id}><span className="hm-hu-up" aria-hidden="true">▲</span><span>{x.cell}</span><span className="muted small">{"to " + x.to}</span></li>
              ))}
              {trust.demotions.slice(0, 2).map((x) => (
                <li key={x.cell + x.at} className="is-dem"><span className="hm-hu-down" aria-hidden="true">▼</span><span>{x.cell}</span><span className="muted small">{fmt.ago(x.at, Date.now())}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="hm-hu-sec">
          <div className="hm-hu-head"><span className="sub-h">Learning</span>{link("learning", "Learning loop", "hm-hu-learning")}</div>
          {learning.length ? (
            <ul className="hm-hu-list">
              {learning.slice(0, 3).map((x) => (
                <li key={x.id}><span className="mono small">{x.id}</span><span>{x.title}</span></li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No learning proposals waiting for review.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

