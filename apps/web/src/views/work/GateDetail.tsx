/**
 * What a person weighs before deciding a waiting gate, in one block: the approver rule with who is eligible and the count so far (`ApproversPanel`),
 * and the assumptions and objections still open on the work order. Read from the server; the record Gates tab and the floor gate drawer share it.
 */
import { Chip } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useWoDialogue } from "../documents/api";
import { ApproversPanel } from "../traveler/Approvers";
import { useRecordRead, type ReviewVerdict } from "../record/data";

const VERDICT: Record<ReviewVerdict["verdict"], { label: string; cls: string }> = {
  approve: { label: "Review approves", cls: "ok" },
  changes_requested: { label: "Review asked for changes", cls: "bad" },
  none: { label: "Review gave no verdict", cls: "warn" },
};
const RESULT: Record<string, { label: string; cls: string }> = { pass: { label: "Met", cls: "ok" }, fail: { label: "Not met", cls: "bad" }, untested: { label: "Not tested", cls: "plain" } };
const SEV = (s: string): string => (s === "critical" || s === "major" || s === "high" ? "bad" : s === "minor" || s === "low" ? "plain" : "warn");

/** The Review agent's verdict on the waiting gate: what it concluded, each acceptance criterion's result with its evidence, and the findings with file and line. Shown on the gate Review feeds (G5) and on any gate whose opening carries it. */
function ReviewCard({ woId, gate }: { woId: string; gate: string }) {
  const rec = useRecordRead(woId);
  if (rec.isError) return <p className="small muted" id="gd-review-err" role="alert">Couldn't load the Review verdict, so it is not shown here.</p>;
  const r = rec.data;
  if (!r) return null;
  const open = [...(r.gates ?? [])].reverse().find((g) => g.gate === gate && g.status === "open");
  const v = open?.basis?.review ?? (gate === "G5" ? r.review : null) ?? null;
  if (!v) return null;
  const t = VERDICT[v.verdict] ?? VERDICT.none;
  return (
    <section className="gd-notes" id={`gd-review-${woId}`} aria-label="Review verdict">
      <h3 className="sub-h">Review agent's verdict</h3>
      <p><Chip text={t.label} cls={t.cls} />{v.notes ? <span className="small muted">{` ${v.notes}`}</span> : null}</p>
      {v.criteria?.length ? (
        <ul className="list" id="gd-review-criteria" aria-label="Criteria as Review judged them">
          {v.criteria.map((c, i) => <li key={i}><Chip text={(RESULT[c.result] ?? RESULT.untested!).label} cls={(RESULT[c.result] ?? RESULT.untested!).cls} /><span className="grow">{c.criterion}{c.evidence ? <span className="small muted">{` ${c.evidence}`}</span> : null}</span></li>)}
        </ul>
      ) : <p className="small muted">Review did not judge the criteria one by one.</p>}
      {v.findings?.length ? (
        <ul className="list" id="gd-review-findings" aria-label="Review findings">
          {v.findings.map((f, i) => <li key={i}><Chip text={f.severity} cls={SEV(f.severity)} /><span className="grow">{f.issue}<span className="small muted mono">{f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}</span>{f.fix ? <span className="small muted">{` Fix: ${f.fix}`}</span> : null}</span></li>)}
        </ul>
      ) : <p className="small muted" id="gd-review-nofindings">No findings.</p>}
    </section>
  );
}

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
      <ReviewCard woId={woId} gate={gate} />
      <OpenNotes woId={woId} />
    </div>
  );
}
