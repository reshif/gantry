/** The brief, built live as the conversation goes: goal, scope, acceptance, misses, risks, open questions, decisions, estimate and route (legacy G.renderBriefPanel). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { Icon } from "../../ui/Icon";
import { Meter } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useProject } from "../../api/queries";
import { classOf, useCatalog } from "../projects/kit";
import { RouteStrip } from "../work-orders/intake";
import { useTravelerWo } from "../traveler/model";

const List = ({ items, empty, cls }: { items: string[] | undefined; empty: string; cls?: string }) =>
  items && items.length ? (
    <ul className={`brief-list ${cls ?? ""}`}>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="muted small">{empty}</p>
  );

export function BriefPanel({ woId, idPrefix = "brief-" }: { woId: string; idPrefix?: string }) {
  const wo = useTravelerWo(woId).data;
  const cat = useCatalog();
  const project = useProject(wo?.project).data;
  const actor = useActors();
  const open = useOpenTraveler();
  // sections that changed since the last render are marked "updated" for a few seconds
  const mem = useRef<{ wo: string; seen: Record<string, { v: string; at: number }>; first: boolean }>({ wo: woId, seen: {}, first: true });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, []);
  if (!wo || !cat || !project) return null;
  if (mem.current.wo !== woId) mem.current = { wo: woId, seen: {}, first: true };
  const m = mem.current;
  const first = m.first;
  const b = wo.brief;
  const conv = wo.conv;
  const sec = (key: string, title: string, content: ReactNode, val: unknown) => {
    const v = JSON.stringify(val);
    const s = m.seen[key];
    if (!s) m.seen[key] = { v, at: 0 };
    else if (s.v !== v) m.seen[key] = { v, at: Date.now() };
    const changed = !first && Date.now() - (m.seen[key]?.at ?? 0) < 8000;
    return (
      <section key={key} className={`brief-sec${changed ? " is-new" : ""}`}>
        <h3 className="brief-h">
          {title}
          {changed ? <span className="brief-upd mono">updated</span> : null}
        </h3>
        {content}
      </section>
    );
  };
  const out = (
    <div className="brief">
      <div className="brief-top">
        <div className="kicker">Brief · built live</div>
        <div className="brief-prog">
          <Meter value={conv.qi} max={conv.questions.length} label={`${conv.qi} of ${conv.questions.length} answered`} />
        </div>
      </div>
      {sec("goal", "Goal", <p className="brief-goal">{b.goal}</p>, b.goal)}
      {sec(
        "scope",
        "Scope",
        <div className="brief-scope">
          <div>
            <div className="kv-k">In</div>
            <List items={b.scopeIn} empty="Not set yet" />
          </div>
          <div>
            <div className="kv-k">Out</div>
            <List items={b.scopeOut} empty="Nothing excluded" />
          </div>
        </div>,
        [b.scopeIn, b.scopeOut],
      )}
      {sec("ac", "Acceptance criteria", <List items={b.ac} empty="Not set yet" cls="brief-ac" />, b.ac)}
      {sec(
        "misses",
        "Misses the agent found",
        conv.misses.length ? (
          <ul className="brief-misses">
            {conv.misses.map((x) => (
              <li key={x.id} className={x.resolved ? "is-ok" : "is-open"}>
                <Icon name={x.resolved ? "check" : "alert"} />
                <span>{x.text}</span>
                <span className="small muted">{x.resolved ? "answered" : "open"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None found.</p>
        ),
        conv.misses,
      )}
      {sec("risks", "Risks", <List items={b.risks} empty="None recorded" />, b.risks)}
      {sec("open", "Open questions", <List items={b.open} empty="None. The brief is complete." />, b.open)}
      {sec(
        "decisions",
        "Decisions",
        conv.decisions.length ? (
          <ol className="brief-dec">
            {conv.decisions.map((d, i) => (
              <li key={i}>
                <span>{d.text}</span>
                <span className="small muted">{`${actor(d.by).name}, ${fmt.ist(d.at)} IST`}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">None yet.</p>
        ),
        conv.decisions.length,
      )}
      {sec(
        "est",
        "Estimate and route",
        <div>
          <p>
            <span className="mono strong">{b.estimate}</span>
            <span className="small muted">{` · ${classOf(cat, project, wo.cls).name} route, ${b.route.length} stations`}</span>
          </p>
          <RouteStrip cat={cat} project={project} cls={wo.cls} />
        </div>,
        [b.estimate, b.route],
      )}
      {wo.cls === "epic"
        ? sec(
            "children",
            "Child work orders",
            <div>
              {wo.children.length ? (
                <div className="brief-kids">
                  {wo.children.map((id) => (
                    <button key={id} type="button" className="linkish mono" id={`${idPrefix}kid-${id}`} onClick={() => open(id)}>
                      {id}
                    </button>
                  ))}
                </div>
              ) : b.children.length ? (
                <ul className="brief-list">
                  {b.children.map((x, i) => (
                    <li key={i}>
                      <span className="mono muted">proposed </span>
                      {`${wo.title}: ${x}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{conv.answers.children ? "You chose not to split this epic." : "The Intake agent will propose children. Answer the split question to confirm them."}</p>
              )}
              {b.children.length && !wo.children.length ? <p className="small muted">Confirmed in the conversation. They are created after Plan, each with its own brief.</p> : null}
            </div>,
            [b.children, wo.children.length],
          )
        : null}
    </div>
  );
  m.first = false;
  return out;
}
