/** The Overview tab of a work order page, laid out like the prototype's record: the brief with its acceptance criteria and the classification on the left, the facts and the SLA on the right. */
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Meter } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useActors } from "../../ui/actors";
import { classOf } from "../projects/kit";
import { useRepoName } from "../traveler/repo";
import { no, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import type { RecordData } from "../record/data";
import { critStatus, srcName } from "../record/data";

const CRIT_TONE: Record<string, string> = { met: "ok", failed: "bad", pending: "warn", untested: "idle" };

export function Overview({ wo, rec, cat, project, session }: { wo: TWo; rec: RecordData; cat: Catalog; project: Project; session: WoSession | undefined }) {
  const actor = useActors();
  const repo = useRepoName(wo.project, wo.repo);
  const tot = wo.history.reduce((t, e) => ({ tokens: t.tokens + e.tokens, cost: t.cost + e.cost }), { tokens: 0, cost: 0 });
  const cls = classOf(cat, project, wo.cls);
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const next = session?.next.text ?? (wo.allowed.approve ? `A person at ${wo.allowed.approve.gate}` : st ? `${actor(st.agent).name.replace(" (agent)", "")}` : "");
  const crit = rec.criteria ?? [];
  const slaTotal = wo.slaDue ? wo.slaDue - wo.createdAt : 0;
  const elapsed = Date.now() - wo.createdAt;
  const pr = rec.code.pullRequests[0];
  return (
    <div className="grid g-main dz-overview" id="dz-overview">
      <div className="stack">
        <Card title="Brief" hint={wo.brief.goal || undefined} acts={<Btn label="Edit" small icon="tag" id="dz-edit" guard={no("The server cannot edit a work order's title or description yet.")} onClick={() => undefined} />}>
          <p style={{ marginBottom: 12 }}>{wo.description || wo.title}</p>
          <div className="label" style={{ marginBottom: 8 }}>Acceptance criteria</div>
          {crit.length ? (
            <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
              {crit.map((c) => {
                const s = critStatus(c);
                return (
                  <div className="li" key={c.id}>
                    <span className="mono dim">{c.id}</span>
                    <div className="main1">
                      <span className="t1" style={{ whiteSpace: "normal" }}>{c.text}</span>
                      {c.tests.length ? <span className="t2">{`test: ${c.tests.map((t) => t.name).join(", ")}`}</span> : null}
                    </div>
                    <span className={`chip ${CRIT_TONE[s.id] ?? "idle"}`}>{s.id === "met" ? "Pass" : s.label}</span>
                  </div>
                );
              })}
            </div>
          ) : <p className="muted small">No acceptance criteria yet.</p>}
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
            <dt>Attempts</dt><dd>{rec.attempts.length || wo.history.length}</dd>
            <dt>Tokens</dt><dd>{fmt.k(tot.tokens)}</dd>
            <dt>Cost</dt><dd>{fmt.money(tot.cost)}</dd>
            <dt>Pull request</dt><dd>{pr ? <a className="m" href={`#/p/${wo.project}/changes/${wo.id}`}>{`#${pr.number}`}</a> : "not yet"}</dd>
          </dl>
        </Card>
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
