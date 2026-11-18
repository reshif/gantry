/**
 * What a person weighs before deciding a waiting gate, in one block: the approver rule with who is eligible and the count so far (`ApproversPanel`),
 * and the assumptions and objections still open on the work order. Read from the server; the record Gates tab and the floor gate drawer share it.
 */
import { Chip } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useWoDialogue } from "../documents/api";
import { ApproversPanel } from "../traveler/Approvers";

function OpenNotes({ woId }: { woId: string }) {
  const q = useWoDialogue(woId);
  return (
    <Async query={q} what="open assumptions and objections" id={`gd-notes-${woId}`} rows={2}>
      {(d) => {
        const as = (d.assumptions ?? []).filter((x) => x.status === "open");
        const ob = (d.objections ?? []).filter((x) => x.status === "open");
        return (
          <section className="gd-notes" id={`gd-open-${woId}`} aria-label="Open assumptions and objections">
            <h3 className="sub-h">Still open</h3>
            {!as.length && !ob.length ? <p className="small muted" id="gd-none">No open assumptions or objections.</p> : null}
            {ob.length ? (
              <ul className="list" id="gd-objections">
                {ob.map((o) => <li key={o.id}><Chip text={`objection · ${o.severity}`} cls={o.severity === "high" ? "bad" : "warn"} /><span className="grow">{o.claim}<span className="small muted">{` ${o.reason}`}</span></span></li>)}
              </ul>
            ) : null}
            {as.length ? (
              <ul className="list" id="gd-assumptions">
                {as.map((a) => <li key={a.id}><Chip text={`assumption · ${a.impact}`} cls={a.impact === "high" ? "bad" : "info"} /><span className="grow">{a.statement}<span className="small muted">{` because ${a.because}`}</span></span></li>)}
              </ul>
            ) : null}
          </section>
        );
      }}
    </Async>
  );
}

export function GateDetail({ woId, gate, project, onNavigate }: { woId: string; gate: string; project: string; onNavigate?: () => void }) {
  return (
    <div className="stack gd" id={`gd-${woId}-${gate}`}>
      <ApproversPanel woId={woId} gate={gate} project={project} {...(onNavigate ? { onNavigate } : {})} />
      <OpenNotes woId={woId} />
    </div>
  );
}
