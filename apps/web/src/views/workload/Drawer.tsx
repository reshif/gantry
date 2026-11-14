/** Person drawer (legacy openPerson): what waits on them, their recent acts, and the way to set a delegate. */
import { fmt, inHours } from "@gantry/domain";
import type { Workload, WorkloadRow } from "../../api/types";
import { useCatalog } from "../projects/kit";
import { Btn, Avatar } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { usePeople, useMe } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import { useOpenRecordRoute } from "../record/nav";
import { DelegateDialog } from "./Delegate";
import { goPerson, mins, teamName, windowText, useDelegateGuard } from "./kit";

const EMPTY = (person: string, name: string): WorkloadRow => ({ person, name, team: null, waiting: 0, glass: 0, approvals: 0, perDay: 0, answered: 0, waitN: 0, medianResponseMin: null, afterHours: 0, n: 0, sole: 0, minutes: 0, away: null, oncall: false, waitingGates: [], recent: [] });

export function PersonDrawer({ pid, m, close }: { pid: string; m: Workload; close: () => void }) {
  const ui = useUI();
  const me = useMe();
  const actor = useActors();
  const cat = useCatalog();
  const person = (usePeople().data ?? []).find((x) => x.id === pid);
  const guard = useDelegateGuard(pid);
  const open = useOpenRecordRoute();
  if (!person) return null;
  const r = m.rows.find((x) => x.person === pid) ?? EMPTY(pid, person.name);
  const team = teamName(m, m.rows.find((x) => x.person === pid)?.team);
  const gateLabel = (id: string): string => cat?.gates.find((g) => g.id === id)?.label ?? id;
  const first = person.name.split(" ")[0];
  const woLink = (id: string, pre: string, project?: string) => <button type="button" className="linkish mono" id={`wl-dr-wo-${pre}-${id}`} onClick={() => { close(); open(id, project); }}>{id}</button>;
  return (
    <div className="drawer-inner wl-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker">{`Workload · ${team} · last ${windowText(m.days)}`}</div>
          <div className="drawer-id"><Avatar id={person.id} /><h2 className="drawer-title">{person.name}</h2></div>
          <div className="muted small">{person.title + (r.away ? ` · away until ${fmt.istDate(r.away.to)}, delegate ${actor(r.away.delegate).name}` : "") + (r.oncall || person.oncall ? " · on call" : "")}</div>
        </div>
        <button type="button" className="icon-btn drawer-close" id="wl-drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        <dl className="titleblock wl-tb">
          {([["Waiting", r.waiting], ["Approvals", r.approvals], ["Answers", r.answered], ["Minutes", r.minutes], ["Sole approver", r.sole]] as Array<[string, number]>).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
        </dl>
        <div className="row gap-sm wl-dr-actions">
          <Btn label={r.away ? "Change delegation" : "Delegate while away"} small icon="swap" id="wl-dr-delegate" guard={guard} onClick={() => ui.open((c) => <DelegateDialog pid={pid} away={r.away} close={c} />)} />
          {me && canSeeRoute("people", me) ? <Btn label="Open in People" small kind="ghost" icon="people" id="wl-dr-people" onClick={() => { close(); goPerson(pid); }} /> : null}
        </div>
        <h3 className="sub-h">{`Waiting on ${first}`}</h3>
        {r.waitingGates.length ? (
          <ul className="wl-list">
            {r.waitingGates.map((g) => (
              <li key={`${g.wo.id}:${g.gate}`}>
                {woLink(g.wo.id, "w", g.wo.project)}<span className="mono small">{gateLabel(g.gate)}</span><span className="small">{g.wo.title}</span>
                <span className="mono muted small">{mins((m.at - g.since) / 60000)}</span>
                {g.eligible === 1 ? <span className="chip chip-warn"><Icon name="alert" />only approver</span> : <span className="muted small">{`${g.eligible - 1} others eligible`}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">Nothing is waiting on them right now.</p>}
        <h3 className="sub-h">Recent acts</h3>
        {r.recent.length ? (
          <ul className="wl-list">
            {r.recent.map((a, i) => (
              <li key={`${a.wo}:${a.at}:${i}`}>
                <span className="mono muted small">{`${fmt.istDate(a.at)} ${fmt.ist(a.at)}`}</span>{woLink(a.wo, `a${i}`)}
                <span className="small">{a.kind === "answer" ? "answered a question" : a.kind === "confirm" ? "confirmed the brief" : `approved ${gateLabel(a.gate ?? "")}`}</span>
                {a.waitMin != null ? <span className="mono muted small">{`after ${mins(a.waitMin)}`}</span> : <span />}
                {!inHours(a.at) ? <span className="chip"><Icon name="clock" />out of hours</span> : <span />}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">No approvals, confirmations or answers in this window.</p>}
      </div>
    </div>
  );
}
