/** The Overview tab of a work order page, laid out like the prototype's record: the brief with its acceptance criteria and the classification on the left, the facts and the SLA on the right. */
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { useState } from "react";
import { Btn, Meter, Textarea } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { EditDialog } from "./WoDialogs";
import { attemptsOf } from "./kit";
import { Card, CrIcon } from "../../ui/cr";
import { useActors } from "../../ui/actors";
import { classOf } from "../projects/kit";
import { useRepoName } from "../traveler/repo";
import type { TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import type { RecordData } from "../record/data";
import { srcName } from "../record/data";
import { CriteriaList } from "./Criteria";


/** The description as the prototype draws it: click it to edit. The server cannot save a changed description yet, and says so. */
function InlineDesc({ wo }: { wo: TWo }) {
  const ui = useUI();
  const [edit, setEdit] = useState(false);
  const text = wo.description || wo.title;
  const done = (v: string) => {
    setEdit(false);
    if (v.trim() && v.trim() !== text) ui.toast("The server cannot change a work order's description yet.", "error");
  };
  if (edit) return <Textarea id="dz-desc-input" aria-label="Edit description" rows={2} ref={(el) => el?.focus()} defaultValue={text} onBlur={(e) => done(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEdit(false); } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(e.currentTarget.value); } }} />;
  return <span className="inl" id="dz-desc" role="button" tabIndex={0} title="Click to edit" style={{ cursor: "text", borderBottom: "1px dashed var(--line-strong)" }} onClick={() => setEdit(true)} onKeyDown={(e) => { if (e.key === "Enter") setEdit(true); }}>{text}</span>;
}

export function Overview({ wo, rec, cat, project }: { wo: TWo; rec: RecordData; cat: Catalog; project: Project; session?: WoSession | undefined }) {
  const actor = useActors();
  const ui = useUI();
  const repo = useRepoName(wo.project, wo.repo);
  const tot = wo.history.reduce((t, e) => ({ tokens: t.tokens + e.tokens, cost: t.cost + e.cost }), { tokens: 0, cost: 0 });
  const cls = classOf(cat, project, wo.cls);
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const atGate = cat.gates.find((g) => wo.gates[g.id]?.status === "waiting");
  const agentNow = wo.history[wo.history.length - 1]?.agent ?? st?.agent;
  const next = wo.state === "waiting" && atGate ? `A person at ${atGate.label}` : agentNow ? actor(agentNow).name.replace(" (agent)", "") : "";
  const crit = rec.criteria ?? [];
  const slaTotal = wo.slaDue ? wo.slaDue - wo.createdAt : 0;
  const elapsed = Date.now() - wo.createdAt;
  const pr = rec.code.pullRequests[0];
  return (
    <div className="grid g-main dz-overview" id="dz-overview">
      <div className="stack">
        <Card title="Brief" hint="Click the description to edit it" acts={<Btn label="Edit" small icon="edit" id="dz-edit" onClick={() => void ui.open((close) => <EditDialog wo={wo} cat={cat} project={project} onClose={close} />)} />}>
          <p style={{ marginBottom: 12 }}><InlineDesc wo={wo} /></p>
          <div className="label" style={{ marginBottom: 8 }}>Acceptance criteria</div>
          <CriteriaList criteria={crit} tests={rec.code.tests} empty="No acceptance criteria yet." />
        </Card>
        <Card title="Classification">
          <dl className="kv kv2" style={{ margin: 0 }}>
            <dt>Class</dt><dd><span className="tag">{cls.name}</span></dd>
            <dt>Source</dt><dd>{srcName(wo.source)}</dd>
            <dt>Confidence</dt><dd>{`${Math.round(wo.clsConfidence * 100)}%`}</dd>
            <dt>Skips</dt><dd>{wo.route.length < cat.stations.length ? cat.stations.filter((s) => !wo.route.includes(s.id)).map((s) => s.name).join(", ") : "None"}</dd>
            <dt>Priority</dt><dd><span className={`tag pri ${wo.priority.toLowerCase()}`}>{wo.priority}</span></dd>
            <dt /><dd />
            <dt>Rationale</dt><dd className="wide">{wo.clsRationale || rec.classification.rationale || "None recorded."}</dd>
          </dl>
        </Card>
      </div>
      <div className="stack">
        <Card title="Facts">
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Project</dt><dd>{project.name}</dd>
            <dt>Repository</dt><dd><span className="m">{repo}</span></dd>
            <dt>Next actor</dt><dd>{next}</dd>
            <dt>Attempts</dt><dd>{attemptsOf(wo, cat).length}</dd>
            <dt>Tokens</dt><dd>{fmt.k(tot.tokens)}</dd>
            <dt>Cost</dt><dd>{fmt.money(tot.cost)}</dd>
            <dt>Pull request</dt><dd>{pr ? <a className="m" href={`#/p/${wo.project}/changes/${wo.id}`}>{`#${pr.number}`}</a> : "not yet"}</dd>
          </dl>
        </Card>
        {wo.blockReason ? <div className="banner bad" id="dz-blocked"><CrIcon name="warn" /><div className="grow"><b>Blocked.</b>{` ${wo.blockReason}`}</div></div> : null}
        {slaTotal > 0 ? (
          <Card title="SLA">
            <div className="row spread" style={{ marginBottom: 8 }}>
              <span className="mono">{`${fmt.dur(elapsed)} elapsed`}</span>
              <span className="mono dim">{`${Math.round(slaTotal / 3_600_000)} h`}</span>
            </div>
            <Meter value={elapsed} max={slaTotal} label="Time used of the SLA" />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
