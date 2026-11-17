/** The eleven sections of the record (legacy record.js), from the traveler read, the record read and the changes read. */
import { useState, type ReactNode } from "react";
import { fmt, flowOf, woTotals, type Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { ClassChip, classOf } from "../projects/kit";
import { StateChip } from "../../ui/primitives";
import { bayLabel, clsName, plural, stName, type TWo } from "../traveler/model";
import { Fold, Kv, None, Prov, useIsAgent, useName, when } from "./bits";
import { briefDiff, endAt, qaPairs, routeTaken, srcName, stateLine, visitsOf, type RecordData } from "./data";
import type { Catalog } from "@gantry/domain";

export interface Ctx {
  wo: TWo;
  rec: RecordData;
  project: Project;
  cat: Catalog;
  pre: string;
  compact: boolean;
  /** The work order page: sections sit in one document card and fold. */
  doc?: boolean;
  /** The changes page: counts, plan and files as separate panels. */
  page?: boolean;
}


/* ------------------------------------------------------------------ summary */
export function Summary({ c }: { c: Ctx }) {
  const { wo, rec, project, cat, pre, compact } = c;
  const name = useName();
  const ui = useUI();
  const dec = useCan("wo.answer", { project: wo.project, repo: wo.repo });
  const written = rec.summary.written;
  const text = written?.text ?? rec.summary.generated;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = woTotals(wo);
  const route = routeTaken(wo);
  const planned = wo.route;
  const skipped = flowOf(cat, project).stations.filter((s) => !planned.includes(s.id)).map((s) => s.name);
  const people = peopleOf(wo);
  const agents = agentsOf(wo);
  const save = async () => {
    if (busy || draft == null) return;
    setBusy(true);
    const r = await ops.setRecordSummary(wo.id, draft, { ifMatch: wo.version });
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) setDraft(null);
  };
  return (
    <div className="rec-summary">
      <div className="rec-sum-text">
        <p className="rec-lede" id={`${pre}summary-text`}>
          {text}
        </p>
        <div className="rec-sum-meta">
          {written ? <Prov kind="person" text={`Summary saved by ${name(written.by)}, ${when(written.at)}`} /> : <Prov kind="system" text="Written by Gantry from the record" />}
          {compact ? null : <Btn label="Edit summary" small icon="sparkle" id={`${pre}rewrite`} guard={dec} disabledReason={dec.allowed && draft != null ? "You are editing it" : null} onClick={() => setDraft(text)} />}
        </div>
        {compact || draft == null ? null : (
          <div className="rec-rw" role="group" aria-label="Edit summary">
            <div className="rec-rw-head">
              <strong>New summary</strong>
              <span className="small muted">A written summary replaces the generated one on this record. It is audited with your name.</span>
            </div>
            <textarea id="rec-rw-text" className="input rec-rw-text" rows={4} aria-label="Summary" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="rec-rw-act">
              <Btn label="Discard" small kind="ghost" id="rec-rw-discard" onClick={() => setDraft(null)} />
              <Btn label="Save summary" small kind="primary" icon="check" id="rec-rw-save" guard={dec} disabledReason={dec.allowed && !draft.trim() ? "Write a summary first" : dec.allowed && draft.trim() === text.trim() ? "Nothing changed" : null} onClick={() => void save()} />
            </div>
          </div>
        )}
      </div>
      <dl className="rec-facts">
        <Kv k="Class">
          <ClassChip cls={classOf(cat, project, wo.cls)} small />
        </Kv>
        <Kv k="State">
          <span>
            <StateChip state={wo.state} compact /> {stateLine(wo, cat)}
          </span>
        </Kv>
        <Kv k="Route taken">
          <span className="small">
            {route.map((s) => stName(cat, s)).join(" → ") || "Not started"}
            {skipped.length ? <span className="muted">{` · skips ${skipped.join(", ")}`}</span> : null}
          </span>
        </Kv>
        <Kv k="Duration">
          <span className="mono">{fmt.dur(endAt(wo) - wo.createdAt)}</span>
        </Kv>
        <Kv k="Cost">
          <span className="mono">{`${fmt.money(t.cost)} · ${fmt.k(t.tokens)} tok`}</span>
        </Kv>
        <Kv k="People">
          <span className="small">{people.map(name).join(", ") || "–"}</span>
        </Kv>
        <Kv k="Agents">
          <span className="small">{agents.map(name).join(", ") || "–"}</span>
        </Kv>
        <Kv k="PR">{wo.pr && wo.pr.number ? <span className="mono">{`#${wo.pr.number} · ${wo.pr.state}`}</span> : "none yet"}</Kv>
        <Kv k="Release">{wo.pr && wo.pr.tag && wo.pr.releasedAt ? <span className="mono">{`${wo.pr.tag} · ${fmt.istDate(wo.pr.releasedAt)}`}</span> : "not released"}</Kv>
      </dl>
    </div>
  );
}

export function peopleOf(wo: TWo): string[] {
  const ids: Array<string | undefined> = [wo.requestedBy];
  for (const g of Object.values(wo.gates || {})) {
    g.approvals.forEach((a) => ids.push(a.by));
    g.rejections.forEach((a) => ids.push(a.by));
  }
  wo.conv?.messages.forEach((m) => ids.push(m.from));
  (wo.sendbacks || []).forEach((s) => ids.push(s.by));
  (wo.briefVersions || []).forEach((b) => ids.push(b.by));
  if (wo.clsOverridden) ids.push(wo.clsOverridden.by);
  const isAgentish = (x: string) => x.startsWith("ag-") || x === "system";
  return ids.filter((x, i, a): x is string => !!x && a.indexOf(x) === i && !isAgentish(x));
}
export function agentsOf(wo: TWo): string[] {
  const ids = (wo.history || []).map((e) => e.agent);
  return ids.filter((x, i, a) => !!x && a.indexOf(x) === i && x.startsWith("ag-"));
}

/* ------------------------------------------------------------------ request */
export function Request({ c }: { c: Ctx }) {
  const { wo, rec, cat } = c;
  const name = useName();
  const rq = rec.request;
  const requested = rec.classification.requested;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">Original submission, verbatim</span>
        <Prov kind="system" text="Recorded at submission" />
      </div>
      <blockquote className="rec-quote">
        <div className="rec-quote-t">{wo.title}</div>
        <p>{rq.text || "(no description)"}</p>
      </blockquote>
      <dl className="rec-kvs">
        <Kv k="Source">{srcName(wo.source)}</Kv>
        <Kv k="Requested by">{name(rq.by)}</Kv>
        {rq.via && rq.via !== wo.source && rq.via !== "web" ? <Kv k="Submitted via">{srcName(rq.via)}</Kv> : null}
        <Kv k="When">{when(rq.at)}</Kv>
        <Kv k="Attachments">{rq.attachments.length ? <span className="mono small">{rq.attachments.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(", ")}</span> : "none"}</Kv>
        <Kv k="Requested class">{requested ? <ClassChip cls={classOf(cat, c.project, requested)} small /> : "none (left to the classifier)"}</Kv>
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ clarification */
export function Clarification({ c }: { c: Ctx }) {
  const { wo, rec, cat, project, pre, compact } = c;
  const name = useName();
  const isAgent = useIsAgent();
  const conv = wo.conv;
  const open = useOpenConversation();
  if (!conv) return <None text="No intake conversation was recorded." />;
  const pairs = qaPairs(rec.clarification, isAgent);
  const cls = conv.messages.find((m) => m.from === "ag-classifier");
  const ovr = wo.clsOverridden;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${plural(pairs.length, "question")} from the Intake agent, ${pairs.filter((x) => x.a).length} answered`}</span>
        <Prov kind="system" text="Conversation log" />
      </div>
      {cls ? (
        <p className="small rec-cls-line">
          <Icon name="agent" /> {cls.text}
        </p>
      ) : null}
      {pairs.length ? (
        <ol className="rec-qa">
          {pairs.map((x) => (
            <li key={x.q.at + x.q.text}>
              <div className="rec-q">
                <span className="rec-qa-tag mono">Q</span>
                <span>{x.q.text}</span>
                <span className="muted small mono">{`${name(x.q.from)} · ${fmt.ist(x.q.at)}`}</span>
              </div>
              <div className={`rec-a${x.a ? "" : " is-open"}`}>
                <span className="rec-qa-tag mono">A</span>
                {x.a ? <span>{x.a.text}</span> : <span className="muted">Not answered yet</span>}
                {x.a ? <span className="muted small mono">{`${name(x.a.from)} · ${when(x.a.at)}`}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <None text="No questions asked yet." />
      )}
      {conv.raised.length ? (
        <div>
          <h4 className="rec-h4">Questions raised by later stations</h4>
          <ul className="rec-list">
            {conv.raised.map((r, i) => (
              <li key={i}>
                <strong>{`${stName(cat, r.station)}: `}</strong>
                {r.text}
                <span className="muted small">{` · ${when(r.at)} · `}</span>
                {r.answered ? <span>{`answered: ${r.answer}`}</span> : <span className="chip chip-warn">open</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h4 className="rec-h4">Misses found</h4>
      {conv.misses.length ? (
        <ul className="rec-list rec-misses">
          {conv.misses.map((m) => (
            <li key={m.id} className={m.resolved ? "is-ok" : "is-open"}>
              <Icon name={m.resolved ? "check" : "alert"} />
              <span>{m.text}</span>
              <span className="muted small">{m.resolved ? " answered" : " open"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <None text="None found." />
      )}
      <h4 className="rec-h4">Overrides</h4>
      {ovr ? (
        <p className="small">
          <Icon name="swap" /> Class changed from <ClassChip cls={classOf(cat, project, ovr.from)} small /> to <ClassChip cls={classOf(cat, project, wo.cls)} small />
          {` by ${name(ovr.by)}, ${when(ovr.at)}. Reason: ${ovr.reason || "none given"}.`}
        </p>
      ) : wo.requestedCls && wo.requestedCls !== wo.clsSuggested ? (
        <p className="small">{`Submitter asked for ${clsName(cat, wo.requestedCls)}; the classifier suggested ${clsName(cat, wo.clsSuggested)} at ${Math.round(wo.clsConfidence * 100)}%.`}</p>
      ) : (
        <None text="No overrides." />
      )}
      {compact ? null : (
        <p className="small">
          <Btn label="Open the conversation" small kind="ghost" icon="chat" id={`${pre}open-conv`} onClick={() => open(wo.id, wo.project)} />
        </p>
      )}
    </div>
  );
}

/** Opens a work order's conversation on the Conversations screen (legacy G.openConversation). */
export function useOpenConversation(): (woId: string, project: string) => void {
  return (woId, project) => {
    updatePrefs({ openConversation: woId, project });
    navigate("conversations");
  };
}

/* ------------------------------------------------------------------ agreement */
export function Agreement({ c }: { c: Ctx }) {
  const { wo, rec } = c;
  const name = useName();
  const bv = rec.briefVersions;
  const b = bv.length ? bv[bv.length - 1]!.brief : rec.brief ?? wo.brief;
  if (!b) return <None text="No brief yet." />;
  const ul = (items: string[] | undefined, empty: string): ReactNode =>
    items && items.length ? (
      <ul className="rec-list">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    ) : (
      <p className="muted small">{empty}</p>
    );
  return (
    <div>
      <div className="rec-subhead">
        {bv.length ? (
          <span className="small">
            <Icon name="check" />
            {` Confirmed by ${name(bv[0]!.by)}, ${when(bv[0]!.at)} · version ${bv[bv.length - 1]!.v} in force`}
          </span>
        ) : (
          <span className="chip chip-warn">Draft, not yet confirmed at G0+G1</span>
        )}
        <Prov kind="person" text="Agreed by a person" />
      </div>
      <div className="rec-brief">
        <div className="rec-brief-goal">
          <div className="kicker">Goal</div>
          <p>{b.goal}</p>
        </div>
        <div>
          <div className="kicker">Scope in</div>
          {ul(b.scopeIn, "Not set")}
        </div>
        <div>
          <div className="kicker">Scope out</div>
          {ul(b.scopeOut, "Nothing excluded")}
        </div>
        <div>
          <div className="kicker">Acceptance criteria</div>
          {rec.criteria.length ? (
            <ul className="rec-list">
              {rec.criteria.map((x) => (
                <li key={x.id}>
                  <span className="mono rec-ac">{x.id}</span>
                  {` ${x.text}`}
                </li>
              ))}
            </ul>
          ) : (
            ul(b.ac, "Not set")
          )}
        </div>
        <div>
          <div className="kicker">Decisions</div>
          {ul(b.decisions, "None")}
        </div>
        <div>
          <div className="kicker">Risks</div>
          {ul(b.risks, "None recorded")}
        </div>
      </div>
      {bv.length > 1 ? (
        <div>
          <h4 className="rec-h4">Changes after confirmation</h4>
          {bv.slice(1).map((v, i) => {
            const d = briefDiff(bv[i]!.brief, v.brief);
            return (
              <div className="rec-bdiff" key={v.v}>
                <div className="small">
                  <strong>{`v${v.v}`}</strong>
                  {` by ${name(v.by)}, ${when(v.at)}${v.note ? `: ${v.note}` : ""}`}
                </div>
                <pre className="rec-diff">
                  {d.length
                    ? d.map((x, k) => (
                        <span key={k} className={`rec-dl rec-dl-${x.t === "+" ? "add" : "del"}`}>{`${x.t} ${x.field}: ${x.text}\n`}</span>
                      ))
                    : "No field changed."}
                </pre>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ stations */
export function Stations({ c }: { c: Ctx }) {
  const { wo, rec, cat, project } = c;
  const name = useName();
  const vs = visitsOf(wo, rec);
  if (!vs.length) return <None text="No station visits yet." />;
  const raised = wo.conv?.raised ?? [];
  const sbs = wo.sendbacks ?? [];
  const sbVisit = sbs.map((s) => {
    let best = -1;
    vs.forEach((e, i) => {
      if (e.station === s.from && (best < 0 || e.startedAt <= s.at)) best = i;
    });
    return best < 0 ? vs.length - 1 : best;
  });
  const agents = (id: string) => (id ? name(id) : "");
  void project;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${plural(vs.length, "station visit")} · ${plural(sbs.length, "send-back")}`}</span>
        <Prov kind="agent" text="Summaries reported by the agents" />
      </div>
      <ol className="rec-visits">
        {vs.map((e, i) => {
          const q = raised.filter((r) => r.station === e.station && r.at >= e.startedAt && (!e.endedAt || r.at <= e.endedAt + 60000));
          const sb = sbs.filter((_, k) => sbVisit[k] === i);
          const st = cat.stations.find((s) => s.id === e.station);
          const attempt = rec.attempts.filter((a) => a.station === e.station)[vs.slice(0, i).filter((x) => x.station === e.station).length];
          return (
            <li key={`${e.station}-${e.startedAt}`} className={`rec-visit${e.endedAt ? "" : " is-now"}${st?.custom ? " is-custom" : ""}`} data-at={String(e.startedAt)}>
              <div className="rec-visit-no mono">{st?.no || ""}</div>
              <div className="rec-visit-body">
                <div className="rec-visit-head">
                  <strong>{stName(cat, e.station)}</strong>
                  {st?.custom ? <span className="chip">custom station</span> : null}
                  {e.endedAt ? <span className={`chip rec-out rec-out-${String(e.outcome || "done").replace(/\W+/g, "-")}`}>{e.outcome || "done"}</span> : <span className="chip chip-accent">in progress</span>}
                  <span className="muted small mono">{`${fmt.istDate(e.startedAt)} ${fmt.ist(e.startedAt)} · ${fmt.dur((e.endedAt || Date.now()) - e.startedAt)}`}</span>
                </div>
                {e.summary ? <p className="rec-visit-sum">{e.summary}</p> : <p className="muted small">{e.endedAt ? "No summary reported." : "Working now. The agent reports a summary when it finishes."}</p>}
                <div className="rec-visit-meta small">
                  <span>
                    <Icon name="agent" />
                    {` ${agents(e.agent)}${e.agentVersion ? ` v${e.agentVersion}` : ""}`}
                  </span>
                  <span className="mono">{e.model || ""}</span>
                  {e.skills && e.skills.length ? <span>{`skills ${e.skills.map((s) => `${s.name} ${s.v}`).join(", ")}`}</span> : null}
                  <span className="mono">{`${fmt.k(e.tokens || 0)} tok · ${fmt.money(e.cost || 0)}`}</span>
                  {attempt ? <span className="mono muted" title="The attempt that did this work">{`${attempt.id} · fencing ${attempt.fencing}`}</span> : null}
                </div>
                {q.length ? (
                  <ul className="rec-list small">
                    {q.map((r, k) => (
                      <li key={k}>
                        <Icon name="human" />
                        {` Asked: ${r.text}${r.answered ? ` → ${r.answer}` : " (open)"}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {sb.length ? (
                  <ul className="rec-list small rec-sb">
                    {sb.map((s, k) => (
                      <li key={k}>
                        <Icon name="undo" />
                        {` Sent back to ${stName(cat, s.to)} by ${name(s.by)}, ${when(s.at)}: ${s.note || "no note"}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {e.note && e.note !== "done" ? <div className="small">{`Note: ${e.note}`}</div> : null}
                {(e.artefacts ?? []).map((a, k) => (
                  <Fold key={k} k={`${c.pre}art-${wo.id}-${i}-${k}`} summary={<span className="small">{`Artefact: ${a.title}`}</span>}>
                    <pre className="rec-art">{a.body}</pre>
                  </Fold>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      {rec.bayStays.length ? (
        <div>
          <h4 className="rec-h4">Time in bays</h4>
          <ul className="rec-list small">
            {rec.bayStays.map((s, i) => (
              <li key={i}>
                <Icon name="st-park" />
                {` ${bayLabel(cat, s.bay)}, ${s.from ? fmt.stamp(Date.parse(s.from)) : ""}${s.to ? ` to ${fmt.stamp(Date.parse(s.to))}` : " until now"}${s.by ? ` · by ${name(s.by)}` : ""}${s.reason ? `: ${s.reason}` : ""}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
